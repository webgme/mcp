"use strict";
/**
 * MetaDescriptor (compact metamodel document) ↔ WebGME core.
 * See docs/schemas/meta-descriptor.schema.json
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyJsonPatch = applyJsonPatch;
exports.buildMetaDescriptorFromCore = buildMetaDescriptorFromCore;
exports.buildObjectListFromCore = buildObjectListFromCore;
exports.syncMetaDescriptorPatch = syncMetaDescriptorPatch;
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
/** RFC 6902 subset used by GMEBot meta patch (add, remove, replace). */
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
    return doc;
}
function metaChildrenToContains(children) {
    var _a;
    if (!children || !Array.isArray(children.items))
        return undefined;
    const out = [];
    for (const item of children.items) {
        const name = (_a = item === null || item === void 0 ? void 0 : item.name) !== null && _a !== void 0 ? _a : item === null || item === void 0 ? void 0 : item.id;
        if (!name)
            continue;
        let suffix = "";
        const min = typeof item.min === "number" ? item.min : undefined;
        const max = typeof item.max === "number" ? item.max : undefined;
        if (min === 0 && max === 1)
            suffix = ":0..1";
        else if (min === 1 && max === 1)
            suffix = ":1";
        else if (max === -1 || max === undefined)
            suffix = max === -1 ? "*" : suffix;
        else if (max > 1)
            suffix = "*";
        out.push(String(name) + suffix);
    }
    return out.length ? out : undefined;
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
/** Build compact MetaDescriptor v1 from WebGME core (open project). */
function buildMetaDescriptorFromCore(core, root) {
    var _a, _b, _c, _d, _e;
    const metaDict = core.getAllMetaNodes(root) || {};
    const concepts = [];
    const relationships = [];
    for (const path of Object.keys(metaDict).sort()) {
        const node = metaDict[path];
        if (!node)
            continue;
        const name = String((_a = core.getAttribute(node, "name")) !== null && _a !== void 0 ? _a : "").trim();
        if (!name)
            continue;
        let meta = {};
        try {
            meta = core.getJsonMeta(node) || {};
        }
        catch {
            meta = {};
        }
        const concept = {
            name,
            extends: baseConceptName(core, node, root),
        };
        const contains = metaChildrenToContains(meta.children);
        if (contains)
            concept.contains = contains;
        const pointers = metaPointersToRecord(meta.pointers);
        if (pointers)
            concept.pointers = pointers;
        if (meta.attributes && typeof meta.attributes === "object") {
            const attrs = {};
            for (const k of Object.keys(meta.attributes)) {
                const a = meta.attributes[k];
                if (a && typeof a === "object" && a.type) {
                    attrs[k] = a.type === "string" && !a.multiline ? "string" : a;
                }
            }
            if (Object.keys(attrs).length)
                concept.attributes = attrs;
        }
        const ptr = meta.pointers;
        if (ptr && (ptr.src || ptr.dst)) {
            const fromItems = (_c = (_b = ptr.src) === null || _b === void 0 ? void 0 : _b.items) !== null && _c !== void 0 ? _c : [];
            const toItems = (_e = (_d = ptr.dst) === null || _d === void 0 ? void 0 : _d.items) !== null && _e !== void 0 ? _e : [];
            const fromNames = fromItems.map((it) => { var _a; return (_a = it === null || it === void 0 ? void 0 : it.name) !== null && _a !== void 0 ? _a : it === null || it === void 0 ? void 0 : it.id; }).filter(Boolean);
            const toNames = toItems.map((it) => { var _a; return (_a = it === null || it === void 0 ? void 0 : it.name) !== null && _a !== void 0 ? _a : it === null || it === void 0 ? void 0 : it.id; }).filter(Boolean);
            if (fromNames.length && toNames.length) {
                relationships.push(name +
                    ": " +
                    (fromNames.length === 1 ? fromNames[0] : fromNames.join("|")) +
                    " -> " +
                    (toNames.length === 1 ? toNames[0] : toNames.join("|")));
            }
        }
        concepts.push(concept);
    }
    const descriptor = { version: 1, concepts };
    if (relationships.length)
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
        if (!name)
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
/**
 * Apply patch to descriptor and sync supported changes to WebGME (new concepts for now).
 */
async function syncMetaDescriptorPatch(core, root, before, patch, commit) {
    const after = applyJsonPatch(before, patch);
    const applied = [];
    const warnings = [];
    const beforeNames = new Set(before.concepts.map((c) => c.name));
    const afterNames = new Set(after.concepts.map((c) => c.name));
    for (const concept of after.concepts) {
        if (beforeNames.has(concept.name))
            continue;
        const baseName = concept.extends || "FCO";
        let baseNode = typeof core.getFCO === "function" ? core.getFCO(root) : null;
        if (baseName !== "FCO") {
            const metaDict = core.getAllMetaNodes(root) || {};
            for (const p of Object.keys(metaDict)) {
                const n = metaDict[p];
                if (n && String(core.getAttribute(n, "name")).trim() === baseName) {
                    baseNode = n;
                    break;
                }
            }
        }
        if (!baseNode) {
            warnings.push("Could not resolve base for new concept " + concept.name);
            continue;
        }
        const created = core.createNode({ parent: root, base: baseNode });
        if (created && typeof created.message === "string") {
            warnings.push("createNode failed for " + concept.name + ": " + created.message);
            continue;
        }
        core.setAttribute(created, "name", concept.name);
        core.addMember(root, "MetaAspectSet", created);
        applied.push("created concept " + concept.name);
    }
    const removed = [...beforeNames].filter((n) => !afterNames.has(n));
    if (removed.length) {
        warnings.push("Removing concepts via patch is not applied yet: " + removed.join(", "));
    }
    if (applied.length) {
        await commit("GMEBot: patchMetaDescriptor");
    }
    return { metaDescriptor: after, applied, warnings };
}
