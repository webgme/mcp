# Component Development Guide

This project uses npm workspaces (`packages/*`) and `webgme-cli` as the source of truth for registering components.

## Principles

- Always create/import/remove components via `webgme-cli` commands.
- Do not hand-edit `webgme-setup.json` or `config/config.webgme.js` (both are CLI-managed).
- Components implemented by this project go under `components` (not `dependencies`).
- Prefer TypeScript for authored code; build output goes to the standard `src/` paths that WebGME expects.

## TypeScript Strategy

Each component has a workspace package under `packages/` that holds the TypeScript source. The `tsconfig.json` in each package compiles directly into the standard WebGME directory structure under the root `src/` tree.

- **Routers**: `packages/<id>/src/<id>.ts` → `src/routers/<id>/<id>.js`
- **Widgets**: `packages/<name>/src/Widget.ts` → `src/visualizers/widgets/<Name>/Widget.js`

This way `webgme-setup.json` and `config/config.webgme.js` reference standard paths and require no manual overrides.

## Current Router: cback

- Registered as: `components.routers.cback`
- TypeScript source: `packages/cback/src/cback.ts`
- Compiled output: `src/routers/cback/cback.js`
- Mounted at: `/cback`
- Test endpoint: `GET /cback/test`

## Current Visualizer: GMEBot

- Registered as: `components.visualizers.GMEBot`
- TypeScript source: `packages/gmebot/src/Widget.ts`
- Compiled output: `src/visualizers/widgets/GMEBot/Widget.js` (AMD)
- Footer widget path: `widgets/GMEBot/Widget`
- Footer binding: `config/components.json` → `GenericUIFooterControlsPanel.extraWidgets`

## Standard Commands

- Create router: `npx webgme-cli new router <name>`
- Mount router: `npx webgme-cli mount <name> <endpoint>`
- Create visualizer: `npx webgme-cli new viz <name>`
- Remove component: `npx webgme-cli rm <type> <name>`
- Re-generate config: `npx webgme-cli refresh`
- List components: `npx webgme-cli ls`

## Build Commands

- Build all packages: `npm run build`
- Clean compiled output: `npm run clean`
- Build a single package: `npm run build --workspace=packages/<name>`

## Adding a New Component

1. Create with `webgme-cli` (e.g. `npx webgme-cli new router myrouter`)
2. Create a workspace package under `packages/<name>/` with `tsconfig.json` pointing `outDir` to the standard `src/` path
3. Write TypeScript source in `packages/<name>/src/`
4. Run `npm run build` — compiled JS appears where WebGME expects it

## Implementation Notes

- Keep authentication guard enabled using `ensureAuthenticated` for routers.
- Favor widget-first architecture for copilot UI integrations.
- Avoid direct backend secrets in browser code; call backend APIs only.
