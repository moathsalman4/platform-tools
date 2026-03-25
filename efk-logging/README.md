# EFK Logging Stack

Centralized logging for the EKS cluster using **Elasticsearch**, **Fluent Bit**, and **Kibana**, managed via Flux GitOps.

## Architecture

```
  EKS Nodes                         logging namespace
  =========                         =================

  ┌─────────────────┐
  │ Application Pods │
  │ (all namespaces) │
  │   stdout/stderr  │
  └────────┬────────┘
           │ writes to
           ▼
  /var/log/containers/*.log
           │
           │ tailed by
           ▼
  ┌─────────────────┐         ┌──────────────────────┐
  │   Fluent Bit     │────────▶│    Elasticsearch      │
  │   (DaemonSet)    │  HTTPS  │    (StatefulSet)      │
  │   one per node   │  :9200  │    1 node, 20Gi gp2   │
  └─────────────────┘         └──────────┬───────────┘
                                         │
                                         │ queried by
                                         ▼
                              ┌──────────────────────┐
                              │       Kibana          │
                              │    (Deployment)       │
                              │       :5601           │
                              └──────────────────────┘
```

## Components

| Component | Chart | Version | Purpose |
|-----------|-------|---------|---------|
| ECK Operator | `eck-operator` | 3.1.0 | Installs CRDs and controller to manage Elasticsearch/Kibana as custom resources |
| ECK Stack | `eck-stack` | 0.18.1 | Deploys Elasticsearch 9.1.4 + Kibana 9.1.4 via ECK CRDs |
| Fluent Bit | `fluent-bit` | 0.56.0 (v4.2.3) | DaemonSet that tails container logs and ships to ES |

### Dependency Chain

```
ECK Operator  ──▶  ECK Stack (Elasticsearch + Kibana)  ──▶  Fluent Bit
   (CRDs)              (dependsOn: eck-operator)            (dependsOn: eck-stack)
```

## File Structure

```
efk-logging/
├── README.md
├── base/
│   ├── kustomization.yaml              # Lists all base resources
│   ├── namespace.yaml                  # Creates "logging" namespace
│   ├── helmrepository.yaml             # Elastic + Fluent Helm repos
│   ├── eck-operator-helmrelease.yaml   # ECK Operator (elastic-system)
│   ├── eck-stack-helmrelease.yaml      # Elasticsearch + Kibana
│   ├── fluent-bit-helmrelease.yaml     # Fluent Bit DaemonSet
│   └── basic-auth-sealed.yaml          # SealedSecret for ES credentials
└── overlays/
    └── dev/
        ├── kustomization.yaml          # Imports base + dev patch
        └── patch.yaml                  # Dev overrides
```

### What Each File Does

**`namespace.yaml`** -- Creates the `logging` namespace.

**`helmrepository.yaml`** -- Registers two Helm chart sources with Flux:
- `elastic` → `https://helm.elastic.co` (ECK Operator + ECK Stack)
- `fluent` → `https://fluent.github.io/helm-charts/` (Fluent Bit)

**`eck-operator-helmrelease.yaml`** -- Deploys the ECK Operator into `elastic-system`. This teaches Kubernetes how to manage Elasticsearch and Kibana via CRDs. Must be running before the ECK Stack can be deployed.

**`eck-stack-helmrelease.yaml`** -- Deploys Elasticsearch and Kibana:
- **Elasticsearch**: 1 node, 20Gi persistent storage on gp2, version 9.1.4
- **Kibana**: 1 replica, connected to Elasticsearch, version 9.1.4
- ECK auto-generates TLS certificates and the `elastic` user password

**`fluent-bit-helmrelease.yaml`** -- Deploys Fluent Bit as a DaemonSet:
- Tails all container logs from `/var/log/containers/*.log`
- Ships to Elasticsearch via HTTPS (port 9200)
- Authenticates with credentials from `efk-creds` SealedSecret
- `Buffer_Size 256k` to handle large ES responses
- `Retry_Limit 5` for resilient delivery

**`basic-auth-sealed.yaml`** -- SealedSecret containing the Elasticsearch `elastic` user credentials. Decrypted by the sealed-secrets controller into a regular Secret named `efk-creds` in the `logging` namespace.

## Secrets Management

Elasticsearch credentials are managed securely:

```
basic-auth-sealed.yaml (SealedSecret, safe in Git)
        │
        │ decrypted by sealed-secrets controller
        ▼
efk-creds Secret (logging namespace, cluster only)
        │
        │ referenced via secretKeyRef
        ▼
ES_PASSWORD env var on Fluent Bit pods
        │
        │ interpolated in config
        ▼
HTTP_Passwd ${ES_PASSWORD} in OUTPUT config
```

To rotate the password:
```bash
# 1. Get current cert
kubeseal --controller-name=sealed-secrets \
         --controller-namespace=sealed-secrets \
         --fetch-cert > /tmp/cert.pem

# 2. Create new secret
kubectl create secret generic efk-creds \
  --namespace=logging \
  --from-literal=user=elastic \
  --from-literal=password=NEW_PASSWORD_HERE \
  --dry-run=client -o yaml > /tmp/efk-creds.yaml

# 3. Seal it
kubeseal --cert=/tmp/cert.pem \
         --format yaml < /tmp/efk-creds.yaml > base/basic-auth-sealed.yaml

# 4. Cleanup and commit
rm /tmp/efk-creds.yaml /tmp/cert.pem
git add base/basic-auth-sealed.yaml && git commit && git push
```

## Issues Resolved

| Date | Issue | Fix | Commit |
|------|-------|-----|--------|
| 2026-03-24 | Hardcoded ES password in fluent-bit config (PT-01) | Moved to SealedSecret, injected via `${ES_PASSWORD}` env var | `52af385`, `ccbe93d` |
| 2026-03-24 | SealedSecret encrypted with wrong key | Re-sealed with current cluster certificate | `ccbe93d` |
| 2026-03-24 | Fluent Bit flush failures (buffer overflow) | Increased `Buffer_Size` from 32k to 256k, added `Retry_Limit 5` | `282e202` |
| 2026-03-24 | Debug logging feedback loop | Reverted `Log_Level` from debug to info (default) | `85cadf3` |

## Troubleshooting

```bash
# Check all pods in logging namespace
kubectl get pods -n logging

# Fluent Bit logs (look for flush errors)
kubectl -n logging logs -l app.kubernetes.io/name=fluent-bit --tail=30

# Elasticsearch health
kubectl -n logging run curl-test --rm -it --image=curlimages/curl -- \
  curl -sk -u elastic:PASSWORD https://elasticsearch-es-http:9200/_cluster/health?pretty

# Check if SealedSecret is synced
kubectl get sealedsecret efk-creds -n logging

# Check if the decrypted Secret exists
kubectl get secret efk-creds -n logging

# Kibana status
kubectl -n logging get pod -l common.k8s.elastic.co/type=kibana

# ECK Operator logs
kubectl -n elastic-system logs -l control-plane=elastic-operator --tail=30

# Force Flux reconcile
flux reconcile kustomization flux-system
```
