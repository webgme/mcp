# GMEBot / cback tools

List of tools exposed to the LLM, with status and short descriptions. Client command handlers live in [packages/gmebot/src/commands.ts](../../gmebot/src/commands.ts).

**Status legend**

| Status       | Meaning |
|-------------|--------|
| **Placeholder** | Tool exists and is callable; handler returns stub / "not implemented" or empty data. |
| **Implemented**  | Handler performs real work. Where it runs (server vs browser) is stated in the tool description when relevant. |
| **Verified**     | Tested manually or via tests (see [test/routers/cback/MANUAL_TESTS.md](../../../test/routers/cback/MANUAL_TESTS.md)). |

---

## Project tools

**Source:** [packages/cback/src/tools/project.ts](./project.ts)

| Tool | Status | Description |
|------|--------|-------------|
| **listSeeds** | Implemented | List the available project seeds (templates) that can be used when creating a new project. Runs on the server and reads from the WebGME seed configuration. |
| **createProject** | Implemented | Create a new WebGME project on the server, optionally tagging it with a requested seed. |
| **listProjects** | Implemented | Collect from WebGME the list of all projects the user has access to (read or write). |
| **switchProject** | Implemented | Switch the user's view to a different project (and optionally to a specific branch). |

---

## Branch tools

**Source:** [packages/cback/src/tools/branch.ts](./branch.ts)

Most branch tools are client-driven (they change or rely on client state). Only listBranches runs on the server.

| Tool | Status | Description |
|------|--------|-------------|
| **listBranches** | Implemented | List all branches in a project and their commit hashes. Runs on the server. Use projectId from context when omitted. |
| **createBranch** | Implemented | Create a new branch (on the server) and switch the view to it. fromCommitHash is optional and defaults to the current branch head from context. |
| **switchBranch** | Implemented | Switch the user's view to a different branch (same project). Executed in the browser. |
| **deleteBranch** | Implemented | Delete a branch and switch the view back to master. Master cannot be deleted. Server validates and resolves hash; delete and switch run in the browser. |
| **squashBranch** | Implemented | Squash commits on a branch from a given commit up to the branch head (hides intermediate history). Executed in the browser using the client's squash support. |

---

## Meta tools

**Source:** [packages/cback/src/tools/meta.ts](./meta.ts)

| Tool | Status | Description |
|------|--------|-------------|
| **createMetaSheet** | Implemented | Create a new meta aspect sheet on the project ROOT and append it to the MetaSheets registry. Runs on the server. |
| **switchToMetaSheet** | Implemented | Resolve a meta aspect sheet by SetID or title and return it along with all sheets. Server-side selection only; does not change the browser UI. |
| **deleteMetaSheet** | Implemented | Delete a meta aspect sheet: remove its set and registry entry, and for nodes that are no longer present on any named sheet, remove them from MetaAspectSet and clear all meta rules. Runs on the server. |
| **isMetaNode** | Implemented | Check if a node (by path) is a META node (member of the global MetaAspectSet). Useful when choosing bases for new concepts. |
| **createMetaNode** | Implemented | Create a new META concept under the project ROOT, based on an existing meta-node (default FCO), and add it to MetaAspectSet (and the first meta sheet if it exists). Runs on the server. |
| **setMetaAttribute** | Implemented | Define or update an attribute’s META rule for a concept (wraps core.setAttributeMeta). Runs on the server. |
| **delMetaAttribute** | Implemented | Remove an attribute's META rule from a concept (core.delAttributeMeta). Runs on the server. |
| **setMetaContainment** | Implemented | Define META-level containment: a concept can contain instances of another (core.setChildMeta), with optional min/max. One call per (source, target). Runs on the server. |
| **delMetaContainment** | Implemented | Remove a META containment rule (core.delChildMeta). sourcePath and targetPath required. Runs on the server. |
| **setMetaPointer** | Implemented | Define a META-level pointer on a concept (at most one target per instance). Adds a valid target type; uses setPointerMetaTarget/setPointerMetaLimits. Runs on the server. |
| **delMetaPointer** | Implemented | Remove a META-level pointer (or set) definition from a concept (core.delPointerMeta). conceptPath and pointerName required. Runs on the server. |
| **delMetaSet** | Implemented | Remove a META-level set definition from a concept (core.delPointerMeta). conceptPath and setName required. Runs on the server. |
| **setMetaSet** | Implemented | Define a META-level set on a concept (multiple targets). Adds a valid target type. Runs on the server. |
| **setMetaMixin** | Implemented | Add a META mixin to a concept (inherits from another type). One call per (conceptPath, mixinPath). Runs on the server. |
| **delMetaMixin** | Implemented | Remove a META mixin from a concept (core.delMember on _mixins). Runs on the server. |
| **checkMetaConsistency** | Implemented | Run WebGME meta-layer consistency check (core.getMixinErrors on meta concepts). Use after meta modifications. For checking that instance nodes obey the meta rules, use checkModelConsistency. |
| **checkModelConsistency** | Implemented | Run the constraint check on the project or a sub-tree: finds any element that violates the meta rules (containment, pointers, sets). Optional nodePath (default whole project) and includeChildren. After model changes, run for current scope using context.activeNodeId as nodePath. |
| **getMetaInfo** | Implemented | Return a JSON summary of the meta: all concepts in MetaAspectSet (using getJsonMeta) and all named sheets with their SetIDs and the concepts they contain. Runs on the server. |

---

## Node tools

**Source:** [packages/cback/src/tools/node.ts](./node.ts)

Node operations should run on the server when a project is open. Tools that still perform the operation only in the browser (no server-side node access) are noted below and should be implemented server-side.

| Tool | Status | Description |
|------|--------|-------------|
| **createNode** | Implemented | Create a new node in the model under a given parent, with an optional type (base). |
| **moveNode** | Implemented | Move a node to a different parent in the hierarchy. Currently performed in the browser only; server-side implementation pending. |
| **deleteNode** | Implemented | Remove a node and its descendants from the model. |
| **findNodesByName** | Implemented | Find all nodes whose name attribute matches a given string (optionally under a container). |
| **getPropertyNames** | Implemented | List the attribute and registry names for a node, and their current values. |
| **setAttribute** | Implemented | Set an attribute on a node to a given value. |
| **getAttribute** | Implemented | Read the current value of an attribute on a node. Currently performed in the browser (value shown in chat); server-side implementation pending. |
| **clearAttribute** | Implemented | Clear an attribute on a node so it falls back to the inherited value. |
| **setRegistry** | Implemented | Set a registry entry on a node to a given value. |
| **getRegistry** | Implemented | Read the current value of a registry entry on a node. Currently performed in the browser (value shown in chat); server-side implementation pending. |
| **clearRegistry** | Implemented | Clear a registry entry on a node. |

---

## State tools (client UI)

**Source:** [packages/cback/src/tools/state.ts](./state.ts)

These tools change only what the user sees in the browser (selection and visualizer). The operation runs in the browser by design; there is no server-side model to update.

| Tool | Status | Description |
|------|--------|-------------|
| **setClientState** | Implemented | Change the user's current selection to a given node and/or switch the visualizer panel (e.g. diagram, meta editor). Executed in the browser. Visualizer options come from the deployment config. |

---

## Tool registration

- All tools are combined in [packages/cback/src/tools.ts](../tools.ts). **Context-driven selection:** when the client sends `context.activeVisualizerId`, the LLM receives only a subset: project + branch + state tools always; if the visualizer is the Meta Editor (e.g. `METAAspect`) then meta tools are added; otherwise node tools are added. This reduces token use. With no context, all tools are sent. Handlers are in a full map so any tool call can still be executed.
- State tools are built with `gmeConfig` so visualizer enum comes from [Visualizers.json](../../../src/visualizers/Visualizers.json) and WebGME descriptors.
- Definitions are sent to the LLM via `getToolDefinitionsForLLM(gmeConfig, context)`; handlers are used in the cback router ([packages/cback/src/cback.ts](../cback.ts)).

---

## Possible additions (from TODOs / design)

- **Project:** Implement `listSeeds` (enumerate from storage/config), `createProject` (safeStorage + seed), validate `projectId` in `switchProject` before emitting command.
- **Branch:** listBranches (server), createBranch, switchBranch, deleteBranch, squashBranch (client-driven). Possible: validate branch names, optional projectId from context.
- **Meta:** listMetaNodes, createMetaNode, setMetaRule, getMetaRules.
- **Node:** Server-side implementation for `moveNode`, `getAttribute`, and `getRegistry` so that no node operation is performed in the client.
