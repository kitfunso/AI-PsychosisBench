#!/usr/bin/env bash
# Uploads the packed dataset. Needs `huggingface-cli login` first.
set -euo pipefail
REPO_ID="${1:?usage: upload-hf.sh <hf-org/ai-psychosisbench>}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/out/ai-psychosisbench-r3-v1"
node "$(dirname "$0")/verify-manifest.mjs" "$DIR"
huggingface-cli upload "$REPO_ID" "$DIR" . --repo-type dataset --commit-message "AI-PsychosisBench r3 v1"
