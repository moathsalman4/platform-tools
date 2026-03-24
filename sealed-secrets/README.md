# Sealed Secrets - Encrypted Secret Management for Kubernetes

## What is Sealed Secrets?

Sealed Secrets solves a fundamental GitOps problem: you want to store everything in Git (infrastructure, configs, secrets), but you cannot commit plaintext Kubernetes Secrets because anyone with repo access could read passwords, API keys, and credentials. Sealed Secrets provides a controller that runs in your cluster and a CLI tool (`kubeseal`) that encrypts secrets using the controller's public key. The encrypted "SealedSecret" is safe to commit to Git -- only the controller running in the cluster can decrypt it back into a regular Kubernetes Secret.

## Architecture - How It All Connects

```
                    Developer Workstation                          EKS Cluster (projectx)
                    =====================                          ======================

  1. Write plaintext secret                        ┌──────────────────────────────────────────┐
     (e.g. DB password)                            │          sealed-secrets namespace          │
          │                                        │                                            │
          ▼                                        │  ┌────────────────────────────────────┐    │
  2. kubeseal encrypts it ─── fetches pub key ───▶ │  │  Sealed Secrets Controller          │    │
     using controller's                            │  │  (Deployment, 2 replicas in base)   │    │
     public certificate                            │  │                                      │    │
          │                                        │  │  - Watches for SealedSecret CRs      │    │
          ▼                                        │  │  - Decrypts → creates K8s Secret     │    │
  3. Commit encrypted                              │  │  - Rotates sealing keys every 30d    │    │
     SealedSecret YAML                             │  └──────────┬───────────────────────────┘    │
     to Git repo                                   │             │                                 │
          │                                        │             │ decrypts into                   │
          ▼                                        │             ▼                                 │
  4. Flux detects the ──── reconciles ───────────▶ │  ┌──────────────────────────────────┐       │
     new commit                                    │  │  Regular Kubernetes Secret         │       │
                                                   │  │  (only exists in cluster memory,  │       │
                                                   │  │   never stored in Git)            │       │
                                                   │  └──────────┬───────────────────────┘       │
                                                   │             │                                 │
                                                   │             │ consumed by                     │
                                                   │             ▼                                 │
                                                   │  ┌──────────────────────────────────┐       │
                                                   │  │  Application Pods                  │       │
                                                   │  │  (thanos, grafana, etc.)           │       │
                                                   │  └──────────────────────────────────┘       │
                                                   └──────────────────────────────────────────────┘

  Metrics flow:
  Controller :8081 ◀──── Prometheus (monitoring namespace) scrapes metrics via ServiceMonitor
```

### Why Other Tools Depend on Sealed Secrets

Sealed Secrets is a foundational tool -- it must be deployed before anything that uses secrets:

| Tool | What secret it needs | SealedSecret resource |
|------|---------------------|-----------------------|
| **Thanos** | S3 object store config (`objstore.yml`) | `thanos-objstore-sealed-secret.yaml` |
| **Grafana** | Admin password | Managed via HelmRelease values (could be moved to SealedSecret) |

## File Structure

```
platform-tools/sealed-secrets/
├── base/                          # Shared configuration for all environments
│   ├── kustomization.yaml         # Lists all base resources to include
│   ├── namespace.yaml             # Creates the "sealed-secrets" namespace
│   ├── helmrepository.yaml        # Tells Flux where to find the Helm chart
│   ├── helmrelease.yaml           # The main Helm chart config with all values
│   ├── networkpolicy.yaml         # Restricts network traffic to/from controller
│   └── RBAC.yaml                  # Read-only ClusterRole for ops team
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml     # Imports base + applies dev patch
    │   └── patch.yaml             # Dev overrides (1 replica, fewer resources)
    └── prod/
        ├── kustomization.yaml     # Imports base + applies prod patch
        └── patch.yaml             # Prod overrides (keeps base HA settings)
```

### What Each File Does

**`base/namespace.yaml`** -- Creates the `sealed-secrets` namespace with Pod Security Standards set to `restricted` (enforces non-root, drops all capabilities, requires seccomp profiles). This is the most locked-down security level Kubernetes offers.

**`base/helmrepository.yaml`** -- Registers the Bitnami Sealed Secrets Helm chart repository (`https://bitnami-labs.github.io/sealed-secrets`) with Flux. Flux checks for new chart versions every 24 hours.

**`base/helmrelease.yaml`** -- The main configuration. This is the largest file and controls everything about the Sealed Secrets deployment:
- **Image**: Pulls from `docker.io/bitnami/sealed-secrets-controller`
- **Key rotation**: Rotates the sealing keypair every 30 days (`keyrenewperiod: 720h`), retains old keys for 1 year (`keyttl: 8760h`) so previously sealed secrets remain decryptable
- **Metrics**: Exposes Prometheus metrics on port 8081 with a ServiceMonitor for scraping
- **Resources**: Requests 50m CPU / 64Mi memory, limits 200m CPU / 128Mi memory
- **HA**: 2 replicas with PodDisruptionBudget (minAvailable: 1) and anti-affinity across nodes and AZs
- **Security**: Runs as non-root (UID 1001), read-only root filesystem, drops all Linux capabilities, seccomp enabled
- **Priority**: Uses `system-cluster-critical` priority class so it gets scheduled before application workloads
- **Logging**: JSON format for structured log aggregation

**`base/networkpolicy.yaml`** -- Default-deny policy with specific allowances:
- Ingress on port 8080 from `flux-system` namespace (webhook calls)
- Ingress on port 8081 from `monitoring` namespace (Prometheus scraping)
- Egress to DNS (port 53) and kube-apiserver (ports 443/6443)

**`base/RBAC.yaml`** -- Creates a `sealed-secrets-reader` ClusterRole that grants read-only access (`get`, `list`, `watch`) to SealedSecret custom resources. Bound to the `platform-ops` group. Importantly, this does NOT grant access to the decrypted Secrets -- only the controller can read those.

**`overlays/dev/patch.yaml`** -- Scales down for dev:
- 1 replica (no HA needed in dev)
- PodDisruptionBudget disabled
- Reduced resources (25m/32Mi requests, 100m/64Mi limits)
- ServiceMonitor disabled (no Prometheus in dev by default)
- NetworkPolicy disabled
- Debug logging enabled
- No priority class

**`overlays/prod/patch.yaml`** -- Currently references the same file structure as the Sealed Secrets prod overlay. The prod environment uses the base values which already include production-grade settings (2 replicas, HA, network policies, etc.).

## The Base/Overlay Pattern (Kustomize)

```
                    base/
                    (shared defaults)
                   /              \
                  /                \
    overlays/dev/              overlays/prod/
    (patch.yaml reduces        (patch.yaml may add
     resources, disables HA)    stricter settings)

How it works:
1. base/kustomization.yaml lists all resource files
2. overlays/dev/kustomization.yaml says:
   - resources: [../../base]       ← "start with everything in base"
   - patches: [patch.yaml]         ← "then merge these overrides on top"
3. Kustomize performs a strategic merge:
   - Fields in patch.yaml override matching fields in base
   - Fields NOT in patch.yaml keep their base values
```

## Dev vs Prod Differences

| Setting | Dev | Prod (base defaults) |
|---------|-----|---------------------|
| Replicas | 1 | 2 |
| PodDisruptionBudget | disabled | enabled (minAvailable: 1) |
| CPU requests/limits | 25m / 100m | 50m / 200m |
| Memory requests/limits | 32Mi / 64Mi | 64Mi / 128Mi |
| ServiceMonitor | disabled | enabled (scraped every 30s) |
| NetworkPolicy | disabled | enabled (strict ingress/egress) |
| Log level | debug | info |
| Priority class | none | system-cluster-critical |

## Related Files in Other Directories

| File | Why it matters |
|------|---------------|
| `clusters/dev-projectx/sealed-secrets.yaml` | Flux Kustomization that tells Flux to deploy `platform-tools/sealed-secrets/overlays/dev`. Has a health check on the Deployment. Other tools like Thanos have `dependsOn: [sealed-secrets]` |
| `platform-tools/thanos/base/thanos-objstore-sealed-secret.yaml` | An example of a SealedSecret that the controller decrypts -- the Thanos S3 config |
| `terraform-infra/eks-cluster/flux.tf` | Bootstraps Flux on the EKS cluster, which is what makes the entire GitOps pipeline work |

## How Flux Deploys This (GitOps Flow)

```
1. You push changes to the "main" branch on GitHub
          │
          ▼
2. Flux's GitRepository source detects the new commit (polls every 1m)
          │
          ▼
3. Flux's Kustomization "sealed-secrets" (clusters/dev-projectx/sealed-secrets.yaml):
   - Points to path: ./platform-tools/sealed-secrets/overlays/dev
   - Runs Kustomize: merges base/ + dev/patch.yaml
          │
          ▼
4. Flux applies the rendered manifests to the cluster:
   - Namespace (sealed-secrets)
   - HelmRepository (chart source URL)
   - HelmRelease (chart + values)
   - NetworkPolicy (if enabled)
   - RBAC (ClusterRole + ClusterRoleBinding)
          │
          ▼
5. Flux's Helm controller processes the HelmRelease:
   - Pulls the sealed-secrets chart (version >=2.16.0 <3.0.0)
   - Renders the chart templates with the merged values
   - Installs or upgrades the Helm release
          │
          ▼
6. Health check: Flux watches Deployment/sealed-secrets in sealed-secrets namespace
   - If it becomes Ready within 5m → Kustomization status = Ready
   - Other Kustomizations that dependOn sealed-secrets can now proceed
```

## How to Use Sealed Secrets (Creating a New Secret)

```bash
# Step 1: Create a plaintext secret (dry-run, never applied to cluster)
kubectl create secret generic my-secret \
  --namespace my-namespace \
  --from-literal=password=super-secret-value \
  --dry-run=client -o yaml > /tmp/my-secret.yaml

# Step 2: Encrypt it using kubeseal
kubeseal --controller-name=sealed-secrets \
         --controller-namespace=sealed-secrets \
         --format yaml < /tmp/my-secret.yaml > my-sealed-secret.yaml

# Step 3: Commit the SealedSecret (NOT the plaintext!) to Git
git add my-sealed-secret.yaml
git commit -m "add sealed secret for my-app"

# Step 4: Clean up the plaintext file
rm /tmp/my-secret.yaml

# The sealed-secrets controller will automatically decrypt it into a regular Secret
```

## Troubleshooting

```bash
# Check if Flux Kustomization is healthy
flux get kustomizations sealed-secrets

# Check HelmRelease status
flux get helmreleases -n sealed-secrets

# Check the controller pods are running
kubectl get pods -n sealed-secrets

# Check controller logs (look for key rotation, decryption errors)
kubectl logs -n sealed-secrets -l app.kubernetes.io/name=sealed-secrets

# Check if a SealedSecret was decrypted successfully
# (the controller creates a regular Secret with the same name)
kubectl get sealedsecrets -A
kubectl get secrets -A | grep sealed

# Verify the controller's public certificate (used by kubeseal)
kubeseal --controller-name=sealed-secrets \
         --controller-namespace=sealed-secrets \
         --fetch-cert

# Force Flux to reconcile
flux reconcile kustomization sealed-secrets
flux reconcile helmrelease sealed-secrets -n sealed-secrets

# Check events for errors
kubectl get events -n sealed-secrets --sort-by='.lastTimestamp'

# If a SealedSecret is not being decrypted, check the controller logs:
kubectl logs -n sealed-secrets -l app.kubernetes.io/name=sealed-secrets | grep -i error
```
