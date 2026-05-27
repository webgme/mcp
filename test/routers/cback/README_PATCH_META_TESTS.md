# Testing `patchMetaDescriptor` via `run-tool`

Integration tests call **`POST /cback/test/run-tool`** (only when `NODE_ENV=test`) with the same handlers and `ToolContext` as chat. No LLM is involved.

Example spec: **`patch-meta-descriptor.spec.js`**. Shared helpers: **`helpers/runTool.js`**.

## Run

```bash
npm run build --workspace=packages/cback
NODE_ENV=test node ./node_modules/mocha/bin/mocha test/routers/cback/patch-meta-descriptor.spec.js
```

Use the direct `mocha` path (not `npm test -- …`) so only this spec runs — `npm test` uses `--recursive test` and starts every suite.

Requires MongoDB (WebGME test config).

---

## Anatomy of a test case

### 1. Base project and context

| Field | Purpose |
|--------|---------|
| `projectId` | Open WebGME project (creates `coreSession` on the server) |
| `branchName` | Usually `"master"` |
| `modelingMode` | Use `"metamodel"` for patch tests (matches GMEBot) |

Setup pattern:

```javascript
var h = require('./helpers/runTool');

before(function () {
  return h.ensureTestProject('MyUniqueProjectName').then(function (p) {
    ctx = h.metamodelContext(p.projectId, p.branchName);
  });
});
```

`ensureTestProject` picks an **openable** project: first `PatchMetaTestSeed` (EmptyProject seeded at server start via `config/config.test.js`), otherwise the first project in `listProjects` whose master commit loads. Raw `createProject` shells have no initial commit and cannot be patched.

### 2. Test input (`args`)

Only **`patch`**: an RFC 6902 array targeting the **map-based** MetaDescriptor:

```javascript
var patch = [
  { op: 'add', path: '/concepts/State', value: {} },
  { op: 'add', path: '/concepts/Transition', value: {} },
  {
    op: 'add',
    path: '/concepts/StateMachine',
    value: { contains: { State: '*', Transition: '*' } },
  },
  {
    op: 'add',
    path: '/relationships/Transition',
    value: { from: 'State', to: 'State' },
  },
];

h.runTool({
  toolName: 'patchMetaDescriptor',
  args: { patch: patch },
  context: ctx,
});
```

Rules reflected in tests:

- Concept names are plain identifiers (no `State:*` in the name).
- Cardinality lives in **`contains`** values (`"*"`, `"1"`, …).
- Link types need **`concepts.{Name}`** and **`relationships.{Name}`**.
- Main container **`contains`** must list **both** node and connection types.

Prefer **one patch with all ops** (matches production batching).

### 3. Request shape

```http
POST /cback/test/run-tool
Content-Type: application/json

{
  "toolName": "patchMetaDescriptor",
  "args": { "patch": [ ... ] },
  "context": {
    "projectId": "guest+PatchMetaFSMProject",
    "branchName": "master",
    "modelingMode": "metamodel"
  }
}
```

Response:

```json
{ "data": { "ok": true, "applied": ["..."], "warnings": [] }, "commands": [] }
```

On failure: HTTP 500 with `{ "error": "..." }` or `data.ok === false` / `data.error`.

---

## How expected output is checked

### Preferred — canonical MetaDescriptor fixture

The MetaDescriptor is the round-trip format (`buildMetaDescriptorFromCore` → `normalizeMetaDescriptor`). After a patch, read it back and compare to a JSON fixture:

```javascript
var EXPECTED = require('./fixtures/fsm-meta-descriptor.expected.json');

return h.runTool({ toolName: 'patchMetaDescriptor', args: { patch }, context: ctx })
  .then(function (patchRes) {
    expect(patchRes.data.ok).to.equal(true);
    return h.getMetaDescriptor(ctx);
  })
  .then(function (descriptor) {
    h.expectMetaDescriptor(descriptor, EXPECTED);
  });
```

`getMetaDescriptor` returns a **canonical** document: every concept-name list (`relationships.*.from/to`, `pointers.*`, enum `attributes.*.values`) is sorted (locale `en`), deduped, and single-element lists collapse to a string. Fixture comparison is order-stable.

Also assert `patchRes.data.ok` and optional `warnings` (Layer 1 — what the LLM sees).

### Legacy — getMetaInfo (WebGME shape)

If you need low-level WebGME details not captured in MetaDescriptor, use `getMetaInfo` and the path-resolution helpers (`containmentChildNames`, `pointerTargetNames`). Prefer fixture comparison when the descriptor is sufficient.

---

## Template for a new test

```javascript
it('your scenario', function () {
  if (!projectId) return this.skip();

  var patch = [ /* ops */ ];
  var expected = require('./fixtures/your-case.expected.json');

  return h.runTool({ toolName: 'patchMetaDescriptor', args: { patch }, context: ctx })
    .then(function (patchRes) {
      expect(patchRes.data.ok).to.equal(true);
      return h.getMetaDescriptor(ctx);
    })
    .then(function (descriptor) {
      h.expectMetaDescriptor(descriptor, expected);
    });
});
```

### Negative tests

Validation errors return HTTP 200 with `data.error` (handler does not throw):

```javascript
return h.runTool({ toolName: 'patchMetaDescriptor', args: { patch: [] }, context: ctx })
  .then(function (res) {
    expect(res.data.error).to.match(/non-empty/i);
  });
```

Sync failures may return `data.ok === false` with `data.error`, or HTTP 500 when `ensureCoreSession` fails (missing/invalid `projectId`).

Or assert `data.warnings` contains an audit message (e.g. missing `relationships`).

### Incremental patches

Use the **same project** in one `it` or separate `it`s with dependency order:

1. First patch: add concepts only → assert names exist.
2. Second patch: add `contains` / `relationships` → assert Layer 3.

Each `patchMetaDescriptor` call commits; context `projectId` stays the same.

---

## What not to assert in tool tests

- Do not parse chat `reply` text (use `run-tool` only for metamodel tests).
- Do not compare full MetaDescriptor in the **patch** tool response (it returns `{ ok, warnings? }` only). Use **`getMetaDescriptor`** for the oracle document.

For MetaDescriptor document logic without WebGME, add **unit tests** under `packages/cback` for `applyJsonPatch`, `normalizeMetaDescriptor`, `auditMetamodelStructure`.

---

## Related docs

- [README_PROMPT_TESTS.md](./README_PROMPT_TESTS.md) — general prompt/run-tool tests  
- [docs/testing-llm-smoke.md](../../../docs/testing-llm-smoke.md) — pyramid and optional LLM E2E
