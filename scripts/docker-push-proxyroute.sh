#!/usr/bin/env bash
# Build multi-platform image and push to Docker Hub.
# Prereq: docker login (docker login -u abwebplode)
set -euo pipefail

IMAGE="${IMAGE:-abwebplode/proxyroute}"
TAG="${TAG:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-multiplatform}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "Creating buildx builder: $BUILDER"
  docker buildx create --name "$BUILDER" --driver docker-container --use
  docker buildx inspect --bootstrap
else
  docker buildx use "$BUILDER"
fi

echo "Building and pushing ${IMAGE}:${TAG} for ${PLATFORMS} ..."
docker buildx build \
  --platform "$PLATFORMS" \
  -f Dockerfile \
  -t "${IMAGE}:${TAG}" \
  --push \
  .

echo "Done: ${IMAGE}:${TAG} (amd64 + arm64)"