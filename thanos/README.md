# Thanos — Long-Term Metrics Storage for EKS

Thanos extends our existing Prometheus setup with long-term metrics storage in S3, high availability, and a unified query layer. Deployed on EKS (`projectx_cluster_ubuntu25b`) alongside the existing monitoring stack.

## Architecture

```
  EKS Cluster (monitoring namespace)
  ==================================

  ┌─────────────────────────────────────┐
  │ Prometheus StatefulSet (2 containers)│
  │                                     │
  │  ┌─────────────┐  ┌──────────────┐ │
  │  │  Prometheus  │  │Thanos Sidecar│ │
  │  │  (scrapes    │  │(reads TSDB   │ │
  │  │   metrics)   │  │ blocks,      │ │
  │  │              │◀─│ uploads to   │─┼──────▶  S3 Bucket
  │  │  Port 9090   │  │ S3)          │ │        (projectx-thanos-metrics)
  │  └─────────────┘  │  Port 10901  │ │              │
  │                    └──────┬───────┘ │              │
  └───────────────────────────┼─────────┘              │
                              │ gRPC                   │
                              ▼                        ▼
                    ┌──────────────────┐    ┌─────────────────┐
                    │   Thanos Query   │◀───│  Store Gateway   │
                    │ (merges live +   │    │ (serves old S3   │
                    │  historical)     │    │  blocks via gRPC)│
                    │  Port 9090       │    │  Port 10901      │
                    └────────┬─────────┘    └─────────────────┘
                             │
                             │ queried by
                             ▼
                    ┌──────────────────┐    ┌─────────────────┐
                    │     Grafana      │    │    Compactor     │
                    │  Port 3000       │    │ (background S3   │
                    └──────────────────┘    │  cleanup/compress)│
                                           └─────────────────┘
```

### Data Flow

1. **Prometheus** scrapes metrics from the cluster (pods, nodes, services)
2. **Thanos Sidecar** watches the Prometheus TSDB directory, uploads completed 2-hour blocks to S3
3. **Store Gateway** reads historical blocks from S3 and serves them via gRPC
4. **Thanos Query** merges live data (from Sidecar) + historical data (from Store Gateway) into a single PromQL endpoint
5. **Grafana** queries Thanos Query on port 9090 — seamlessly gets both recent and old metrics
6. **Compactor** runs in the background, compressing and downsampling old S3 data to save storage costs

### Why Each Component Exists

| Component | What it does | Needs Service? |
|-----------|-------------|----------------|
| **Sidecar** | Ships Prometheus TSDB blocks to S3 | Yes (headless, gRPC for Querier) |
| **Store Gateway** | Serves old S3 data to the Querier | Yes (headless, gRPC) |
| **Query** | Single query endpoint — Grafana talks to this | Yes (ClusterIP, port 9090) |
| **Compactor** | Background worker — compresses old S3 data | No (nobody talks to it) |

## Components

| Component | Image | Version | Type |
|-----------|-------|---------|------|
| Thanos Sidecar | `quay.io/thanos/thanos` | v0.36.1 | Container in Prometheus StatefulSet |
| Thanos Query | `quay.io/thanos/thanos` | v0.36.1 | Deployment (1 replica) |
| Thanos Store Gateway | `quay.io/thanos/thanos` | v0.36.1 | StatefulSet (1 replica, 5Gi gp2) |
| Thanos Compactor | `quay.io/thanos/thanos` | v0.36.1 | Deployment (1 replica) |

### Retention Policy (Compactor)

| Resolution | Retention | Purpose |
|------------|-----------|---------|
| Raw | 30 days | Full-resolution metrics |
| 5 minutes | 60 days | Medium-term trending |
| 1 hour | 180 days | Long-term capacity planning |

## File Structure

```
platform-tools/
├── thanos/
│   ├── README.md
│   ├── base/
│   │   ├── kustomization.yaml                  # Lists all base resources
│   │   ├── query-deployment.yaml               # Thanos Query — unified PromQL endpoint
│   │   ├── query-service.yaml                  # ClusterIP service for Grafana
│   │   ├── storegateway-statefulset.yaml       # Reads historical data from S3
│   │   ├── storegateway-service.yaml           # Headless service for gRPC
│   │   ├── compactor-deployment.yaml           # Background S3 data compaction
│   │   └── thanos-objstore-sealed-secret.yaml  # Encrypted S3 bucket config
│   └── overlays/
│       └── dev/
│           └── kustomization.yaml              # Imports base
│
├── eks-monitoring/prometheus/templates/
│   ├── statefulset.yaml                        # Modified — added Thanos sidecar container
│   ├── configmap.yaml                          # Modified — added external_labels
│   └── thanos-sidecar-service.yaml             # New — headless service for sidecar gRPC
│
└── eks-monitoring/grafana/
    └── dev-values.yaml                         # Modified — datasource → thanos-query:9090
```

## AWS Infrastructure

### S3 Bucket

| Setting | Value |
|---------|-------|
| Bucket Name | `projectx-thanos-metrics` |
| Region | us-east-1 |
| Versioning | Enabled |
| Purpose | Long-term TSDB block storage |

### IRSA (IAM Roles for Service Accounts)

| Setting | Value |
|---------|-------|
| IAM Role | `projectx-thanos-irsa-role` |
| IAM Policy | `ThanosS3Policy` |
| Kubernetes SA | `thanos-sa` (monitoring namespace) |
| Also annotated | `prometheus-server` SA (for the sidecar) |

**S3 permissions (least privilege):**
- `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`
- `s3:ListBucket`
- `s3:GetObjectTagging`, `s3:PutObjectTagging`

The IRSA trust policy allows any ServiceAccount in the `monitoring` namespace to assume the role (`system:serviceaccount:monitoring:*`).

### Secrets Management

```
objstore.yml (S3 bucket config — bucket name, region, endpoint)
        │
        │ sealed with kubeseal
        ▼
thanos-objstore-sealed-secret.yaml (safe in Git)
        │
        │ decrypted by sealed-secrets controller
        ▼
thanos-objstore-secret (monitoring namespace)
        │
        │ mounted as volume
        ▼
/etc/thanos/objstore.yml on Sidecar, Store Gateway, Compactor pods
```

## Deployment Guide

### Prerequisites

- EKS cluster with Prometheus deployed (custom Helm chart in `eks-monitoring/prometheus/`)
- Sealed-secrets controller running
- Flux CD managing the `platform-tools/` repo
- `kubectl`, `aws`, `kubeseal`, `helm`, `flux` CLI tools

### Phase 1: AWS Infrastructure

**Step 1 — Create S3 bucket:**

```bash
aws s3api create-bucket \
  --bucket projectx-thanos-metrics \
  --region us-east-1

aws s3api put-bucket-versioning \
  --bucket projectx-thanos-metrics \
  --versioning-configuration Status=Enabled
```

**Step 2 — Create IAM policy:**

```bash
aws iam create-policy \
  --policy-name ThanosS3Policy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
        "s3:ListBucket", "s3:GetObjectTagging", "s3:PutObjectTagging"
      ],
      "Resource": [
        "arn:aws:s3:::projectx-thanos-metrics",
        "arn:aws:s3:::projectx-thanos-metrics/*"
      ]
    }]
  }'
```

**Step 3 — Create IRSA role:**

Get the OIDC provider ID:

```bash
aws eks describe-cluster --name projectx_cluster_ubuntu25b \
  --query "cluster.identity.oidc.issuer" --output text
```

Create the trust policy (replace `OIDC_ID` with your value):

```bash
cat > /tmp/thanos-trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::665832051028:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/${OIDC_ID}"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "oidc.eks.us-east-1.amazonaws.com/id/${OIDC_ID}:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "oidc.eks.us-east-1.amazonaws.com/id/${OIDC_ID}:sub": "system:serviceaccount:monitoring:*"
      }
    }
  }]
}
EOF

aws iam create-role \
  --role-name projectx-thanos-irsa-role \
  --assume-role-policy-document file:///tmp/thanos-trust-policy.json

aws iam attach-role-policy \
  --role-name projectx-thanos-irsa-role \
  --policy-arn arn:aws:iam::665832051028:policy/ThanosS3Policy
```

> **Note:** We initially tried `eksctl create iamserviceaccount` but it failed because the cluster name contains underscores, which breaks CloudFormation stack naming. Manual role creation works around this.

**Step 4 — Create Kubernetes ServiceAccounts:**

```bash
# Thanos components SA
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: thanos-sa
  namespace: monitoring
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::665832051028:role/projectx-thanos-irsa-role
EOF

# Also annotate the existing Prometheus SA (for the sidecar)
kubectl annotate sa prometheus-server -n monitoring \
  eks.amazonaws.com/role-arn=arn:aws:iam::665832051028:role/projectx-thanos-irsa-role
```

### Phase 2: Object Store Secret

**Step 5 — Create and seal the S3 config:**

```bash
# Create objstore config (temporary — do NOT commit)
cat > /tmp/objstore.yml <<'EOF'
type: S3
config:
  bucket: projectx-thanos-metrics
  region: us-east-1
  endpoint: s3.amazonaws.com
EOF

# Create K8s secret (dry-run)
kubectl create secret generic thanos-objstore-secret \
  --namespace=monitoring \
  --from-file=objstore.yml=/tmp/objstore.yml \
  --dry-run=client -o yaml > /tmp/thanos-objstore-secret.yaml

# Seal it
kubeseal --controller-name=sealed-secrets \
         --controller-namespace=sealed-secrets \
         --fetch-cert > /tmp/cert.pem

kubeseal --cert=/tmp/cert.pem \
         --format yaml < /tmp/thanos-objstore-secret.yaml > thanos/base/thanos-objstore-sealed-secret.yaml

# Cleanup plaintext
rm /tmp/objstore.yml /tmp/thanos-objstore-secret.yaml /tmp/cert.pem

# Apply to cluster
kubectl apply -f thanos/base/thanos-objstore-sealed-secret.yaml
```

### Phase 3: Modify Prometheus

**Step 6 — Add Thanos args and sidecar to the Prometheus StatefulSet:**

In `eks-monitoring/prometheus/templates/statefulset.yaml`:

1. Add TSDB block duration args to the Prometheus container:
```yaml
args:
  - "--storage.tsdb.min-block-duration=2h"
  - "--storage.tsdb.max-block-duration=2h"
```

2. Add the Thanos sidecar as a second container sharing the `storage` volume
3. Add the `thanos-objstore` secret volume

**Step 7 — Add external labels to Prometheus config:**

In `eks-monitoring/prometheus/templates/configmap.yaml`, under `global:`:
```yaml
global:
  external_labels:
    cluster: projectx-dev
    replica: prometheus-0
```

> **Critical:** Without external labels, the sidecar crashes with `"no external labels configured"`. These labels uniquely identify which Prometheus instance the data came from — essential for multi-cluster setups.

**Step 8 — Create sidecar headless service:**

Create `eks-monitoring/prometheus/templates/thanos-sidecar-service.yaml` — a headless Service on port 10901 so the Querier can reach the sidecar via gRPC.

**Step 9 — Deploy Prometheus changes:**

```bash
helm upgrade prometheus ./eks-monitoring/prometheus \
  -f eks-monitoring/prometheus/dev-values.yaml \
  -n monitoring

# Verify 2/2 containers running
kubectl get pods -n monitoring -l app=prometheus-server

# Verify sidecar is uploading blocks
kubectl logs -n monitoring -l app=prometheus-server -c thanos-sidecar --tail=10

# Verify blocks in S3
aws s3 ls s3://projectx-thanos-metrics/ --recursive | head -10
```

### Phase 4: Deploy Thanos Components via FluxCD

**Step 10 — Push manifests and reconcile:**

The Thanos Query, Store Gateway, and Compactor are deployed as raw Kubernetes manifests managed by FluxCD via Kustomize (not a Helm chart).

```bash
# Add to root kustomization.yaml
#   - thanos/overlays/dev

git add -A && git commit -m "deploy thanos components" && git push
flux reconcile source git flux-system
flux reconcile kustomization flux-system

# Verify all pods
kubectl get pods -n monitoring | grep thanos
```

### Phase 5: Update Grafana

**Step 11 — Point Grafana to Thanos Query:**

In `eks-monitoring/grafana/dev-values.yaml`:
```yaml
# Before
datasourceUrl: "http://prometheus-server.monitoring:9090"

# After
datasourceUrl: "http://thanos-query.monitoring:9090"
```

```bash
helm upgrade grafana ./eks-monitoring/grafana \
  -f eks-monitoring/grafana/dev-values.yaml \
  -n monitoring

kubectl rollout restart deployment grafana-deployment -n monitoring
```

## Issues Resolved During Deployment

| # | Issue | Root Cause | Fix |
|---|-------|-----------|-----|
| 1 | `eksctl create iamserviceaccount` failed | Cluster name `projectx_cluster_ubuntu25b` has underscores — CloudFormation stack names don't allow underscores | Created IAM role and SA manually with `aws iam create-role` + `kubectl apply` |
| 2 | Sidecar crash: `"no external labels configured"` | Thanos requires at least one external label to uniquely identify data in S3 | Added `external_labels: {cluster: projectx-dev, replica: prometheus-0}` to `prometheus.yml` global config |
| 3 | Sidecar `external_labels={}` after ConfigMap update | StatefulSet pods don't restart when a ConfigMap changes | Deleted the pod manually: `kubectl delete pod prometheus-server-0 -n monitoring` |
| 4 | Sidecar `Access Denied` writing to S3 | Prometheus pod uses `prometheus-server` SA which had no IRSA annotation | Annotated `prometheus-server` SA with the IRSA role ARN and updated trust policy to allow `monitoring:*` |
| 5 | Bitnami Helm chart: `unsupported protocol scheme "oci"` | Bitnami moved charts to OCI registry, old HTTPS URL no longer works | Switched HelmRepository to `type: oci` with `oci://registry-1.docker.io/bitnamicharts` |
| 6 | Bitnami chart: `image not found` | Chart version 17.3.1 references `bitnami/thanos:0.39.2-debian-12-r2` which doesn't exist on Docker Hub | Switched to official image `quay.io/thanos/thanos:v0.36.1` |
| 7 | Bitnami chart: NOTES.txt template error | Bitnami chart templates expect Bitnami-specific image format, incompatible with official Thanos image | Abandoned Bitnami Helm chart entirely — replaced with raw Kubernetes manifests |
| 8 | Store Gateway: `mkdir /data/meta-syncer: permission denied` | Thanos runs as non-root but PVC volume had root ownership | Added `securityContext: {fsGroup: 1001, runAsUser: 1001}` to the pod spec |
| 9 | Store Gateway PVC stuck in Pending | Stale PVC from failed Bitnami install had no StorageClass set | Deleted the old PVC, let the StatefulSet recreate it with `storageClassName: gp2` |
| 10 | Query pod CrashLoopBackOff | Liveness probe hitting port 9090 but Thanos Query defaults HTTP to port 10902 | Added `--http-address=0.0.0.0:9090` arg to serve HTTP on port 9090 |
| 11 | Grafana showing stale data after datasource change | Grafana pod didn't restart after ConfigMap update | `kubectl rollout restart deployment grafana-deployment -n monitoring` |

## Verification Commands

```bash
# All pods in monitoring namespace
kubectl get pods -n monitoring

# Sidecar uploading to S3
kubectl logs -n monitoring -l app=prometheus-server -c thanos-sidecar --tail=10

# Store Gateway connected to S3
kubectl logs thanos-storegateway-0 -n monitoring --tail=10

# Query connected to both stores
kubectl logs -l app=thanos-query -n monitoring --tail=10

# Test a PromQL query through Thanos
kubectl exec -n monitoring deployment/thanos-query -- \
  wget -qO- "http://localhost:9090/api/v1/query?query=up" | head -c 200

# Check S3 blocks
aws s3 ls s3://projectx-thanos-metrics/ --recursive | wc -l

# Compactor status
kubectl logs -l app=thanos-compactor -n monitoring --tail=10
```

## Key Lessons Learned

- **Thanos does NOT need EKS permissions** — only S3. It reads metrics from S3, not from clusters directly.
- **External labels are mandatory** — without them, the sidecar refuses to start. They uniquely identify data in S3.
- **The sidecar needs fixed 2-hour TSDB blocks** (`min-block-duration=2h`, `max-block-duration=2h`) — it can only upload completed, immutable blocks.
- **Bitnami Helm charts can be problematic** — OCI migration, image availability issues, and opinionated templates. Raw manifests give full control.
- **IRSA trust policies need the right ServiceAccount** — the sidecar runs inside the Prometheus pod, so the `prometheus-server` SA needs the annotation, not just `thanos-sa`.
- **fsGroup in securityContext** is required for PVC write access when running as non-root.
- **ConfigMap changes don't trigger pod restarts** — you must manually delete pods or use a rollout restart.
- **Kubernetes Secrets are namespaced** — all Thanos components and secrets must be in the same namespace (`monitoring`).
