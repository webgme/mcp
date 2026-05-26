"use strict";
/**
 * MetaDescriptor (compact metamodel document) ↔ WebGME core.
 * See docs/schemas/meta-descriptor.schema.json
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DISCOURAGED_MAIN_CONTAINER_NAMES = exports.FCO_INHERITED_ATTRIBUTES = exports.FCO_CONCEPT_NAME = void 0;
exports.stripInheritedAttributes = stripInheritedAttributes;
exports.isFcoConceptName = isFcoConceptName;
exports.isValidConceptName = isValidConceptName;
exports.resolveConceptName = resolveConceptName;
exports.normalizeMetaDescriptor = normalizeMetaDescriptor;
exports.listConceptNames = listConceptNames;
exports.getConcept = getConcept;
exports.iterConcepts = iterConcepts;
exports.buildConceptRegistryFromObjectList = buildConceptRegistryFromObjectList;
exports.buildConceptRegistryFromCore = buildConceptRegistryFromCore;
exports.normalizeMetaPatchOps = normalizeMetaPatchOps;
exports.applyJsonPatch = applyJsonPatch;
exports.buildMetaDescriptorFromCore = buildMetaDescriptorFromCore;
exports.buildObjectListFromCore = buildObjectListFromCore;
exports.collectRelationshipSpecs = collectRelationshipSpecs;
exports.auditMetamodelStructure = auditMetamodelStructure;
exports.syncMetaDescriptorPatch = syncMetaDescriptorPatch;
const metaCoreOps_1 = require("./metaCoreOps");
exports.FCO_CONCEPT_NAME = "FCO";
/** Attribute meta inherited from FCO — do not redefine on domain concepts. */
exports.FCO_INHERITED_ATTRIBUTES = ["name"];
const CONCEPT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
function stripInheritedAttributes(attrs) {
    if (!attrs || typeof attrs !== "object")
        return { stripped: [] };
    const stripped = [];
    const out = { ...attrs };
    for (const key of exports.FCO_INHERITED_ATTRIBUTES) {
        if (Object.prototype.hasOwnProperty.call(out, key)) {
            stripped.push(key);
            delete out[key];
        }
    }
    return {
        attributes: Object.keys(out).length ? out : undefined,
        stripped,
    };
}
function sanitizeConceptBodyAttributes(body) {
    if (!body.attributes)
        return [];
    const { attributes, stripped } = stripInheritedAttributes(body.attributes);
    if (attributes)
        body.attributes = attributes;
    else
        delete body.attributes;
    return stripped;
}
function isFcoConceptName(name) {
    return String(name !== null && name !== void 0 ? name : "").trim().toUpperCase() === exports.FCO_CONCEPT_NAME;
}
function isValidConceptName(name) {
    const s = String(name !== null && name !== void 0 ? name : "").trim();
    if (!s || isFcoConceptName(s))
        return false;
    if (s.includes("/"))
        return false;
    return CONCEPT_NAME_PATTERN.test(s);
}
/** Resolve map key to a valid concept name; reject cardinality-in-name mistakes. */
function resolveConceptName(key) {
    const trimmed = String(key !== null && key !== void 0 ? key : "").trim();
    if (isValidConceptName(trimmed))
        return { name: trimmed };
    const parsed = (0, metaCoreOps_1.parseTargetRef)(trimmed);
    if (parsed.name && isValidConceptName(parsed.name) && trimmed !== parsed.name) {
        return {
            name: parsed.name,
            warning: 'Concept name "' +
                trimmed +
                '" is invalid — cardinality belongs in contains (e.g. contains.State = "*"), not in the concept name.',
        };
    }
    return {
        name: trimmed,
        warning: 'Invalid concept name "' +
            trimmed +
            '". Use a plain identifier (letters, digits, underscore). No *, :, +, or ? in names.',
    };
}
function cardinalityFromParsed(parsed) {
    const { min, max } = parsed;
    if (min === 0 && max === 1)
        return "0..1";
    if (min === 1 && max === 1)
        return "1";
    if (max === -1 && min === 0)
        return "*";
    if (max === -1 && min === 1)
        return "+";
    if (max === -1)
        return "*";
    if (typeof min === "number" && typeof max === "number" && min === max)
        return String(min);
    if (typeof min === "number" && typeof max === "number")
        return min + ".." + max;
    return "*";
}
function migrateContainsToMap(contains) {
    if (!contains)
        return undefined;
    if (contains && typeof contains === "object" && !Array.isArray(contains)) {
        return contains;
    }
    if (!Array.isArray(contains))
        return undefined;
    const out = {};
    for (const ref of contains) {
        const parsed = (0, metaCoreOps_1.parseTargetRef)(String(ref));
        if (parsed.name)
            out[parsed.name] = cardinalityFromParsed(parsed);
    }
    return Object.keys(out).length ? out : undefined;
}
function migrateConceptBody(body) {
    if (!body || typeof body !== "object")
        return {};
    const b = { ...body };
    delete b.name;
    if (b.contains)
        b.contains = migrateContainsToMap(b.contains);
    sanitizeConceptBodyAttributes(b);
    return b;
}
/** Accept v1 map form or legacy array form; always return map-based descriptor. */
function normalizeMetaDescriptor(raw) {
    const d = raw;
    if (!d || d.version !== 1) {
        throw new Error("MetaDescriptor version must be 1");
    }
    const concepts = {};
    const warnings = [];
    if (Array.isArray(d.concepts)) {
        for (const entry of d.concepts) {
            const key = (entry === null || entry === void 0 ? void 0 : entry.name) != null ? String(entry.name) : "";
            const resolved = resolveConceptName(key);
            if (resolved.warning)
                warnings.push(resolved.warning);
            if (!isValidConceptName(resolved.name))
                continue;
            concepts[resolved.name] = migrateConceptBody(entry);
        }
    }
    else if (d.concepts && typeof d.concepts === "object") {
        for (const [key, body] of Object.entries(d.concepts)) {
            const resolved = resolveConceptName(key);
            if (resolved.warning)
                warnings.push(resolved.warning);
            if (!isValidConceptName(resolved.name))
                continue;
            concepts[resolved.name] = migrateConceptBody(body);
        }
    }
    const relationships = {};
    const rels = d.relationships;
    if (Array.isArray(rels)) {
        for (const rel of rels) {
            if (typeof rel === "string") {
                const m = rel.match(/^([^:]+):\s*(.+?)\s*->\s*(.+)$/);
                if (!m)
                    continue;
                const rname = resolveConceptName(m[1].trim());
                if (!isValidConceptName(rname.name))
                    continue;
                relationships[rname.name] = { from: m[2].trim(), to: m[3].trim() };
            }
            else if (rel && typeof rel === "object" && rel.name) {
                const ro = rel;
                const rname = resolveConceptName(ro.name);
                if (!isValidConceptName(rname.name))
                    continue;
                relationships[rname.name] = { from: ro.from, to: ro.to };
            }
        }
    }
    else if (rels && typeof rels === "object") {
        for (const [key, body] of Object.entries(rels)) {
            const rname = resolveConceptName(key);
            if (rname.warning)
                warnings.push(rname.warning);
            if (!isValidConceptName(rname.name))
                continue;
            if (body && typeof body === "object") {
                relationships[rname.name] = { from: body.from, to: body.to };
            }
        }
    }
    for (const conceptName of Object.keys(concepts)) {
        const stripped = sanitizeConceptBodyAttributes(concepts[conceptName]);
        for (const attr of stripped) {
            warnings.push('Removed attributes.' +
                attr +
                ' from concept "' +
                conceptName +
                '" — inherited from FCO; do not add it in patches.');
        }
    }
    const descriptor = { version: 1, concepts };
    if (Object.keys(relationships).length)
        descriptor.relationships = relationships;
    if (warnings.length)
        descriptor._normalizeWarnings = warnings;
    return descriptor;
}
function listConceptNames(descriptor) {
    return Object.keys(descriptor.concepts || {}).sort();
}
function getConcept(descriptor, name) {
    const body = descriptor.concepts[name];
    if (!body)
        return undefined;
    return { name, ...body };
}
function iterConcepts(descriptor) {
    return listConceptNames(descriptor).map((name) => ({ name, ...descriptor.concepts[name] }));
}
function namesFromItems(items) {
    var _a;
    if (!Array.isArray(items))
        return [];
    const out = [];
    for (const item of items) {
        const name = String((_a = item === null || item === void 0 ? void 0 : item.name) !== null && _a !== void 0 ? _a : "").trim();
        if (name && !isFcoConceptName(name))
            out.push(name);
    }
    return out;
}
function buildConceptRegistryFromObjectList(list) {
    return {
        existing: namesFromItems(list.existing),
        new: namesFromItems(list.new),
        deleted: namesFromItems(list.deleted),
    };
}
function buildConceptRegistryFromCore(core, root, clientList) {
    return buildConceptRegistryFromObjectList(buildObjectListFromCore(core, root, clientList));
}
function decodePointerSegment(seg) {
    return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}
function parsePointer(path) {
    if (!path || path === "/")
        return [];
    const raw = path.startsWith("/") ? path.slice(1) : path;
    if (!raw)
        return [];
    return raw.split("/").map(decodePointerSegment);
}
function getAtPointer(root, path) {
    const parts = parsePointer(path);
    let cur = root;
    for (const p of parts) {
        if (cur == null)
            return undefined;
        if (Array.isArray(cur)) {
            const idx = p === "-" ? cur.length : Number(p);
            cur = cur[idx];
        }
        else {
            cur = cur[p];
        }
    }
    return cur;
}
function setAtPointer(root, path, value) {
    const parts = parsePointer(path);
    if (parts.length === 0) {
        throw new Error("Cannot replace document root");
    }
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur[p] === undefined) {
            const next = parts[i + 1];
            cur[p] = next !== undefined && String(Number(next)) === next ? [] : {};
        }
        cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (Array.isArray(cur) && last === "-") {
        cur.push(value);
        return;
    }
    if (Array.isArray(cur)) {
        cur[Number(last)] = value;
        return;
    }
    cur[last] = value;
}
function removeAtPointer(root, path) {
    const parts = parsePointer(path);
    if (parts.length === 0)
        throw new Error("Cannot remove document root");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = cur[parts[i]];
        if (cur == null)
            return;
    }
    const last = parts[parts.length - 1];
    if (Array.isArray(cur)) {
        cur.splice(Number(last), 1);
        return;
    }
    delete cur[last];
}
const PATCH_ROOT_KEYS = new Set(["concepts", "relationships", "version"]);
/**
 * Fix common LLM path mistakes before apply (e.g. /StateMachine/contains/State → /concepts/StateMachine/contains/State).
 */
function normalizeMetaPatchOps(patch) {
    const rewrites = [];
    const out = [];
    for (const op of patch) {
        if (!op || typeof op.path !== "string") {
            out.push(op);
            continue;
        }
        let path = op.path;
        const containShorthand = /^\/([^/]+)\/contains\/([^/]+)$/.exec(path);
        if (containShorthand) {
            const head = containShorthand[1];
            if (!PATCH_ROOT_KEYS.has(head)) {
                const fixed = "/concepts/" + head + "/contains/" + containShorthand[2];
                rewrites.push(path + " → " + fixed);
                path = fixed;
            }
        }
        if ((op.op === "add" || op.op === "replace") &&
            /^\/[A-Za-z][A-Za-z0-9_]*$/.test(path)) {
            const name = path.slice(1);
            if (!PATCH_ROOT_KEYS.has(name)) {
                const fixed = "/concepts/" + name;
                rewrites.push(path + " → " + fixed);
                path = fixed;
            }
        }
        out.push({ ...op, path });
    }
    return { patch: out, rewrites };
}
/** Turn replace into add when the target path is missing (common after partial applies). */
function coerceReplaceToAdd(document, patch) {
    const coerced = [];
    const out = patch.map((op) => {
        if (op.op === "replace" && getAtPointer(document, op.path) === undefined) {
            coerced.push("replace → add at " + op.path);
            return { ...op, op: "add" };
        }
        return op;
    });
    return { patch: out, coerced };
}
/** RFC 6902 subset; normalizes to map-based descriptor after apply. */
function applyJsonPatch(document, patch) {
    const doc = JSON.parse(JSON.stringify(document));
    for (const op of patch) {
        if (!op || typeof op.path !== "string") {
            throw new Error("Invalid patch operation: missing path");
        }
        switch (op.op) {
            case "add":
            case "replace":
                if (op.op === "replace" && getAtPointer(doc, op.path) === undefined) {
                    throw new Error("replace target missing at " + op.path);
                }
                setAtPointer(doc, op.path, op.value);
                break;
            case "remove":
                removeAtPointer(doc, op.path);
                break;
            case "test": {
                const cur = getAtPointer(doc, op.path);
                if (JSON.stringify(cur) !== JSON.stringify(op.value)) {
                    throw new Error("test failed at " + op.path);
                }
                break;
            }
            default:
                throw new Error("Unsupported patch op: " + op.op);
        }
    }
    return normalizeMetaDescriptor(doc);
}
function metaChildrenToContains(children) {
    var _a;
    if (!children || !Array.isArray(children.items))
        return undefined;
    const out = {};
    for (const item of children.items) {
        const name = (_a = item === null || item === void 0 ? void 0 : item.name) !== null && _a !== void 0 ? _a : item === null || item === void 0 ? void 0 : item.id;
        if (!name)
            continue;
        const min = typeof item.min === "number" ? item.min : undefined;
        const max = typeof item.max === "number" ? item.max : undefined;
        out[String(name)] = cardinalityFromParsed({ min, max });
    }
    return Object.keys(out).length ? out : undefined;
}
function metaPointersToRecord(pointers) {
    if (!pointers || typeof pointers !== "object")
        return undefined;
    const out = {};
    for (const key of Object.keys(pointers)) {
        if (key === "src" || key === "dst")
            continue;
        const p = pointers[key];
        const items = p === null || p === void 0 ? void 0 : p.items;
        if (!Array.isArray(items))
            continue;
        const names = items.map((it) => { var _a; return (_a = it === null || it === void 0 ? void 0 : it.name) !== null && _a !== void 0 ? _a : it === null || it === void 0 ? void 0 : it.id; }).filter(Boolean);
        if (names.length === 1)
            out[key] = names[0];
        else if (names.length > 1)
            out[key] = names;
    }
    return Object.keys(out).length ? out : undefined;
}
function baseConceptName(core, node, root) {
    if (typeof core.getBase === "function") {
        const base = core.getBase(node);
        if (base && core.getPath(base) !== core.getPath(root)) {
            const n = core.getAttribute(base, "name");
            if (n != null && String(n).trim())
                return String(n).trim();
        }
    }
    return "FCO";
}
function buildMetaDescriptorFromCore(core, root) {
    var _a, _b, _c, _d, _e;
    const metaDict = core.getAllMetaNodes(root) || {};
    const concepts = {};
    const relationships = {};
    for (const path of Object.keys(metaDict).sort()) {
        const node = metaDict[path];
        if (!node)
            continue;
        const name = String((_a = core.getAttribute(node, "name")) !== null && _a !== void 0 ? _a : "").trim();
        if (!name || isFcoConceptName(name) || !isValidConceptName(name))
            continue;
        let meta = {};
        try {
            meta = core.getJsonMeta(node) || {};
        }
        catch {
            meta = {};
        }
        const body = {};
        const baseName = baseConceptName(core, node, root);
        if (!isFcoConceptName(baseName))
            body.extends = baseName;
        const contains = metaChildrenToContains(meta.children);
        if (contains)
            body.contains = contains;
        const pointers = metaPointersToRecord(meta.pointers);
        if (pointers)
            body.pointers = pointers;
        if (meta.attributes && typeof meta.attributes === "object") {
            const attrs = {};
            for (const k of Object.keys(meta.attributes)) {
                if (exports.FCO_INHERITED_ATTRIBUTES.includes(k))
                    continue;
                const a = meta.attributes[k];
                if (a && typeof a === "object" && a.type) {
                    attrs[k] = a.type === "string" && !a.multiline ? "string" : a;
                }
            }
            if (Object.keys(attrs).length)
                body.attributes = attrs;
        }
        const ptr = meta.pointers;
        if (ptr && (ptr.src || ptr.dst)) {
            const fromItems = (_c = (_b = ptr.src) === null || _b === void 0 ? void 0 : _b.items) !== null && _c !== void 0 ? _c : [];
            const toItems = (_e = (_d = ptr.dst) === null || _d === void 0 ? void 0 : _d.items) !== null && _e !== void 0 ? _e : [];
            const fromNames = fromItems.map((it) => { var _a; return (_a = it === null || it === void 0 ? void 0 : it.name) !== null && _a !== void 0 ? _a : it === null || it === void 0 ? void 0 : it.id; }).filter(Boolean);
            const toNames = toItems.map((it) => { var _a; return (_a = it === null || it === void 0 ? void 0 : it.name) !== null && _a !== void 0 ? _a : it === null || it === void 0 ? void 0 : it.id; }).filter(Boolean);
            if (fromNames.length && toNames.length) {
                relationships[name] = {
                    from: fromNames.length === 1 ? fromNames[0] : fromNames,
                    to: toNames.length === 1 ? toNames[0] : toNames,
                };
            }
        }
        concepts[name] = body;
    }
    const descriptor = { version: 1, concepts };
    if (Object.keys(relationships).length)
        descriptor.relationships = relationships;
    return descriptor;
}
function buildObjectListFromCore(core, root, clientList) {
    var _a;
    const metaDict = core.getAllMetaNodes(root) || {};
    const existing = [];
    for (const path of Object.keys(metaDict).sort()) {
        const node = metaDict[path];
        if (!node)
            continue;
        const name = String((_a = core.getAttribute(node, "name")) !== null && _a !== void 0 ? _a : "").trim();
        if (!name || isFcoConceptName(name))
            continue;
        const guid = typeof core.getGuid === "function"
            ? String(core.getGuid(node))
            : path;
        existing.push({ name, path, guid });
    }
    return {
        existing,
        new: Array.isArray(clientList === null || clientList === void 0 ? void 0 : clientList.new) ? clientList.new : [],
        deleted: Array.isArray(clientList === null || clientList === void 0 ? void 0 : clientList.deleted) ? clientList.deleted : [],
    };
}
function relationshipSpecKey(spec) {
    return spec.name + "|" + JSON.stringify(spec.from) + "|" + JSON.stringify(spec.to);
}
function collectRelationshipSpecs(descriptor) {
    var _a, _b;
    const specs = [];
    const seen = new Set();
    const push = (spec) => {
        const key = relationshipSpecKey(spec);
        if (seen.has(key))
            return;
        seen.add(key);
        specs.push(spec);
    };
    for (const [name, rel] of Object.entries(descriptor.relationships || {})) {
        const rname = resolveConceptName(name);
        if (!isValidConceptName(rname.name))
            continue;
        if (rel && typeof rel === "object")
            push({ name: rname.name, from: rel.from, to: rel.to });
    }
    for (const concept of iterConcepts(descriptor)) {
        const src = (_a = concept.pointers) === null || _a === void 0 ? void 0 : _a.src;
        const dst = (_b = concept.pointers) === null || _b === void 0 ? void 0 : _b.dst;
        if (src === undefined && dst === undefined)
            continue;
        push({
            name: concept.name,
            from: src === undefined ? [] : src,
            to: dst === undefined ? [] : dst,
        });
    }
    return specs;
}
function containsMapDelta(before, after) {
    const b = before || {};
    const a = after || {};
    const added = [];
    const removed = [];
    for (const key of Object.keys(a)) {
        if (!(key in b) || b[key] !== a[key]) {
            added.push({ child: key, cardinality: String(a[key]) });
        }
    }
    for (const key of Object.keys(b)) {
        if (!(key in a))
            removed.push(key);
    }
    return { added, removed };
}
/** Concepts that should not be used as the main model container (use a domain name instead). */
exports.DISCOURAGED_MAIN_CONTAINER_NAMES = [
    "Diagram",
    "Canvas",
    "Model",
    "Root",
    "ConnectionName",
    "Connector",
    "Link",
    "Edge",
];
/** Placeholder names — use the real link type (e.g. Transition) instead. */
const PLACEHOLDER_CONCEPT_NAMES = new Set(["ConnectionName", "Connector", "Link", "Edge", "Relationship"].map((s) => s.toLowerCase()));
function listContainerConcepts(descriptor) {
    return listConceptNames(descriptor).filter((n) => {
        var _a;
        const c = (_a = descriptor.concepts[n]) === null || _a === void 0 ? void 0 : _a.contains;
        return c && Object.keys(c).length > 0;
    });
}
function childToContainers(descriptor) {
    var _a;
    const map = new Map();
    for (const container of listContainerConcepts(descriptor)) {
        for (const child of Object.keys(descriptor.concepts[container].contains)) {
            const list = (_a = map.get(child)) !== null && _a !== void 0 ? _a : [];
            list.push(container);
            map.set(child, list);
        }
    }
    return map;
}
/** Structural checks returned as warnings (also guides the LLM via tool response). */
function auditMetamodelStructure(descriptor) {
    const warnings = [];
    const conceptNames = listConceptNames(descriptor);
    const relSpecs = collectRelationshipSpecs(descriptor);
    const relNames = new Set(relSpecs.map((s) => s.name));
    const containedIn = childToContainers(descriptor);
    const containers = listContainerConcepts(descriptor);
    for (const spec of relSpecs) {
        if (!descriptor.concepts[spec.name]) {
            warnings.push('relationships.' +
                spec.name +
                " requires concepts." +
                spec.name +
                ' — add an empty concept: { "' +
                spec.name +
                '": {} } (extends FCO by default).');
        }
    }
    for (const relName of relNames) {
        if (!containedIn.has(relName)) {
            const containerHint = containers.length === 1
                ? containers[0]
                : containers[0] || "StateMachine";
            warnings.push('Connection concept "' +
                relName +
                '" must be in the main container contains map (e.g. ' +
                containerHint +
                '.contains.' +
                relName +
                ' = "*") or it cannot be instantiated.');
        }
    }
    for (const spec of relSpecs) {
        const ends = [];
        const from = spec.from;
        const to = spec.to;
        if (Array.isArray(from))
            ends.push(...from);
        else if (from)
            ends.push(from);
        if (Array.isArray(to))
            ends.push(...to);
        else if (to)
            ends.push(to);
        for (const end of ends) {
            if (!isValidConceptName(end) || isFcoConceptName(end))
                continue;
            if (!descriptor.concepts[end]) {
                warnings.push('relationships.' +
                    spec.name +
                    ' references "' +
                    end +
                    '" but concepts.' +
                    end +
                    " is missing.");
            }
            else if (!containedIn.has(end)) {
                const containerHint = containers[0] || "StateMachine";
                warnings.push('Node type "' +
                    end +
                    '" should be in ' +
                    containerHint +
                    ".contains (needed to place instances on the model).");
            }
        }
    }
    if (conceptNames.length >= 2 && containers.length === 0) {
        warnings.push("Add a **main container** concept named for the domain (e.g. StateMachine, Workflow) with a contains map — not a generic name like Diagram.");
    }
    for (const name of conceptNames) {
        if (exports.DISCOURAGED_MAIN_CONTAINER_NAMES.includes(name)) {
            warnings.push('Avoid concept "' +
                name +
                '" — use a domain-specific **main container** name (e.g. StateMachine). It acts as the diagram but should match the model.');
        }
        if (PLACEHOLDER_CONCEPT_NAMES.has(name.toLowerCase()) && !relNames.has(name)) {
            warnings.push('Replace placeholder concept "' +
                name +
                '" with the real link type (e.g. Transition) and add relationships.Transition plus contains.Transition on the main container.');
        }
    }
    if (containers.length > 1) {
        warnings.push("Multiple concepts define contains (" +
            containers.join(", ") +
            ") — prefer one main container listing all instantiable types (nodes and connections).");
    }
    return warnings;
}
function hasMainContainer(descriptor) {
    return listContainerConcepts(descriptor).length > 0;
}
async function syncMetaDescriptorPatch(core, root, before, patch, commit) {
    const beforeNorm = normalizeMetaDescriptor(before);
    const { patch: pathFixed, rewrites } = normalizeMetaPatchOps(patch);
    const { patch: coercedPatch, coerced } = coerceReplaceToAdd(beforeNorm, pathFixed);
    const after = applyJsonPatch(beforeNorm, coercedPatch);
    const applied = [];
    const warnings = [];
    if (rewrites.length) {
        warnings.push("Patch paths were corrected server-side (always use /concepts/Name and /concepts/Container/contains/Child): " +
            rewrites.join("; "));
    }
    if (coerced.length) {
        warnings.push("Replace operations coerced to add where missing: " + coerced.join("; "));
    }
    const normExtra = after._normalizeWarnings;
    if (normExtra)
        warnings.push(...normExtra);
    const beforeNames = new Set(listConceptNames(beforeNorm));
    const afterNames = listConceptNames(after);
    for (const name of afterNames) {
        if (beforeNames.has(name))
            continue;
        const concept = getConcept(after, name);
        if (!isValidConceptName(name)) {
            warnings.push("skipped invalid concept name: " + name);
            continue;
        }
        const attrStripped = sanitizeConceptBodyAttributes(concept);
        for (const attr of attrStripped) {
            warnings.push('Ignored attributes.' + attr + " on " + name + " (inherited from FCO)");
        }
        try {
            const { path, warnings: w } = await (0, metaCoreOps_1.createMetaConceptInCore)(core, root, concept);
            warnings.push(...w);
            applied.push("created concept " + name);
        }
        catch (e) {
            warnings.push("create " + name + ": " + ((e && e.message) || String(e)));
        }
    }
    const beforeRelKeys = new Set(collectRelationshipSpecs(beforeNorm).map(relationshipSpecKey));
    for (const spec of collectRelationshipSpecs(after)) {
        const key = relationshipSpecKey(spec);
        if (beforeRelKeys.has(key))
            continue;
        const w = await (0, metaCoreOps_1.applyRelationshipPointersInCore)(core, root, spec.name, spec.from, spec.to);
        warnings.push(...w);
        if (w.length === 0) {
            applied.push("relationship " +
                spec.name +
                " (" +
                (Array.isArray(spec.from) ? spec.from.join("|") : spec.from) +
                " -> " +
                (Array.isArray(spec.to) ? spec.to.join("|") : spec.to) +
                ")");
        }
    }
    for (const name of afterNames) {
        const concept = getConcept(after, name);
        const prev = beforeNames.has(name)
            ? getConcept(beforeNorm, name)
            : { name, contains: undefined };
        const cd = containsMapDelta(prev.contains, concept.contains);
        for (const { child, cardinality } of cd.added) {
            if (!isValidConceptName(child)) {
                warnings.push("contains: invalid child name '" + child + "' on " + name + " (use contains map keys, not State:*)");
                continue;
            }
            const ref = (0, metaCoreOps_1.formatContainmentRef)(child, cardinality);
            const w = await (0, metaCoreOps_1.applyContainmentInCore)(core, root, name, ref);
            warnings.push(...w);
            if (w.length === 0)
                applied.push("containment " + name + "." + child + " = " + cardinality);
        }
        for (const child of cd.removed) {
            warnings.push("removing containment via patch not implemented: " + name + " -/ " + child);
        }
        const prevPtr = prev.pointers || {};
        const nextPtr = concept.pointers || {};
        const ptrNames = new Set([...Object.keys(prevPtr), ...Object.keys(nextPtr)]);
        for (const pn of ptrNames) {
            if (pn === "src" || pn === "dst")
                continue;
            const b = prevPtr[pn];
            const a = nextPtr[pn];
            if (JSON.stringify(b) === JSON.stringify(a))
                continue;
            if (a === undefined) {
                warnings.push("removing pointer via patch not implemented: " + name + "." + pn);
                continue;
            }
            const targets = Array.isArray(a) ? a : [a];
            for (const t of targets) {
                const found = await (0, metaCoreOps_1.findMetaConceptByName)(core, root, name);
                if (!found)
                    break;
                const targetNode = await (0, metaCoreOps_1.findMetaConceptByName)(core, root, String(t));
                if (!targetNode) {
                    warnings.push("pointer " + pn + ": target not found '" + t + "'");
                    continue;
                }
                try {
                    core.setPointerMetaLimits(found.node, pn, 1, 1);
                    core.setPointerMetaTarget(found.node, pn, targetNode.node, 1, 1);
                    applied.push("pointer " + name + "." + pn + " -> " + t);
                }
                catch (e) {
                    warnings.push("pointer " + name + "." + pn + ": " + ((e === null || e === void 0 ? void 0 : e.message) || String(e)));
                }
            }
        }
    }
    for (const name of listConceptNames(beforeNorm)) {
        if (after.concepts[name])
            continue;
        const found = await (0, metaCoreOps_1.findMetaConceptByName)(core, root, name);
        if (!found) {
            warnings.push("remove " + name + ": not found in core");
            continue;
        }
        core.delMember(root, metaCoreOps_1.META_ASPECT_SET_NAME, found.path);
        if (typeof core.setMeta === "function") {
            core.setMeta(found.node, {});
        }
        applied.push("removed concept " + name + " from MetaAspectSet");
        warnings.push("removed concept node " + name + " may still exist as instance; full delete not implemented");
    }
    warnings.push(...auditMetamodelStructure(after));
    if (afterNames.length >= 2 && collectRelationshipSpecs(after).length === 0) {
        warnings.push("No relationships — each link type needs concepts.Transition = {} and relationships.Transition = { from, to }.");
    }
    if (!hasMainContainer(after) && afterNames.length >= 2) {
        warnings.push("No main container — add concepts.StateMachine with contains listing every node and connection type (e.g. State, Transition).");
    }
    if (applied.length > 0) {
        await commit("GMEBot: patchMetaDescriptor");
    }
    return {
        metaDescriptor: buildMetaDescriptorFromCore(core, root),
        applied,
        warnings,
    };
}
