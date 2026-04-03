# WebGME configuration

On startup, `config/index.js` loads **`config/config.<NODE_ENV>.js`**. If `NODE_ENV` is unset, it loads **`config.default.js`**.

Set the profile from a **`.env`** file (optional) — see root **`.env.example`**. Then run `npm start` (the start script uses Node’s `--env-file-if-exists=.env`).

Optional **cback** LLM variables: **`LLM_*`** (see **`.env.example`** and **`packages/cback/src/llmAdapter.ts`**). Set them in `.env`, not in `config/*.js` unless your platform injects env only.

## Profiles in this repo

| File | Purpose |
|------|--------|
| `config.default.js` | Local development (default when `NODE_ENV` is unset). |
| `config.test.js` | Test suite (`NODE_ENV=test`). |
| `config.jarvis.js` | Deployment: **`mongodb://mongodb:27017/webgme_mcp`** only; use **`NODE_ENV=jarvis`**. |
| `config.webgme.js` | Generated WebGME component paths; required by the profiles above. |

After the profile loads, WebGME can still merge **`WEBGME_*`** variables from the environment (see `webgme-engine/config/overridefromenv.js`).
