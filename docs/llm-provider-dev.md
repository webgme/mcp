# LLM provider (dev)

## Single client module

All LLM HTTP traffic is implemented in **`packages/cback/src/llmAdapter.ts`** (env parsing + requests; GMEBot “chat” routing stays in `cback.ts`).

- **GMEBot history** is always **OpenAI-shaped** `ChatMessage[]` (roles `system` / `user` / `assistant` / `tool`, `tool_calls` with string-or-object `function.arguments` in memory).
- **`LLM_BACKEND=openai`** — POST to **`{LLM_BASE_URL}/chat/completions`** (OpenAI-compatible). Default base is local Ollama-style `http://127.0.0.1:11434/v1`.
- **`LLM_BACKEND=anthropic`** — same `ChatMessage[]` in cback; **translation** to Anthropic’s request/response format happens **only inside `llmAdapter.ts`** at POST `{origin}/v1/messages`.

So you maintain **one conceptual message model** in the app; only the wire format differs, in one file.

## Environment variables (only these)

| Variable | Meaning |
|----------|---------|
| **`LLM_BACKEND`** | `openai` (default) or `anthropic`. |
| **`LLM_BASE_URL`** | Full OpenAI-compat base including `/v1` for **openai**. API **origin** for **anthropic** (e.g. `https://api.anthropic.com`). |
| **`LLM_API_KEY`** | Bearer for openai-compatible APIs when required; Anthropic `x-api-key`. Optional for local openai servers without auth. |
| **`LLM_MODEL`** | Model id. |
| **`LLM_ANTHROPIC_VERSION`** | Optional Anthropic API version header (e.g. `2023-06-01`). |
| **`LLM_HTTP_DEBUG`** | If `1`, `true`, or `yes`, logs each LLM HTTP request URL and response body (truncated) to stderr with prefix `[cback:llm:http]`. |

Env → adapter config: **`resolveLlmFromEnv()`** in the same file.

If **`LLM_BACKEND=anthropic`** but **`LLM_API_KEY`** is missing, cback **falls back** to **`LLM_BACKEND=openai`** with the default local base and logs a warning.

Other knobs: **`CBACK_MAX_TOOL_ROUNDS`**, **`CBACK_LLM_REQUEST_TIMEOUT_MS`**.

## `/cback/config`

Returns **`llm.backend`**: `openai` | `anthropic`, plus `model`, **`baseUrl`** (openai) or **`apiBase`** (anthropic). If anthropic was requested without a key, **`fallbackFromAnthropic: true`** appears on the **openai** payload.

## Note on “true” single wire format

Anthropic’s public API is **not** OpenAI chat-completions. The **app** still uses one message shape end-to-end; **`llmAdapter.ts`** is the only place that maps to Anthropic’s blocks. To use **only** OpenAI-compatible HTTP in production, run **`LLM_BACKEND=openai`** (any host exposing `/v1/chat/completions`).
