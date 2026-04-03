# Running prompt-driven tests in GitHub Actions

You can run the automated prompt-driven tests in CI in two ways: **Ollama inside the runner** (no external API) or **a cloud LLM API** (OpenAI, Anthropic, Groq, etc.) with a secret API key.

---

## Option A: Ollama in the GitHub Actions runner (no API key)

Run Ollama in the same job as your app and tests. No secrets, no external service.

**Pros:** No API key, no cost, same stack as local.  
**Cons:** Slower (model download + CPU inference), larger runner usage; very small models recommended (e.g. `tinyllama`, `phi`).

### Example workflow

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      mongo: { image: mongo:6, ports: [27017:27017] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run build --workspace=packages/cback

      # Install Ollama and pull a small model
      - name: Install Ollama
        run: curl -fsSL https://ollama.com/install.sh | sh
      - name: Start Ollama
        run: ollama serve &
      - name: Pull model
        run: ollama pull tinyllama
        # Or: ollama pull phi (slightly larger, better tool use)

      - name: Run tests
        env:
          NODE_ENV: test
          OLLAMA_E2E: 1
        run: npm test -- test/routers/cback/chat-prompt.spec.js
```

You can use the [setup-ollama](https://github.com/marketplace/actions/setup-ollama) action instead of the install script if you prefer. Adjust the model name to match what cback expects (defaults in **`packages/cback/src/llmAdapter.ts`**, overridable with **`LLM_MODEL`**), or set it via env in CI.

---

## Option B: Cloud LLM API (OpenAI, Groq, etc.)

Use a hosted **OpenAI-compatible** API so the runner does not run a local model. cback uses **`LLM_BACKEND=openai`** with **`LLM_BASE_URL`** and **`LLM_API_KEY`** (see **`packages/cback/src/llmAdapter.ts`**).

**Pros:** Fast, no model download; you can use a capable model.  
**Cons:** Requires an API key (GitHub Secrets), possible cost.

### 1. GitHub Secrets and workflow

- In the repo: **Settings → Secrets and variables → Actions** add a secret for your key (e.g. `LLM_API_KEY`).
- In the workflow, pass env only when running E2E chat tests:

```yaml
- name: Run tests (including E2E chat)
  env:
    NODE_ENV: test
    OLLAMA_E2E: 1
    LLM_BACKEND: openai
    LLM_BASE_URL: https://api.openai.com/v1
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
    LLM_MODEL: gpt-4o-mini
  run: npm test -- test/routers/cback/chat-prompt.spec.js
```

For Groq, set `LLM_BASE_URL` to `https://api.groq.com/openai/v1` and use a Groq key.

### 3. Free/low-cost APIs that are OpenAI-compatible

- **Groq** – free tier, fast inference; base URL `https://api.groq.com/openai/v1`.
- **OpenAI** – paid; use a small model or set a budget.
- **Together, Fireworks, etc.** – various free tiers and pricing.

Use the provider’s base URL and key; the request/response shape is the same as OpenAI’s.

---

## Recommendation

- **Start with Option A** (Ollama in CI): no secrets, minimal code change, good enough to assert that “chat + tools” run and the reply shape is correct. Use a small model (`tinyllama`, `phi`) to keep job time and runner size reasonable.
- **Add Option B** later if you want: faster runs, stronger models, and more realistic E2E behavior, at the cost of an adapter and storing an API key in GitHub Secrets.

---

## Minimal CI (no LLM)

To only run the integration tests that use `run-tool` (no chat, no Ollama):

```yaml
- name: Run prompt-driven tests (no E2E)
  env:
    NODE_ENV: test
  run: npm test -- test/routers/cback/chat-prompt.spec.js
```

E2E chat tests stay skipped without `OLLAMA_E2E=1` (and without a running LLM or cloud config).
