# LLM provider (dev)

The cback chat router can use **Ollama** (local), **Groq** (free tier), **OpenAI**, or **Anthropic** as the LLM. Switch via environment variables.

## Default: Ollama (local)

- Start Ollama and pull a model: `ollama serve`, `ollama pull qwen3:8b` (or the model in `packages/cback/src/ollama.ts`).
- No env vars needed. The app talks to `http://127.0.0.1:11434`.

## Groq (free tier, recommended for dev)

- **Free tier:** No credit card required; high rate limits (e.g. 30 RPM, 14.4K requests/day for `llama-3.1-8b-instant`). Supports tool/function calling.
- Get an API key at [console.groq.com](https://console.groq.com).
- Set: `LLM_PROVIDER=groq`, `GROQ_API_KEY=<your-key>`
- Optional: `GROQ_MODEL=llama-3.1-8b-instant` (default)

**Quick setup:**

1. Go to [console.groq.com](https://console.groq.com), sign up, and create an API key (e.g. **API Keys → Create API Key**).
2. Copy the key (starts with `gsk_`).
3. **Option A — .env file (recommended):** In the project root, copy `.env.example` to `.env`, uncomment and set:
   ```env
   LLM_PROVIDER=groq
   GROQ_API_KEY=gsk_YOUR_KEY_HERE
   ```
   Then run `npm start` as usual; the app loads `.env` automatically.
4. **Option B — shell:** In your terminal, set env and start the app:
   - **PowerShell:**  
     `$env:LLM_PROVIDER = "groq"; $env:GROQ_API_KEY = "gsk_YOUR_KEY_HERE"; npm start`
   - **Bash:**  
     `export LLM_PROVIDER=groq GROQ_API_KEY=gsk_YOUR_KEY_HERE; npm start`
5. Open the app in the browser, open a project, and use GMEBot — chat will go through Groq.
6. To confirm: **GET** `http://localhost:PORT/cback/config` (or your server URL) and check `llm.provider === "groq"`.

## OpenAI

- **Free trial:** About $5 credit for new users (one-time, ~3 months), then paid.
- Set: `LLM_PROVIDER=openai`, `OPENAI_API_KEY=<your-key>`
- Optional: `OPENAI_MODEL=gpt-4o-mini` (default) or `gpt-3.5-turbo`

## Anthropic

- **Trial:** About $5 free credit on signup, then paid.
- Set: `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=<your-key>`
- Optional: `ANTHROPIC_MODEL=claude-3-5-haiku-20241022` (default)
- Get a key at [console.anthropic.com](https://console.anthropic.com).

## Fallback

If you set `LLM_PROVIDER=groq` (or `openai` / `anthropic`) but the corresponding API key is missing, the server falls back to Ollama and logs a warning.

## Check which provider is active

- **GET /cback/config** returns `llm: { provider: "groq"|"openai"|"anthropic"|"ollama", model?, host?, port? }`.

## Tests

Tests do **not** use the LLM by default. E2E chat tests (when you set `OLLAMA_E2E=1`) still assume a running Ollama unless you configure a cloud provider in the test env.

---

## Token usage and compression

**Monitoring:** When using Groq, OpenAI, or Anthropic, the server logs token usage per round, e.g.  
`cback tokens round 1: prompt=1234 completion=56 total=1290`.  
The chat API response also includes a `usage` object when the provider reports it: `{ prompt_tokens, completion_tokens, total_tokens? }` so the client can display it.

**Compression (server-side):**
- **History cap:** Only the last 40 messages (including system) are sent to the LLM. Older turns are dropped so long sessions don’t grow without bound.
- **Tool result truncation:** Tool results stored in history are truncated to 2500 characters; the rest is replaced with ` [truncated]` so large JSON (e.g. from getMetaInfo or listProjects) doesn’t dominate the context.

To tune: edit `MAX_HISTORY_MESSAGES` and `MAX_TOOL_RESULT_CHARS` in `packages/cback/src/cback.ts`, then rebuild.
