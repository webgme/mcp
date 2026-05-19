"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEED_CLIENT_DATA_KEYS = void 0;
exports.logToolFailure = logToolFailure;
exports.commitCoreSession = commitCoreSession;
exports.isMetaVisualizer = isMetaVisualizer;
exports.resolveModelingMode = resolveModelingMode;
exports.getActiveTools = getActiveTools;
exports.getToolMap = getToolMap;
exports.isToolEnabled = isToolEnabled;
exports.getToolDefinitionsForLLM = getToolDefinitionsForLLM;
exports.getToolsForContext = getToolsForContext;
/** When a tool needs data only the client has (e.g. diagram layout), it sets needClientData in data. */
exports.NEED_CLIENT_DATA_KEYS = {
    diagramLayout: "diagramLayout",
};
/** Use in tool catch blocks: info-level = tool name + error message; debug = full args. */
function logToolFailure(ctx, toolName, args, err) {
    const msg = (err && (err.message || err.toString())) || String(err);
    ctx.logger.warn(toolName + " failed: " + msg.slice(0, 200));
    ctx.logger.debug(toolName + " args: " + JSON.stringify(args));
}
/**
 * Persist the core state and make a commit on the project. Use after any server-side mutation.
 * Requires ctx.coreSession (project open with Core and root loaded).
 * Updates coreSession.commitObject and coreSession.root to the new commit so subsequent
 * tools in the same request use the correct parent and state.
 */
async function commitCoreSession(coreSession, message) {
    const { core, root, project, commitObject, branchName } = coreSession;
    const persisted = core.persist(root);
    const result = await project.makeCommit(branchName, [commitObject._id], persisted.rootHash, persisted.objects, message);
    if (!result || typeof result.hash !== "string") {
        throw new Error("makeCommit did not return a commit hash");
    }
    const newCommitObject = await project.getCommitObject(result.hash);
    const newRoot = await core.loadRoot(newCommitObject.root);
    coreSession.commitObject = newCommitObject;
    coreSession.root = newRoot;
}
const project_1 = require("./tools/project");
const branch_1 = require("./tools/branch");
const meta_1 = require("./tools/meta");
const node_1 = require("./tools/node");
const state_1 = require("./tools/state");
const metaPatch_1 = require("./tools/metaPatch");
/** Visualizer ids that represent the Meta Editor (meta modeling). */
const META_VISUALIZER_IDS = ["METAAspect"];
function isMetaVisualizer(activeVisualizerId) {
    if (!activeVisualizerId || typeof activeVisualizerId !== "string")
        return false;
    const id = activeVisualizerId.trim();
    return META_VISUALIZER_IDS.some((metaId) => metaId === id);
}
/** Resolve modeling layer from explicit toggle or active visualizer. */
function resolveModelingMode(context) {
    const m = context === null || context === void 0 ? void 0 : context.modelingMode;
    if (m === "metamodel" || m === "domain")
        return m;
    return isMetaVisualizer(context === null || context === void 0 ? void 0 : context.activeVisualizerId) ? "metamodel" : "domain";
}
/** Legacy tool sets — kept for handlers and tests; not exposed to the LLM by default. */
function getLegacyTools(gmeConfig) {
    return [
        ...project_1.PROJECT_TOOLS,
        ...branch_1.BRANCH_TOOLS,
        ...meta_1.META_TOOLS,
        ...node_1.NODE_TOOLS,
        ...(0, state_1.getStateTools)(gmeConfig),
    ];
}
/** Tools the LLM may call for this request (scoping drill-down). */
function getActiveTools(_gmeConfig, context) {
    if (resolveModelingMode(context) === "metamodel") {
        return [...metaPatch_1.META_PATCH_TOOLS];
    }
    return [];
}
/** Full handler map (legacy tools remain registered but gated at execution). */
function getToolMap(gmeConfig) {
    const map = new Map();
    for (const t of getLegacyTools(gmeConfig)) {
        map.set(t.definition.name, t.handler);
    }
    for (const t of metaPatch_1.META_PATCH_TOOLS) {
        map.set(t.definition.name, t.handler);
    }
    return map;
}
function isToolEnabled(toolName, context) {
    return getActiveTools(undefined, context).some((t) => t.definition.name === toolName);
}
function getToolDefinitionsForLLM(gmeConfig, context) {
    const tools = getActiveTools(gmeConfig, context);
    return tools.map((t) => ({
        type: "function",
        function: t.definition,
    }));
}
/** @deprecated Use getActiveTools — kept for callers that referenced context-based subsets. */
function getToolsForContext(gmeConfig, context) {
    return getActiveTools(gmeConfig, context);
}
