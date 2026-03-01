Prometheus – Custom Helm Chart (EKS Monitoring)

Overview

This directory contains a custom-built Prometheus Helm chart designed specifically for monitoring an AWS EKS cluster.

We are not using public Helm charts to keep things simple, readable, and easy to customize for interviews and learning.

This chart deploys:
	•	Prometheus Server (StatefulSet)
	•	Node Exporter (DaemonSet)
	•	Kube-State-Metrics (Deployment)
	•	Required RBAC (ServiceAccounts, ClusterRoles, Bindings)
	•	Services for internal communication
	•	Prometheus scrape configuration

⸻

Architecture – How Everything Connects

EKS Cluster
 ├── Node Exporter (DaemonSet)  → Node OS metrics (CPU, memory, disk)
 ├── Kube-State-Metrics         → Kubernetes object state (pods, deployments, HPAs)
 ├── API Server / Kubelet       → Control plane & node metrics
 └── Prometheus Server          → Scrapes everything and stores metrics

Prometheus automatically discovers all components using Kubernetes Service Discovery.

⸻

Folder Structure

prometheus/
 ├── templates/
 ├── Chart.yaml
 ├── dev-values.yaml
 └── .helmignore


⸻

Chart.yaml

Helm chart metadata file.

Defines:
	•	Chart name
	•	Chart version
	•	Prometheus app version

This is informational for Helm packaging and release management.

⸻

dev-values.yaml

This file contains environment-specific configuration.

It defines:

Global
	•	Namespace
	•	Scrape interval
	•	Evaluation interval

Prometheus Server
	•	Replica count
	•	Image version
	•	Data retention
	•	Persistent storage (EBS)
	•	Resource limits

Node Exporter
	•	Image + resources

Kube-State-Metrics
	•	Image + resources

This file is what allows you to customize dev/staging/prod later.

⸻

templates/ Directory

This folder contains all Kubernetes manifests rendered by Helm.

Each file has a very specific purpose.

⸻

1️⃣ Prometheus Server

statefulset.yaml

Runs the Prometheus server.

Why StatefulSet?
	•	Prometheus stores data locally.
	•	It needs persistent storage.
	•	StatefulSets work best with volumes.

Mounts:
	•	ConfigMap → prometheus.yml
	•	Persistent Volume → metric storage

⸻

service.yaml

ClusterIP service for Prometheus.

Provides a stable DNS name inside the cluster:

prometheus-server.monitoring.svc


⸻

headless-service.yaml

Required by StatefulSet.

Provides stable pod DNS identity.

⸻

serviceaccount.yaml

Identity Prometheus runs as.

Used to authenticate to Kubernetes API.

⸻

clusterrole.yaml

Read-only permissions so Prometheus can:
	•	Discover nodes
	•	Discover pods
	•	Discover services
	•	Scrape API server

⸻

clusterrolebinding.yaml

Connects:
ServiceAccount → ClusterRole

Without this, Prometheus cannot discover anything.

⸻

2️⃣ Node Exporter (Node Metrics)

node-exporter-daemonset.yaml

Runs one pod per node.

Why DaemonSet?
	•	We want OS-level metrics from every node.

Mounts:
	•	/proc
	•	/sys
	•	/

Exposes:

:9100/metrics


⸻

node-exporter-service.yaml

Stable Service that exposes all node-exporter pods.

Prometheus scrapes this.

⸻

3️⃣ Kube-State-Metrics (Kubernetes Object Metrics)

kube-state-metrics-deployment.yaml

Runs kube-state-metrics.

This reads Kubernetes objects and exposes metrics such as:
	•	Pod status
	•	Deployment replicas
	•	HPA status
	•	PVC state

⸻

kube-state-metrics-service.yaml

ClusterIP service exposing kube-state-metrics on port 8080.

⸻

kube-state-metrics-serviceaccount.yaml

Identity used to read Kubernetes API.

⸻

kube-state-metrics-clusterrole.yaml

Read-only permissions to:
	•	List/watch pods
	•	List/watch deployments
	•	List/watch nodes
	•	List/watch HPAs
	•	etc.

⸻

kube-state-metrics-clusterrolebinding.yaml

Connects:
ServiceAccount → ClusterRole

⸻

4️⃣ configmap.yaml (Prometheus Brain)

Contains prometheus.yml.

Defines:
	•	Scrape intervals
	•	Kubernetes discovery
	•	Which jobs to scrape:
	•	API server
	•	Kubelet
	•	cAdvisor
	•	Node Exporter
	•	Kube-State-Metrics
	•	CoreDNS
	•	Annotated pods/services

This is the core logic of monitoring.

⸻

How Prometheus Discovers Targets

We use:

kubernetes_sd_configs

Prometheus talks to the Kubernetes API and automatically discovers:
	•	Nodes
	•	Pods
	•	Services
	•	Endpoints

This means:
No hardcoded IP addresses.
Fully dynamic.

⸻

Why This Design Matters

This setup shows:
	•	Understanding of Kubernetes internals
	•	RBAC configuration
	•	Service Discovery
	•	Stateful vs Stateless workloads
	•	DaemonSet usage
	•	Monitoring architecture
	•	Production-style Helm structure

This is interview-ready infrastructure.

⸻

Deployment

Deployed using GitHub Actions workflow:

helm upgrade --install prometheus ./helm-prometheus \
  --namespace monitoring --create-namespace \
  --values dev-values.yaml


⸻

Summary

This Helm chart builds a complete Kubernetes monitoring stack:
	•	Prometheus = metrics collector + storage
	•	Node Exporter = node OS metrics
	•	Kube-State-Metrics = Kubernetes object state metrics
	•	RBAC = secure API access
	•	Services = stable networking
	•	ConfigMap = monitoring logic

Everything is modular, clean, and production-structured.

⸻
