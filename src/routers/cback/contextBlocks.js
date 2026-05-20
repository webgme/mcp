"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSessionContextPayload = buildSessionContextPayload;
exports.formatContextBlocksForSystem = formatContextBlocksForSystem;
exports.formatTurnContextLine = formatTurnContextLine;
const metaDescriptor_1 = require("./metaDescriptor");
const toolRegistry_1 = require("./toolRegistry");
const MAX_CONTEXT_JSON_CHARS = 12000;
function truncateJson(obj, maxChars) {
    const full = JSON.stringify(obj, null, 2);
    if (full.length <= maxChars)
        return full;
    return full.slice(0, maxChars) + "\n… (truncated)";
}
/** Build meta descriptor + object list when project is open. */
function buildSessionContextPayload(ctx) {
    var _a, _b, _c, _d;
    const mode = (0, toolRegistry_1.resolveModelingMode)(ctx.context);
    const clientList = (_a = ctx.context) === null || _a === void 0 ? void 0 : _a.objectList;
    if (!ctx.coreSession) {
        const stubList = {
            existing: (_b = clientList === null || clientList === void 0 ? void 0 : clientList.existing) !== null && _b !== void 0 ? _b : [],
            new: (_c = clientList === null || clientList === void 0 ? void 0 : clientList.new) !== null && _c !== void 0 ? _c : [],
            deleted: (_d = clientList === null || clientList === void 0 ? void 0 : clientList.deleted) !== null && _d !== void 0 ? _d : [],
        };
        return mode === "metamodel"
            ? { modelingMode: mode, conceptRegistry: (0, metaDescriptor_1.buildConceptRegistryFromObjectList)(stubList) }
            : { modelingMode: mode, objectList: stubList };
    }
    const { core, root } = ctx.coreSession;
    if (mode === "metamodel") {
        return {
            modelingMode: mode,
            metaDescriptor: (0, metaDescriptor_1.buildMetaDescriptorFromCore)(core, root),
            conceptRegistry: (0, metaDescriptor_1.buildConceptRegistryFromCore)(core, root, clientList),
        };
    }
    return {
        modelingMode: mode,
        objectList: (0, metaDescriptor_1.buildObjectListFromCore)(core, root, clientList),
    };
}
/** Blocks appended to the system prompt so tools need not fetch meta first. */
function formatContextBlocksForSystem(payload) {
    if (!payload)
        return "";
    const parts = [];
    parts.push("modelingMode=" + payload.modelingMode);
    if (payload.modelingMode === "metamodel") {
        parts.push("[Metamodel editing — internal, do not repeat to the user]\n" +
            "Use patchMetaDescriptor on the Meta descriptor below. Names only (no paths/guids). " +
            "Maps keyed by name: /concepts/State, /concepts/StateMachine/contains/State, /relationships/Transition. " +
            "Main container = domain name (StateMachine, not Diagram); contains must list node types and connection types. " +
            "Each link: concepts.Transition = {} plus relationships.Transition = { from, to }. No attributes.name.");
        parts.push("[How to reply to the user]\n" +
            "Describe the metamodel in modeling terms: what the main model is called, which element types exist, how connections work. " +
            "Do not explain JSON Patch, descriptor structure, contains/relationships syntax, FCO, or cardinality unless asked.");
        if (payload.metaDescriptor) {
            parts.push("[Meta descriptor — for edits only, not for quoting to the user]\n" +
                truncateJson(payload.metaDescriptor, MAX_CONTEXT_JSON_CHARS));
        }
        if (payload.conceptRegistry) {
            parts.push("[Concept registry]\n" + truncateJson(payload.conceptRegistry, MAX_CONTEXT_JSON_CHARS));
        }
    }
    else {
        parts.push("You are in **domain modeling** mode. Instance-edit tools are hidden for now; answer from context and explain what would change.");
    }
    if (payload.modelingMode !== "metamodel" && payload.objectList) {
        parts.push("[Object list]\n" + truncateJson(payload.objectList, MAX_CONTEXT_JSON_CHARS));
    }
    return parts.join("\n\n");
}
/** Short per-turn hint (project/selection). */
function formatTurnContextLine(ctx) {
    const c = ctx.context;
    if (!c)
        return "";
    const bits = [];
    if (c.projectId)
        bits.push("projectId=" + c.projectId);
    if (c.branchName)
        bits.push("branchName=" + c.branchName);
    const mode = (0, toolRegistry_1.resolveModelingMode)(c);
    if (mode !== "metamodel" && c.activeNodeId)
        bits.push("activeNodeId=" + c.activeNodeId);
    if (c.activeVisualizerId)
        bits.push("activeVisualizerId=" + c.activeVisualizerId);
    if (typeof c.activeTabId === "number")
        bits.push("activeTabId=" + c.activeTabId);
    if (c.modelingMode)
        bits.push("modelingMode=" + c.modelingMode);
    return bits.length ? bits.join(", ") : "";
}
