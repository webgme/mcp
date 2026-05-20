# Chat context: what the client can send

The GMEBot widget sends a `context` object with each POST to `/cback/chat`. The backend uses it for defaults (project, branch, active node), **modeling mode** (which tools are exposed), and injects **MetaDescriptor** + **concept registry** (metamodel) or **object-list** (domain) into the system prompt when a project is open.

## Currently sent by the client

| Field | Source | Description |
|-------|--------|-------------|
| **projectId** | `client.getActiveProjectId()` | Current project (e.g. `owner+ProjectName`). |
| **branchName** | `client.getActiveBranchName()` | Current branch (e.g. `master`). |
| **activeNodeId** | `WebGMEGlobal.State.getActiveObject()` | Currently selected node (path/id). |
| **activeVisualizerId** | `WebGMEGlobal.State.getActiveVisualizer()` | Active visualizer id (e.g. `ModelEditor`, `METAAspect`, `GMEBot`). From `Visualizers.json` / deployment. |
| **activeTabId** | `WebGMEGlobal.State.getActiveTab()` | Active tab index (number). In the Meta Editor this is the **meta sheet index** (0-based) in the project’s MetaSheets registry. |
| **modelingMode** | GMEBot **Mode** toggle | `metamodel` or `domain`. Metamodel exposes only `patchMetaDescriptor`; domain hides all tools for now. |
| **objectList** | GMEBot staging (`existing` / `new` / `deleted`) | Client sends `{ name, path, guid }` per item. In **metamodel** mode the LLM sees only **names** via `[Concept registry]` (`existing` / `new` / `deleted` string arrays). Paths/guids are not exposed to the model. |

## WebGME State: what else is available

All of the following are readable from `WebGMEGlobal.State` (see `webgme/src/client/js/Utils/StateManager.js` and `WebGMEUrlManager.js`). Only the ones above are sent today; others could be added if needed.

| State getter | Type | Description |
|--------------|------|-------------|
| **getActiveObject()** | string | Active node id → sent as `activeNodeId`. |
| **getActiveSelection()** | string[] | Multi-selection node ids. Not sent; could be added as `activeSelection`. |
| **getActiveVisualizer()** | string | Visualizer id → sent as `activeVisualizerId`. |
| **getActiveTab()** | number | Tab index → sent as `activeTabId`. In Meta Editor = sheet index. |
| **getActiveProjectName()** | string | Project id (State mirror). We use `client.getActiveProjectId()` instead. |
| **getActiveBranch()** | string | Branch name (State uses this key; client may expose getActiveBranchName). |
| **getActiveCommit()** | string | Commit hash when viewing a specific commit. Not sent. |
| **getActiveAspect()** | string | Aspect name (e.g. `All`). Not sent. |
| **getLayout()** | string | Layout name. Not sent. |

## Meta sheet id

- **activeMetaSheetId** is **not** a first-class State key. When the user is in the Meta Editor:
  - `activeVisualizerId` is the meta visualizer id (e.g. `METAAspect`).
  - `activeTabId` is the **sheet index** (0, 1, …).
- The backend can derive the current sheet SetID by loading the project’s MetaSheets registry and taking `sheets[activeTabId].SetID` when `activeVisualizerId` is the meta editor.
- Optionally the client could compute and send `activeMetaSheetId` (SetID string) when in the Meta Editor by reading the panel’s selected sheet; that would require access to the Meta Editor panel from the GMEBot widget.

## Reference

- WebGME State: `node_modules/webgme/src/client/js/Utils/StateManager.js`
- URL serialization (state → query): `node_modules/webgme/src/client/js/Utils/WebGMEUrlManager.js` (`serializeStateToUrl` uses `getActiveObject`, `getActiveVisualizer`, `getActiveTab`, `getActiveSelection`).

---

## Continuation flow (client-only data: diagram layout)

When a tool needs data only the client has (e.g. **getDiagramLayout**), it returns `needClientData: 'diagramLayout'`. The backend then:

1. Returns a response with **no user-visible reply**: `reply: ""`, `continuation: true`, `requestClientData: { key: 'diagramLayout' }`.
2. Does **not** append the assistant/tool messages to history, so the next request continues from the last user message.

The client:

1. Sees `continuation === true` and `requestClientData.key`.
2. Collects layout with **getDiagramLayoutFromClient()**: gets the active panel via `WebGMEGlobal.PanelManager.getActivePanel()`, then the designer (`panel.control.designerCanvas` or `panel.control.diagramDesigner`). **Path resolution:** designer item IDs are mapped to actual node paths using `panel.control._ComponentID2GMEID` (and `_ComponentID2DocItemID` for meta doc items), so the backend receives real paths usable with setRegistry/bulkSet/setConceptLayout. Iterates `designer.itemIds` (boxes only), calls `getBoundingBox()` on each item. **Connectivity:** also iterates `designer.connectionIds` and `designer.connectionEndIDs` to collect `connections: [ { sourcePath, targetPath }, ... ]` (same path space as nodes).
3. Sends a **follow-up request** with a short continuation message (e.g. `"[Continuation: layout data provided.]"`), `continuation: true`, and **context** extended with `diagramLayout` (shape: `{ nodes: [ { path, x, y, width?, height? }, ... ], connections?: [ { sourcePath, targetPath }, ... ] }`).

The backend treats the follow-up as a normal chat request with enriched context; **getDiagramLayout** then reads from `context.diagramLayout` and returns the data. The user only sees the final reply after the continuation round-trip.

- **Single tool:** **getDiagramLayout** (in both node and meta tool sets); key **diagramLayout**; client **getDiagramLayoutFromClient()** reads from the active diagram widget. Node **path** is the resolved WebGME path (or meta doc-item id); **connections** (optional) list edges by sourcePath/targetPath for connectivity context.
