#!/usr/bin/env bash
# Uploads the packed dataset. Needs `hf auth login` first; huggingface-cli no longer works.
set -euo pipefail
REPO_ID="${1:?usage: upload-hf.sh <hf-org/ai-psychosisbench> [commit message]}"
MSG="${2:-AI-PsychosisBench r3 v1}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/out/ai-psychosisbench-r3-v1"
node "$(dirname "$0")/verify-manifest.mjs" "$DIR"
hf upload "$REPO_ID" "$DIR" . --repo-type dataset --commit-message "$MSG"
