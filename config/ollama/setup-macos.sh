#!/usr/bin/env bash
# Tune Ollama for GMEBot/cback on Apple Silicon (64k context, responsive on ~64GB RAM).
# Run once after install/upgrade, then quit and reopen the Ollama app (menu bar).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "==> Pull base model (if missing)"
ollama pull qwen3.5:9b

echo "==> Create 64k context tag"
ollama create qwen3.5:9b-64k -f "${ROOT}/config/ollama/qwen3.5-9b-64k.Modelfile"

echo "==> Server env (launchctl — picked up after Ollama restart)"
# Use /bin/launchctl: /usr/local/bin/launchctl can be broken on some macOS installs.
LC="/bin/launchctl"
# One in-flight request: 64k KV cache is large; parallel=2+ often causes swap/thrashing.
"$LC" setenv OLLAMA_NUM_PARALLEL "1"
"$LC" setenv OLLAMA_MAX_LOADED_MODELS "1"
# Quantized KV cache: ~half KV RAM vs f16 at long context, usually faster on unified memory.
"$LC" setenv OLLAMA_KV_CACHE_TYPE "q8_0"

echo ""
echo "Done. Quit Ollama from the menu bar and open it again so env vars apply."
echo "Project LLM: copy .env.example → .env and use LLM_MODEL=qwen3.5:9b-64k"
