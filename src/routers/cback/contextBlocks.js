"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSessionContextPayload = buildSessionContextPayload;
exports.formatContextBlocksForSystem = formatContextBlocksForSystem;
exports.formatTurnContextLine = formatTurnContextLine;
const metaDescriptor_1 = require("./metaDescriptor");
const tools_1 = require("./tools");
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
    const mode = (0, tools_1.resolveModelingMode)(ctx.context);
    const clientList = (_a = ctx.context) === null || _a === void 0 ? void 0 : _a.objectList;
    if (!ctx.coreSession) {
        return {
            modelingMode: mode,
            objectList: {
                existing: (_b = clientList === null || clientList === void 0 ? void 0 : clientList.existing) !== null && _b !== void 0 ? _b : [],
                new: (_c = clientList === null || clientList === void 0 ? void 0 : clientList.new) !== null && _c !== void 0 ? _c : [],
                deleted: (_d = clientList === null || clientList === void 0 ? void 0 : clientList.deleted) !== null && _d !== void 0 ? _d : [],
            },
        };
    }
    const { core, root } = ctx.coreSession;
    if (mode === "metamodel") {
        return {
            modelingMode: mode,
            metaDescriptor: (0, metaDescriptor_1.buildMetaDescriptorFromCore)(core, root),
            objectList: (0, metaDescriptor_1.buildObjectListFromCore)(core, root, clientList),
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
        parts.push("You are editing the **metamodel** (META types). Use patchMetaDescriptor with JSON Patch on the MetaDescriptor below.");
        if (payload.metaDescriptor) {
            parts.push("[Meta descriptor]\n" + truncateJson(payload.metaDescriptor, MAX_CONTEXT_JSON_CHARS));
        }
    }
    else {
        parts.push("You are in **domain modeling** mode. Instance-edit tools are hidden for now; answer from context and explain what would change.");
    }
    if (payload.objectList) {
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
    if (c.activeNodeId)
        bits.push("activeNodeId=" + c.activeNodeId);
    if (c.activeVisualizerId)
        bits.push("activeVisualizerId=" + c.activeVisualizerId);
    if (typeof c.activeTabId === "number")
        bits.push("activeTabId=" + c.activeTabId);
    if (c.modelingMode)
        bits.push("modelingMode=" + c.modelingMode);
    return bits.length ? bits.join(", ") : "";
}
