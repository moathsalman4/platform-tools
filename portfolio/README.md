# Portfolio Application

A production-grade personal portfolio deployed on Kubernetes (EKS) using GitOps principles with FluxCD, Istio service mesh, and automated CI/CD via GitHub Actions.

**Live at:** `https://portfolio.grafanamoath.click`

---

## What I Built

A two-tier portfolio web application:

- **Backend** — A Node.js/Express API (`server.js`) that serves portfolio data (experience, projects, skills/certifications) from static JSON files on port 3001.
- **Frontend** — A single-page HTML/CSS/JS portfolio served by NGINX on port 80. It fetches data from the backend API at `/api/*` endpoints.

The application is containerized with Docker, deployed to an AWS EKS cluster via Helm charts, managed through FluxCD GitOps, and exposed through an Istio ingress gateway with automated TLS via cert-manager and Let's Encrypt.

---

## How I Built It

### Phase 1: Initial Application & CI/CD Pipeline (Day 1)

Built the full application stack from scratch in a single commit:

- **Backend**: Express.js API with three data endpoints (`/api/experience`, `/api/skills`, `/api/projects`) and a health check (`/api/health`). Data stored as JSON files under `backend/data/`.
- **Frontend**: Initially built as a React + Vite + TailwindCSS SPA with three pages (Home, Projects, Experience) and a Navbar component.
- **Dockerfiles**: Multi-stage build for the frontend (Node build stage -> NGINX serve stage), simple Node Alpine image for the backend.
- **Helm Charts**: Created charts for both services with Deployment, Service, and HTTPRoute templates. Configured with health checks (readiness + liveness), resource requests/limits, and 2 replicas each for HA.
- **CI/CD Pipeline**: GitHub Actions workflow (`portfolio-ci.yaml`) triggered on pushes to `main` when `portfolio/**` changes. Pipeline steps:
  1. Checkout code
  2. Authenticate to AWS via OIDC (`role-to-assume`)
  3. Login to Amazon ECR
  4. Build both Docker images (tagged with git SHA + `latest`)
  5. Scan both images with Trivy (fail on CRITICAL vulnerabilities)
  6. Push images to ECR
  7. Package and push Helm charts to ECR as OCI artifacts
- **Push Script**: Python script (`scripts/push_images.py`) for manual image builds — authenticates to ECR, creates repos if needed, builds/tags/pushes images.

### Phase 2: FluxCD GitOps Setup (Day 2)

Set up FluxCD to manage continuous deployment from Git:

- **HelmRepository**: Points to the ECR OCI registry, syncs every 5 minutes, uses AWS provider for auth.
- **HelmReleases**: Two releases (backend + frontend) referencing the Helm charts in ECR. Each overrides image, replica count, and resource values.
- **Kustomization**: Ties the FluxCD resources together.

### Phase 3: Istio & TLS (Day 2)

Configured networking and security:

- **Istio Gateway**: Listens on ports 80 (HTTP) and 443 (HTTPS) for `portfolio.grafanamoath.click`. TLS terminated at the gateway using the `portfolio-tls` certificate.
- **VirtualService**: Routes `/api/*` requests to the backend service (port 3001) and everything else to the frontend (port 80).
- **Certificate**: cert-manager Certificate resource requesting a TLS cert from Let's Encrypt for `portfolio.grafanamoath.click`.
- **ClusterIssuer**: ACME issuer using DNS-01 challenge validation via AWS Route53.

### Phase 4: Frontend Redesign (Day 2)

Replaced the React SPA with a polished single-page HTML portfolio:

- Removed the multi-stage Docker build (no more Node build step needed).
- Replaced the Vite/React app with a self-contained `public/index.html`.
- Simplified the Dockerfile to just copy static files into NGINX.
- Added a profile photo (`myphoto.png`).

---

## Issues Encountered and How I Solved Them

### 1. Frontend API Calls Used Hardcoded URLs

**Problem:** The React components fetched data from `http://localhost:3001/api/*`, which doesn't work in production where the backend isn't on localhost.

**Fix:** Changed all fetch calls to use relative paths (`/api/experience` instead of `http://localhost:3001/api/experience`). This works because Istio's VirtualService routes `/api/*` to the backend — the frontend just needs to call `/api/*` on the same domain.

**Commit:** `9b3055d` — *fix: use relative API paths for production deployment*

### 2. FluxCD API Versions Didn't Match the Cluster

**Problem:** The FluxCD manifests used API versions that didn't match what was installed on the EKS cluster, causing reconciliation failures.

**Fix:** Updated the `apiVersion` fields in all three FluxCD manifests (HelmRepository and both HelmReleases) to match the versions available on the cluster.

**Commit:** `edca157` — *fix: update FluxCD API versions to match cluster*

### 3. Missing Kustomization File for FluxCD

**Problem:** FluxCD needs a `kustomization.yaml` to know which manifests to apply. Without it, the Flux Kustomization controller couldn't reconcile the portfolio resources.

**Fix:** Added `portfolio/flux/kustomization.yaml` listing all three FluxCD resource files.

**Commit:** `49dd02b` — *fix: add kustomization.yaml for portfolio flux manifests*

### 4. React Build Complexity Was Unnecessary

**Problem:** The React + Vite frontend required a multi-stage Docker build (Node.js to build, then copy to NGINX). This added build time, image size, and complexity for what was ultimately a static portfolio site.

**Fix:** Replaced the entire React app with a single self-contained HTML file. Simplified the Dockerfile from a 21-line multi-stage build to a 4-line NGINX copy. The page still fetches data from the backend API dynamically.

**Commit:** `a790f0d` — *feat: replace React frontend with polished single-page portfolio*

### 5. Image Pull Policy Needed for Latest Tag

**Problem:** Kubernetes caches images by default. When using the `latest` tag, pods wouldn't pick up new image pushes because the cached version was used.

**Fix:** Set `imagePullPolicy: Always` in the Helm chart values so Kubernetes always pulls the latest image.

**Commit:** `df95518` — *fix: update interests, set imagePullPolicy*

---

## Architecture

```
                         Internet
                            |
                   [ AWS Route53 DNS ]
                   portfolio.grafanamoath.click
                            |
                   [ Istio IngressGateway ]
                   TLS termination (Let's Encrypt)
                            |
                   [ Istio VirtualService ]
                      /          \
                /api/*          everything else
                    |                |
          [ Backend Service ]  [ Frontend Service ]
          Node.js:3001 (x2)    NGINX:80 (x2)
                    |
             [ JSON Data Files ]
```

### CI/CD Flow

```
Git Push (portfolio/**)
    |
    v
GitHub Actions
    |-- Build Docker images (backend + frontend)
    |-- Scan with Trivy (fail on CRITICAL)
    |-- Push to AWS ECR (SHA tag + latest)
    |-- Package & push Helm charts to ECR (OCI)
    |
    v
FluxCD (polls ECR every 5 min)
    |-- Detects new Helm chart versions
    |-- Reconciles HelmReleases
    |-- Deploys to EKS cluster
```

---

## How to Reproduce This

### Prerequisites

- AWS account with EKS cluster running
- `kubectl` configured for your cluster
- FluxCD installed on the cluster
- Istio installed on the cluster
- cert-manager installed on the cluster
- AWS ECR repositories created (or let the script create them)
- GitHub repo with OIDC-based AWS auth configured
- A domain managed in Route53

### Step 1: Clone and Understand the Structure

```
portfolio/
├── backend/                  # Node.js API
│   ├── Dockerfile
│   ├── server.js
│   ├── package.json
│   └── data/                 # JSON data files
│       ├── experience.json
│       ├── projects.json
│       └── skills.json
├── frontend/                 # Static HTML served by NGINX
│   ├── Dockerfile
│   └── public/
│       └── index.html
├── helm-charts/              # Kubernetes deployment charts
│   ├── portfolio-backend/
│   └── portfolio-frontend/
├── flux/                     # FluxCD GitOps manifests
│   ├── helmrepository.yaml
│   ├── backend-helmrelease.yaml
│   ├── frontend-helmrelease.yaml
│   └── kustomization.yaml
├── istio/                    # Networking & TLS
│   ├── gateway.yaml
│   ├── virtualservice.yaml
│   ├── certificate.yaml
│   └── clusterissuer-dns01.yaml
├── scripts/
│   └── push_images.py        # Manual image push script
└── docker-compose.yaml        # Local development
```

### Step 2: Run Locally with Docker Compose

```bash
cd portfolio
docker compose up --build
```

- Frontend: `http://localhost:80`
- Backend: `http://localhost:3001`

### Step 3: Push Images to ECR

Option A — Use the Python script:

```bash
cd portfolio/scripts
python push_images.py
```

Option B — Let CI handle it. Push changes to `portfolio/**` on the `main` branch, and the GitHub Actions workflow builds, scans, and pushes automatically.

### Step 4: Set Up GitHub Actions CI/CD

1. Create an IAM role with ECR push permissions and OIDC trust for your GitHub repo.
2. Add the role ARN as a repository variable (`IAM_ROLE`) in the `dev` environment.
3. The workflow at `.github/workflows/portfolio-ci.yaml` triggers on pushes to `main` that touch `portfolio/**`.

### Step 5: Deploy FluxCD Resources

```bash
# Create the namespace
kubectl create namespace portfolio

# Apply the FluxCD manifests
kubectl apply -k portfolio/flux/
```

FluxCD will pull the Helm charts from ECR and deploy both services.

### Step 6: Configure Istio Networking

```bash
# Apply the ClusterIssuer (one-time, cluster-wide)
kubectl apply -f portfolio/istio/clusterissuer-dns01.yaml

# Apply the certificate, gateway, and virtual service
kubectl apply -f portfolio/istio/certificate.yaml
kubectl apply -f portfolio/istio/gateway.yaml
kubectl apply -f portfolio/istio/virtualservice.yaml
```

### Step 7: DNS Configuration

Create a Route53 A/ALIAS record pointing `portfolio.grafanamoath.click` to your Istio ingress gateway's load balancer.

### Step 8: Verify

```bash
# Check pods are running
kubectl get pods -n portfolio

# Check certificate is issued
kubectl get certificate -n istio-system

# Check FluxCD reconciliation
kubectl get helmreleases -n portfolio

# Test the site
curl https://portfolio.grafanamoath.click
curl https://portfolio.grafanamoath.click/api/health
```

---

## Tech Stack Summary

| Layer          | Technology                                      |
|----------------|--------------------------------------------------|
| Frontend       | HTML/CSS/JS, NGINX                               |
| Backend        | Node.js, Express.js                              |
| Containers     | Docker                                           |
| Orchestration  | Kubernetes (AWS EKS)                             |
| Package Mgmt   | Helm 3 (OCI charts in ECR)                       |
| GitOps         | FluxCD                                           |
| Service Mesh   | Istio (Gateway, VirtualService)                  |
| TLS            | cert-manager, Let's Encrypt (DNS-01 via Route53) |
| CI/CD          | GitHub Actions                                   |
| Security Scan  | Trivy                                            |
| Registry       | AWS ECR                                          |
| DNS            | AWS Route53                                      |
