"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.META_ASPECT_SET_NAME = exports.META_SHEETS_REGISTRY = void 0;
exports.normalizeMetaConceptName = normalizeMetaConceptName;
exports.resolveMetaByName = resolveMetaByName;
exports.normalizeConnectionPointerName = normalizeConnectionPointerName;
exports.parseTargetRef = parseTargetRef;
exports.formatContainmentRef = formatContainmentRef;
exports.registerMetaNodeOnSheets = registerMetaNodeOnSheets;
exports.createMetaConceptInCore = createMetaConceptInCore;
exports.applyRelationshipPointersInCore = applyRelationshipPointersInCore;
exports.applyContainmentInCore = applyContainmentInCore;
exports.findMetaConceptByName = findMetaConceptByName;
/**
 * Shared WebGME metamodel mutations (no commit). Used by createMetaNode and patchMetaDescriptor sync.
 */
const metaDescriptor_1 = require("./metaDescriptor");
exports.META_SHEETS_REGISTRY = "MetaSheets";
exports.META_ASPECT_SET_NAME = "MetaAspectSet";
/** Normalize a concept name from the MetaDescriptor (names only — not paths or guids). */
function normalizeMetaConceptName(raw) {
    const s = String(raw !== null && raw !== void 0 ? raw : "").trim();
    if (!s)
        return "";
    if (s.startsWith("/"))
        return "";
    return s;
}
/** Resolve a META concept by name (FCO keyword supported). Paths are not accepted. */
async function resolveMetaByName(core, root, conceptName) {
    const name = normalizeMetaConceptName(conceptName);
    if (!name)
        return null;
    if ((0, metaDescriptor_1.isFcoConceptName)(name) && typeof core.getFCO === "function") {
        const fco = core.getFCO(root);
        if (fco)
            return core.getPath(fco);
    }
    const metaDict = core.getAllMetaNodes(root) || {};
    for (const path of Object.keys(metaDict)) {
        const node = metaDict[path];
        if (!node)
            continue;
        const attr = core.getAttribute(node, "name");
        if (attr != null && String(attr).trim() === name)
            return path;
    }
    return null;
}
function normalizeConnectionPointerName(raw) {
    const s = String(raw !== null && raw !== void 0 ? raw : "").trim().toLowerCase();
    if (s === "source" || s === "from" || s === "origin")
        return "src";
    if (s === "destination" || s === "to" || s === "sink")
        return "dst";
    if (s === "src" || s === "dst")
        return s;
    return String(raw !== null && raw !== void 0 ? raw : "").trim();
}
/** Parse targetRef string (containment / sets) into concept name + optional cardinality. */
function parseTargetRef(ref) {
    let s = String(ref !== null && ref !== void 0 ? ref : "").trim();
    if (!s)
        return { name: "" };
    let min;
    let max;
    if (s.endsWith("*")) {
        s = s.slice(0, -1);
        min = 0;
        max = -1;
    }
    else if (s.endsWith("+")) {
        s = s.slice(0, -1);
        min = 1;
        max = -1;
    }
    else if (s.endsWith("?")) {
        s = s.slice(0, -1);
        min = 0;
        max = 1;
    }
    else {
        const colon = s.lastIndexOf(":");
        if (colon > 0) {
            const card = s.slice(colon + 1);
            const base = s.slice(0, colon);
            if (/^\d+$/.test(card)) {
                min = parseInt(card, 10);
                max = min;
                s = base;
            }
            else if (card.includes("..")) {
                const parts = card.split("..");
                min = parseInt(parts[0], 10);
                max = parseInt(parts[1], 10);
                s = base;
            }
        }
    }
    return { name: s.trim(), min, max };
}
function formatContainmentRef(childName, cardinality) {
    const card = String(cardinality !== null && cardinality !== void 0 ? cardinality : "*").trim();
    if (card === "*" || card === "+" || card === "?")
        return childName + card;
    if (card === "1")
        return childName + ":1";
    if (card === "0..1")
        return childName + ":0..1";
    if (/^\d+$/.test(card))
        return childName + ":" + card;
    if (card.includes(".."))
        return childName + ":" + card;
    return childName + card;
}
async function applyContainsMapAsync(core, root, node, containerName, contains, warnings) {
    if (!contains || typeof contains !== "object")
        return;
    for (const [childName, cardinality] of Object.entries(contains)) {
        if (!(0, metaDescriptor_1.isValidConceptName)(childName)) {
            warnings.push("contains: invalid child name '" +
                childName +
                "' on " +
                containerName +
                " (use plain names; cardinality is the value, e.g. State: \"*\")");
            continue;
        }
        const ref = formatContainmentRef(childName, String(cardinality));
        const { name: targetName, min, max } = parseTargetRef(ref);
        if (!targetName)
            continue;
        const targetNode = await loadMetaNodeByName(core, root, targetName);
        if (!targetNode) {
            warnings.push("contains: target not found '" + targetName + "'");
            continue;
        }
        const res = core.setChildMeta(node, targetNode, min, max);
        if (res)
            warnings.push("setChildMeta " + containerName + " -> " + targetName + ": " + res.message);
    }
}
function getSortedMetaSheets(core, root) {
    const rawSheets = core.getRegistry(root, exports.META_SHEETS_REGISTRY) || [];
    const sheets = Array.isArray(rawSheets) ? rawSheets.slice() : [];
    sheets.sort((a, b) => {
        const ao = typeof a.order === "number" ? a.order : 0;
        const bo = typeof b.order === "number" ? b.order : 0;
        return ao - bo;
    });
    return sheets;
}
/** Register meta-node on MetaAspectSet and first meta sheet (same as createMetaNode). */
function registerMetaNodeOnSheets(core, root, node) {
    var _a;
    core.addMember(root, exports.META_ASPECT_SET_NAME, node);
    const sheets = getSortedMetaSheets(core, root);
    if (sheets.length > 0 && ((_a = sheets[0]) === null || _a === void 0 ? void 0 : _a.SetID)) {
        core.addMember(root, sheets[0].SetID, node);
    }
}
async function loadMetaNodeByName(core, root, conceptName) {
    const path = await resolveMetaByName(core, root, conceptName);
    if (path == null)
        return null;
    const rootPath = core.getPath(root);
    return path === rootPath ? root : await core.loadByPath(root, path);
}
async function resolveBaseMetaNode(core, root, extendsName) {
    const baseName = extendsName || "FCO";
    if (baseName === "FCO" && typeof core.getFCO === "function") {
        return core.getFCO(root);
    }
    const path = await resolveMetaByName(core, root, baseName);
    if (path == null)
        return null;
    const rootPath = core.getPath(root);
    const node = path === rootPath ? root : await core.loadByPath(root, path);
    if (!node)
        return null;
    if (typeof core.isMetaNode === "function" && !core.isMetaNode(node))
        return null;
    return node;
}
/** Create META concept node (no commit). Mirrors createMetaNode handler. */
async function createMetaConceptInCore(core, root, concept) {
    var _a;
    const warnings = [];
    const name = String((_a = concept.name) !== null && _a !== void 0 ? _a : "").trim();
    if (!name)
        throw new Error("Concept name is required");
    if (!(0, metaDescriptor_1.isValidConceptName)(name)) {
        throw new Error('Invalid concept name "' +
            name +
            '". Names must be plain identifiers; put cardinality in contains (e.g. contains.State = "*").');
    }
    const baseNode = await resolveBaseMetaNode(core, root, concept.extends || "FCO");
    if (!baseNode) {
        throw new Error("Base concept not found: " + (concept.extends || "FCO"));
    }
    const created = core.createNode({ parent: root, base: baseNode });
    if (created && typeof created.message === "string") {
        throw new Error(created.message);
    }
    const node = created;
    core.setAttribute(node, "name", name);
    registerMetaNodeOnSheets(core, root, node);
    const path = core.getPath(node);
    // Containment, pointers, sets, and relationships are applied in syncMetaDescriptorPatch
    // after every concept in the patch exists (avoids "target not found" on ordered creates).
    return { node, path, warnings };
}
/** Apply src/dst pointer meta for a connection concept (0..1 each). */
async function applyRelationshipPointersInCore(core, root, conceptName, from, to) {
    const warnings = [];
    const conceptNode = await loadMetaNodeByName(core, root, conceptName);
    if (!conceptNode) {
        warnings.push("relationship: concept not found '" + conceptName + "'");
        return warnings;
    }
    const applyEnd = async (pointerName, end) => {
        const list = Array.isArray(end) ? end : [end];
        for (const ref of list) {
            const targetName = typeof ref === "string" ? ref.trim() : "";
            if (!targetName)
                continue;
            const targetNode = await loadMetaNodeByName(core, root, targetName);
            if (!targetNode) {
                warnings.push("relationship " + conceptName + " " + pointerName + ": target not found '" + targetName + "'");
                continue;
            }
            try {
                const pn = normalizeConnectionPointerName(pointerName);
                core.setPointerMetaLimits(conceptNode, pn, 1, 1);
                core.setPointerMetaTarget(conceptNode, pn, targetNode, 1, 1);
            }
            catch (e) {
                warnings.push("relationship " + conceptName + " " + pointerName + ": " + ((e === null || e === void 0 ? void 0 : e.message) || String(e)));
            }
        }
    };
    await applyEnd("src", from);
    await applyEnd("dst", to);
    return warnings;
}
async function applyContainmentInCore(core, root, containerName, targetRef) {
    const warnings = [];
    const { name: targetName, min, max } = parseTargetRef(targetRef);
    const sourceNode = await loadMetaNodeByName(core, root, containerName);
    const targetNode = await loadMetaNodeByName(core, root, targetName);
    if (!sourceNode) {
        warnings.push("containment: container not found '" + containerName + "'");
        return warnings;
    }
    if (!targetNode) {
        warnings.push("containment: target not found '" + targetName + "'");
        return warnings;
    }
    const res = core.setChildMeta(sourceNode, targetNode, min, max);
    if (res)
        warnings.push("setChildMeta: " + res.message);
    return warnings;
}
async function findMetaConceptByName(core, root, name) {
    const path = await resolveMetaByName(core, root, name);
    if (path == null)
        return null;
    const rootPath = core.getPath(root);
    const node = path === rootPath ? root : await core.loadByPath(root, path);
    if (!node)
        return null;
    return { node, path };
}
