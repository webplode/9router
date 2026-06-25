#!/usr/bin/env bash
# Build multi-platform image and push to Docker Hub.
# Prereq: docker login (docker login -u abwebplode)
#
# Speed tips (Colima on Apple Silicon):
#   PLATFORMS=linux/arm64 bash scripts/docker-push-proxyroute.sh   # ~2 min, homelab arm64 only
#   PLATFORMS=linux/amd64,linux/arm64 ...                          # ~10+ min (amd64 = QEMU emulation)
set -euo pipefail

IMAGE="${IMAGE:-abwebplode/proxyroute}"
TAG="${TAG:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-multiplatform}"
CACHE_REF="${CACHE_REF:-${IMAGE}:buildcache}"

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
echo "(registry build cache: ${CACHE_REF})"

docker buildx build \
  --platform "$PLATFORMS" \
  -f Dockerfile \
  -t "${IMAGE}:${TAG}" \
  --cache-from "type=registry,ref=${CACHE_REF}" \
  --cache-to "type=registry,ref=${CACHE_REF},mode=max" \
  --push \
  .

echo "Done: ${IMAGE}:${TAG} (${PLATFORMS})"