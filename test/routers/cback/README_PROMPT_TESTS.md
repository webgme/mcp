# Automated prompt-driven tests

`chat-prompt.spec.js` runs automated tests that send prompts (or simulate tool sequences) and assert on the **response** or the **resulting model**.

## How it works

- **Test-only endpoint**  
  When `NODE_ENV=test`, the cback router exposes `POST /cback/test/run-tool`. The body is `{ toolName, args?, context? }`. The server runs that single tool (with the same `ToolContext` as chat) and returns `{ data, commands? }`. This lets tests drive tools without calling the LLM.

- **Integration tests (no LLM)**  
  - Create or reuse a project (`createProject` or first project from `listProjects`).  
  - Call tools via `run-tool` (e.g. `createMetaNode`, `getMetaInfo`).  
  - Assert on the returned data or on model state (e.g. `getMetaInfo` concepts).

- **E2E with real LLM**  
  - `POST /cback/chat` with a prompt and optional `context`.  
  - Assert on `res.body.reply` (and optionally `commands`).  
  - These tests are **skipped** unless you set `OLLAMA_E2E=1` (and have Ollama running).

## Running

From the repo root:

```bash
# Build the cback router first (TypeScript → JS)
npm run build --workspace=packages/cback

# Run only the prompt-driven tests (NODE_ENV=test so run-tool is available)
NODE_ENV=test npm test -- test/routers/cback/chat-prompt.spec.js

# Run with E2E chat tests (requires Ollama)
NODE_ENV=test OLLAMA_E2E=1 npm test -- test/routers/cback/chat-prompt.spec.js
```

Requires MongoDB (test config uses `config.test.js`). The suite needs `chai` (added as a devDependency for the test globals).

## Adding more tests

- **Response checks:** `POST /cback/chat` with a fixed prompt, then assert on `res.body.reply` (substring, regex) or `res.body.commands`.
- **Model checks:** After a tool sequence (or after a chat that should have changed the model), call `run-tool` with `getMetaInfo` (or another tool that returns project state) and assert on `res.body.data`.

Example pattern for “prompt then check model” with real LLM:

1. `POST /chat` with `message: "Create a meta concept named X"` and `context: { projectId, branchName }`.
2. `POST /cback/test/run-tool` with `toolName: "getMetaInfo"`, `context: { projectId, branchName }`.
3. Assert `body.data.concepts` contains a concept with name/path for X.
