# webgme-mcp

WebGME app with monorepo-managed extension packages.

## Prerequisites

- [Node.js](https://nodejs.org/en/) (LTS recommended)
- [MongoDB](https://www.mongodb.com/)

## Installation

1. Start MongoDB locally (`mongod`).
2. Install dependencies from the repository root:
   - `npm install`
3. Build all packages:
   - `npm run build`

## Run the app

- Start WebGME from the repository root:
  - `npm start` (loads `.env` if present via Node `--env-file-if-exists`)
  - Or pass any file explicitly: `node --env-file=./path/to.env app.js`
- Open:
  - `http://localhost:8888`

### Configuration and deployment

- WebGME loads **`config/config.<NODE_ENV>.js`** (see **`config/README.md`**). Example: **`NODE_ENV=jarvis`** uses `config.jarvis.js` (MongoDB URI for that stack).
- **`LLM_*`** in `.env` (see **`.env.example`**; use **`.env.<profile>.example`** when it matches **`config.<profile>.js`**, e.g. **`.env.jarvis.example`**). Do not commit API keys.
- WebGME can still apply **`WEBGME_*`** overrides from the environment (see `config/index.js`).

## Monorepo Workflow

This repository uses npm workspaces (`packages/*`). Each component has a TypeScript source package that compiles directly into the standard `src/` paths WebGME expects. Components are registered via `webgme-cli`.

### Useful commands

- Build all packages: `npm run build`
- Clean compiled output: `npm run clean`
- Refresh generated WebGME config: `npx webgme-cli refresh`
- List recognized WebGME components: `npx webgme-cli ls`

### cback quick check

- Endpoint: `GET /cback/test`
- Full local URL after login: `http://localhost:8888/cback/test`

## Package List

- `webgme-cback` (`packages/cback`)
  - TypeScript router package
  - Source: `src/cback.ts` → compiles to `src/routers/cback/cback.js`
- `webgme-gmebot` (`packages/gmebot`)
  - TypeScript widget package
  - Source: `src/Widget.ts` → compiles to `src/visualizers/widgets/GMEBot/Widget.js` (AMD)
  - Added to footer via `config/components.json` (`GenericUIFooterControlsPanel.extraWidgets`)

## Footer Widget Configuration

`GMEBot` is attached to the generic footer panel using component settings in `config/components.json`:

- `GenericUIFooterControlsPanel.extraWidgets.GMEBotWidget.path = "widgets/GMEBot/Widget"`
