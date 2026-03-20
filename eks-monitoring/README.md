# Thanos Deployment on EKS via FluxCD
### Full Learning Session — Recorded for Future Reference

---

## Table of Contents
1. [Initial Notes](#initial-notes)
2. [Understanding Thanos Components](#understanding-thanos-components)
3. [IRSA Permissions Deep Dive](#irsa-permissions-deep-dive)
4. [The Object Store Secret](#the-object-store-secret)
5. [Multi-Cluster Architecture](#multi-cluster-architecture)
6. [FluxCD Setup](#fluxcd-setup)
7. [Enabling the Sidecar in kube-prometheus-stack](#enabling-the-sidecar-in-kube-prometheus-stack)
8. [Kubernetes Services](#kubernetes-services)
9. [Thanos Components Breakdown](#thanos-components-breakdown)
10. [Namespace](#namespace)
11. [Final Checklist](#final-checklist)
12. [Git Repo Structure](#git-repo-structure)
13. [Key Concepts to Remember](#key-concepts-to-remember)

---

## Initial Notes

At the start of the session, the initial deployment notes looked like this:

```
1. Create an IRSA for Thanos that has access to the cluster to scrape metrics.
   1. EKS describe cluster
   2. EKS list cluster
   3. EKS get token
2. Create a SA to attach role to pod
3. Create a PVC and volume
4. Create S3 bucket to configure Thanos
```

These 4 items cover **Auth** and **Storage** — a solid start. But a lot was missing.

---

## Session Goals

We established 3 goals for this Thanos deployment:

- ✅ Long-term metrics storage
- ✅ High availability Prometheus
- ✅ Global query view across multiple clusters

**Prometheus** is already deployed via `kube-prometheus-stack` (Helm).

---

## Understanding Thanos Components

Thanos is NOT a single app — it is made of **multiple components** that each do one job.

Think of it like an assembly line:

```
Prometheus → [Sidecar] → S3 Bucket → [Store Gateway] → [Querier] ← Grafana
                                           ↑
                                      [Compactor]
                                    (runs in background)
```

| Component | What it does |
|---|---|
| **Sidecar** | Sits next to Prometheus like a shadow. Reads Prometheus data and ships it to S3 |
| **Store Gateway** | Acts like a librarian for old metrics in S3. Serves them to the Querier |
| **Querier** | The single "ask me anything" endpoint. Grafana talks to this |
| **Compactor** | A background janitor that cleans and compresses old data in S3 to save costs |

---

## IRSA Permissions Deep Dive

### ❌ Original IRSA permissions (incorrect)

```
- EKS describe cluster
- EKS list cluster
- EKS get token
- S3 read/write
```

### Why EKS permissions are NOT needed

> **Q:** I thought Thanos needed access to multiple clusters since it will give us metrics of multiple clusters?

This is a common misconception. Thanos does **NOT** query clusters directly.

Each cluster has its own **Prometheus + Sidecar** that ships data to S3. The Querier reads from S3 via Store Gateways — it never touches the EKS API.

```
Cluster A → Prometheus → Sidecar → S3
Cluster B → Prometheus → Sidecar → S3
                                     ↓
                              Thanos Querier ← Grafana
```

The EKS permissions (describe cluster, list cluster, get token) belong to **CI/CD or cluster management tools** — not Thanos.

### ✅ Correct IRSA permissions (S3 only)

```
- s3:GetObject
- s3:PutObject
- s3:DeleteObject
- s3:ListBucket
- s3:GetObjectTagging   ← always paired with PutObjectTagging
- s3:PutObjectTagging   ← always paired with GetObjectTagging
```

> **Important:** `GetObjectTagging` and `PutObjectTagging` always come as a pair — don't use one without the other.

---

## The Object Store Secret

> **Q:** What Kubernetes object holds sensitive config like bucket names, regions, and credentials?
>
> **A:** Secrets!

Thanos needs to know **where your S3 bucket is** at startup. This is stored in a **Kubernetes Secret** called the **object store config secret**.

It contains config like:

```yaml
type: S3
config:
  bucket: your-bucket-name
  region: us-east-1
  endpoint: s3.amazonaws.com
```

Every Thanos component that touches S3 needs this secret:
- Sidecar ✅
- Store Gateway ✅
- Compactor ✅

> **Critical:** Kubernetes Secrets are **namespaced** — pods can only read secrets in the same namespace. Make sure all your components and secrets are in the `monitoring` namespace.

---

## Multi-Cluster Architecture

Thanos achieves global query view by having each cluster's **Sidecar** ship data to S3 independently. The **Querier** then federates across all Store Gateways.

```
Cluster A → Prometheus → Sidecar → ──────┐
                                          ▼
                                       S3 Bucket
                                          ▼
Cluster B → Prometheus → Sidecar → ──────┘
                                          ▼
                                   Store Gateway
                                          ▼
                                      Querier  ← Grafana
```

No direct cluster-to-cluster communication is needed.

---

## FluxCD Setup

### How FluxCD deploys Helm charts

```
FluxCD watches your Git repo
        ↓
Finds HelmRepository.yaml  ← tells FluxCD WHERE the chart lives
        ↓
Finds HelmRelease.yaml     ← tells FluxCD WHICH chart + YOUR values
        ↓
Thanos gets deployed!
```

> **Q:** We want to download public Helm charts. We are deploying via FluxCD — do we give the values in our HelmRelease.yaml?
>
> **A:** Yes! Since you're deploying via FluxCD, your values go **inside** your `HelmRelease.yaml`. You don't need a separate `values.yaml` unless you want one.

### HelmRepository.yaml

Must be created **BEFORE** your HelmRelease. It tells FluxCD where to find the public Helm chart.

```yaml
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: HelmRepository
metadata:
  name: bitnami
  namespace: monitoring
spec:
  interval: 24h
  url: https://charts.bitnami.com/bitnami
```

### HelmRelease.yaml

Contains your chart reference and all custom values. Set `targetNamespace: monitoring` so everything lands in the right namespace.

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta1
kind: HelmRelease
metadata:
  name: thanos
  namespace: monitoring
spec:
  targetNamespace: monitoring
  chart:
    spec:
      chart: thanos
      sourceRef:
        kind: HelmRepository
        name: bitnami
  values:
    # your values go here
```

---

## Enabling the Sidecar in kube-prometheus-stack

> **Q:** Is the Sidecar configured in the StatefulSet under spec.containers.sidecar?
>
> **A:** That's thinking at the wrong layer. Since you're using kube-prometheus-stack, you don't touch the StatefulSet directly. The Helm chart generates all of that for you.

> **Q:** Is it in kube-state-metrics-deployment.yaml under storage?
>
> **A:** No — kube-state-metrics is a separate metrics exporter. It just watches Kubernetes objects and exposes them as metrics. It has no idea Thanos exists. The Sidecar lives next to **Prometheus**.

### Where to configure it

In your `kube-prometheus-stack` HelmRelease values, under the `prometheus` section:

```yaml
prometheus:
  prometheusSpec:
    thanos:
      enabled: true
      objectStorageConfig:
        secret:
          name: thanos-objstore-secret
          key: objstore.yml
```

> **Key insight:** The section is named `prometheus` because that's the tool the Sidecar sits next to — not kube-state-metrics, not alertmanager.

---

## Kubernetes Services

> **Q:** How do other pods in Kubernetes talk to each other?
>
> **A:** A **Service (svc)**!

Every Thanos component that needs to be reached requires a Kubernetes Service. Services give pods a **stable network address** inside the cluster.

### Which components need a Service?

| Component | Needs Service? | Why |
|---|---|---|
| Sidecar | ✅ Yes (headless) | Querier needs to reach it via gRPC |
| Store Gateway | ✅ Yes | Querier needs to reach it |
| Querier | ✅ Yes | Grafana needs to reach it |
| Compactor | ❌ No | Nobody talks to it — it's a background worker |

> **Why gRPC?** Thanos components talk to each other using gRPC instead of HTTP because it is faster for metrics data.

---

## Thanos Components Breakdown

### Sidecar
- Enabled **inside** kube-prometheus-stack (not deployed separately)
- Needs: object store Secret, headless Service (gRPC)
- Ships recent Prometheus data to S3

### Store Gateway
- Deployed as a separate component
- Needs: object store Secret, Service
- Serves old S3 data to the Querier

### Querier
- Deployed as a separate component
- Needs: Service
- Talks to Sidecar + Store Gateway, serves results to Grafana

### Compactor
- Deployed as a separate component
- Needs: object store Secret, PVC
- Does **NOT** need a Service
- Compresses and cleans old data in S3 in the background

---

## Namespace

> **Q:** How do we make sure everything is in the right namespace?
>
> **A:** Create a `namespace.yaml` and deploy everything into `monitoring` — the same namespace where kube-prometheus-stack lives.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
```

Every manifest must include:

```yaml
metadata:
  namespace: monitoring
```

And your HelmRelease must include:

```yaml
spec:
  targetNamespace: monitoring
```

> **Why this matters:** Kubernetes Secrets are namespaced. If your Secret is in `namespace-A` and your pods are in `namespace-B`, the pods **cannot** read the secret. Everything must be in the same namespace.

---

## Final Checklist

You started with 4 items and ended with a complete 16-item deployment blueprint:

| # | Item | Notes |
|---|---|---|
| 1 | `namespace.yaml` | Deploy everything into `monitoring` namespace |
| 2 | IRSA | S3 permissions only — no EKS permissions needed |
| 3 | Service Account | Links IRSA role to pods |
| 4 | S3 Bucket | Long-term metrics storage |
| 5 | Object Store Config Secret | S3 bucket config for all Thanos components |
| 6 | `HelmRepository.yaml` | Tells FluxCD where to find the chart |
| 7 | `HelmRelease.yaml` | Chart reference + your custom values |
| 8 | kube-prometheus-stack sidecar config | `prometheus.prometheusSpec.thanos` section |
| 9 | Headless Service for Sidecar | gRPC port so Querier can reach it |
| 10 | Store Gateway deployment | Reads old metrics from S3 |
| 11 | Service for Store Gateway | So Querier can reach it |
| 12 | Querier deployment | Federation layer — Grafana talks to this |
| 13 | Service for Querier | So Grafana can reach it |
| 14 | Compactor deployment | Background janitor for S3 data |
| 15 | PVC for Compactor | Temporary disk space while compressing |

---

## Git Repo Structure

```
Git Repo (FluxCD watches)
├── namespace.yaml                     # monitoring namespace
├── irsa.yaml                          # S3 permissions only
├── serviceaccount.yaml                # links IRSA to pods
├── secret.yaml                        # object store config (S3 bucket details)
├── helmrepository.yaml                # where to find the Helm chart
├── helmrelease.yaml                   # kube-prometheus-stack with sidecar enabled
├── thanos/
│   ├── store-gateway-deployment.yaml
│   ├── store-gateway-svc.yaml
│   ├── querier-deployment.yaml
│   ├── querier-svc.yaml
│   ├── compactor-deployment.yaml
│   └── compactor-pvc.yaml
└── s3-bucket/
    └── bucket.tf                      # Terraform for S3 bucket
```

---

## Key Concepts to Remember

- 🔑 **Thanos does NOT manage clusters** — it only reads and stores metrics
- 🔑 **No EKS permissions needed** on the Thanos IRSA — S3 only
- 🔑 **Secrets are namespaced** — pods can only read secrets in the same namespace
- 🔑 **Every component that needs to be reached** requires a Kubernetes Service
- 🔑 **The Compactor is the only component** that does NOT need a Service
- 🔑 **The Sidecar is NOT deployed separately** — it is enabled inside kube-prometheus-stack
- 🔑 **Thanos components talk over gRPC** — not HTTP
- 🔑 **GetObjectTagging and PutObjectTagging** always come as a pair
- 🔑 **HelmRepository.yaml must exist** before HelmRelease.yaml will work
- 🔑 **FluxCD watches Git** — every change you push gets applied automatically

---

## Common Confusions Cleared Up

### kube-state-metrics vs Prometheus
| | kube-state-metrics | Prometheus |
|---|---|---|
| What it does | Watches K8s objects (pods, nodes) and exposes metrics | Scrapes and stores metrics |
| Knows about Thanos? | ❌ No | ✅ Yes (Sidecar lives here) |

### Sidecar vs Store Gateway
| | Sidecar | Store Gateway |
|---|---|---|
| Data age | Recent (current Prometheus data) | Old (historical S3 data) |
| Where deployed | Inside kube-prometheus-stack | Separate deployment |
| Talks to | S3 (writes) | S3 (reads) |

### Does Compactor need a Service?
**No.** The Compactor is a background worker. It reads from S3, compresses data, writes back to S3, and repeats. No other component ever needs to talk to it.

---

*Documented during live learning session — recorded for future reference.*
