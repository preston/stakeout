#!/usr/bin/env bash
# Local multi-architecture Docker builds for UI and server (amd64 + arm64).
# Builds are validated via buildx; images are not pushed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PLATFORMS="linux/amd64,linux/arm64"
UI_IMAGE="${UI_IMAGE:-p3000/stakeout-ui:latest}"
SERVER_IMAGE="${SERVER_IMAGE:-p3000/stakeout-server:latest}"

if ! docker buildx version >/dev/null 2>&1; then
  echo "error: docker buildx is required" >&2
  exit 1
fi

# Prefer an existing builder that can do multi-platform; create one if needed.
if ! docker buildx inspect stakeout-multiarch >/dev/null 2>&1; then
  docker buildx create --name stakeout-multiarch --driver docker-container --use
else
  docker buildx use stakeout-multiarch
fi
docker buildx inspect --bootstrap >/dev/null

echo "==> Building ${UI_IMAGE} (${PLATFORMS})"
docker buildx build \
  --platform "${PLATFORMS}" \
  -f ui/Dockerfile \
  -t "${UI_IMAGE}" \
  .

echo "==> Building ${SERVER_IMAGE} (${PLATFORMS})"
docker buildx build \
  --platform "${PLATFORMS}" \
  -f server/Dockerfile \
  -t "${SERVER_IMAGE}" \
  .

echo "Done. Multiarch builds completed locally (not pushed)."
