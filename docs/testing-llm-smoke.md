# Testing strategy: smoke, LLM bar, and CI

This document describes how to test GMEBot/cback **without** relying on a specific LLM, optional **real LLM** smoke, and a path to **stricter** model acceptance tests.

## What already exists

| Layer | What it proves | Needs LLM? |
|--------|----------------|------------|
| `POST /cback/test/run-tool` (`NODE_ENV=test`) | Tools + WebGME + `ToolContext` | No |
| `test/routers/cback/chat-prompt.spec.js` | Tool sequences change model state (e.g. `createMetaNode` + `getMetaInfo`) | No |
| Optional `OLLAMA_E2E=1` | `POST /cback/chat` returns a `reply` | Yes |

See also [README_PROMPT_TESTS.md](../test/routers/cback/README_PROMPT_TESTS.md) and [github-actions-llm-ci.md](./github-actions-llm-ci.md).

## Recommended test pyramid

### 1. System smoke (no LLM) — default CI bar

- Server starts; config/health routes respond as expected.
- `run-tool`: minimal happy path (e.g. `listProjects` → project context → a tool that mutates state → read back with `getMetaInfo` or similar).
- Assert HTTP 200, stable JSON shape, no spurious errors.

Validates the **stack for users** when tools are invoked correctly; does **not** judge the LLM.

### 2. Adapter / protocol tests (no LLM)

Unit-test `packages/cback/src/llmAdapter.ts` with **fixed** OpenAI-shaped JSON:

- Responses with `message.tool_calls` populated.
- Responses with only `content` (bare JSON / edge cases) and assert **synthesis** or warnings.
- Error paths: HTML body, auth errors, timeouts.

Defines the **contract** between the gateway and cback; fast and stable.

### 3. Mock OpenAI-compatible server (no real model)

In tests, start a tiny HTTP server implementing `POST …/v1/chat/completions` with **predetermined** bodies:

- Assistant returns proper `tool_calls` → assert the chat loop runs the expected tools.
- Assistant returns only text / malformed tool output → assert fallback or logging behavior.

Exercises the **full chat path** without depending on inference quality.

### 4. Real LLM smoke (optional CI or nightly)

- Ollama in the runner, or a cloud OpenAI-compatible API (see `github-actions-llm-ci.md`).
- Keep assertions **structural**: status 200, `reply` present and non-empty, optional `commands` shape.
- Avoid strict natural-language assertions unless the **model and prompt are pinned**.

### 5. Stricter “model quality” acceptance (optional)

- Scenario prompts where success is checked via **model state** after chat: call `run-tool` with `getMetaInfo`, `listNodes`, etc., and assert on concepts/paths.
- Or assert tool **order/names** from structured logs (if enabled in test).

Use for **nightly** or **release** gates; higher flake risk than structural smoke.

### 6. Golden regression (optional)

- Pin `LLM_MODEL`, temperature, and a small prompt set.
- Assert on **substring/regex** of `reply` or on **post-conditions** via tools.

Catches prompt/router regressions; not a guarantee that “any” model passes.

## Recommended policy

| Goal | Mechanism | Every PR? |
|------|-----------|-----------|
| WebGME + cback + tools | `run-tool` + model assertions | Yes |
| `llmAdapter` contract | Unit tests + mock HTTP responses | Yes |
| Full chat without weights | Mock OpenAI server + one scenario | Yes (once implemented) |
| Real LLM responds | `OLLAMA_E2E` or cloud env | Optional / nightly |
| “Smart enough” model | Scenario + post-condition via tools | Nightly / manual |

## Small improvements

- **CI branches**: ensure the workflow runs on your main development branch (e.g. `draft`) if that is where PRs land.
- **E2E assertion**: beyond `reply` being a string, require `reply.length > 0` and no top-level `error` when status is 200.
- **Next high-ROI step**: add **mock `chat/completions`** integration tests, then optional **Ollama** in CI for true LLM smoke.
