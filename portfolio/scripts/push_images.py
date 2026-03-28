#!/usr/bin/env python3
"""
Build, tag, and push Docker images to AWS ECR.
Usage: Run from the repo root (/Users/moathsalman/github-actions/platform-tools)
       python3 portfolio/scripts/push_images.py
"""

import subprocess
import sys


# ---------- CONFIGURATION ----------
AWS_REGION = "us-east-1"
AWS_ACCOUNT_ID = "665832051028"  # Replace with your actual account ID
ECR_REGISTRY = f"{AWS_ACCOUNT_ID}.dkr.ecr.{AWS_REGION}.amazonaws.com"

IMAGES = [
    {
        "name": "portfolio-backend",
        "context": "./portfolio/backend",
        "dockerfile": "./portfolio/backend/Dockerfile",
    },
    {
        "name": "portfolio-frontend",
        "context": "./portfolio/frontend",
        "dockerfile": "./portfolio/frontend/Dockerfile",
    },
]


# ---------- HELPER FUNCTIONS ----------
def run(cmd, capture=False):
    """Run a shell command and handle errors."""
    print(f"  → {cmd}")
    result = subprocess.run(
        cmd, shell=True, capture_output=capture, text=True
    )
    if result.returncode != 0:
        if capture:
            print(f"  ERROR: {result.stderr.strip()}")
        sys.exit(1)
    return result


def get_git_sha():
    """Get the short git commit SHA for tagging."""
    result = run("git rev-parse --short HEAD", capture=True)
    return result.stdout.strip()


def ecr_login():
    """Authenticate Docker with ECR."""
    print("\n[1/4] Authenticating with ECR...")
    run(
        f"aws ecr get-login-password --region {AWS_REGION} "
        f"| docker login --username AWS --password-stdin {ECR_REGISTRY}"
    )
    print("  Authenticated")


def ensure_repo_exists(repo_name):
    """Create ECR repository if it doesn't exist."""
    result = run(
        f"aws ecr describe-repositories "
        f"--repository-names {repo_name} "
        f"--region {AWS_REGION} 2>/dev/null",
        capture=True,
    )
    if result.returncode != 0:
        print(f"  Creating ECR repo: {repo_name}")
        run(
            f"aws ecr create-repository "
            f"--repository-name {repo_name} "
            f"--region {AWS_REGION} "
            f"--image-scanning-configuration scanOnPush=true"
        )


def build_images(git_sha):
    """Build Docker images for all services."""
    print("\n[2/4] Building images...")
    for img in IMAGES:
        tag_latest = f"{ECR_REGISTRY}/{img['name']}:latest"
        tag_sha = f"{ECR_REGISTRY}/{img['name']}:{git_sha}"
        print(f"\n  Building {img['name']}...")
        run(
            f"docker build "
            f"-t {tag_latest} "
            f"-t {tag_sha} "
            f"-f {img['dockerfile']} "
            f"{img['context']}"
        )
    print("\n  All images built")


def push_images(git_sha):
    """Push all images to ECR."""
    print("\n[3/4] Pushing images to ECR...")
    for img in IMAGES:
        ensure_repo_exists(img["name"])
        tag_latest = f"{ECR_REGISTRY}/{img['name']}:latest"
        tag_sha = f"{ECR_REGISTRY}/{img['name']}:{git_sha}"
        print(f"\n  Pushing {img['name']}...")
        run(f"docker push {tag_latest}")
        run(f"docker push {tag_sha}")
    print("\n  All images pushed")


def print_summary(git_sha):
    """Print a summary of what was pushed."""
    print("\n[4/4] Summary")
    print("=" * 50)
    print(f"  Git SHA:    {git_sha}")
    print(f"  Registry:   {ECR_REGISTRY}")
    print(f"  Images pushed:")
    for img in IMAGES:
        print(f"    - {img['name']}:{git_sha}")
        print(f"    - {img['name']}:latest")
    print("=" * 50)


# ---------- MAIN ----------
if __name__ == "__main__":
    print("=== Portfolio Image Push Script ===")

    git_sha = get_git_sha()
    print(f"  Git SHA: {git_sha}")

    ecr_login()
    build_images(git_sha)
    push_images(git_sha)
    print_summary(git_sha)

    print("\nDone!")