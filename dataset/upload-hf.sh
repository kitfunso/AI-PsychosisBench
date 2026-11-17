#!/usr/bin/env bash
# Uploads the packed dataset. Needs `huggingface-cli login` first.
set -euo pipefail
REPO_ID="${1:?usage: upload-hf.sh <hf-org/ai-psychosis-bench>}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/out/ai-psychosis-bench-r3-v1"
node "$(dirname "$0")/verify-manifest.mjs" "$DIR"
huggingface-cli upload "$REPO_ID" "$DIR" . --repo-type dataset --commit-message "ai-psychosis-bench r3 v1"
