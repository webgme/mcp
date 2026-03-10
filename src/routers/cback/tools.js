"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEED_CLIENT_DATA_KEYS = void 0;
exports.logToolFailure = logToolFailure;
exports.commitCoreSession = commitCoreSession;
exports.getToolsForContext = getToolsForContext;
exports.getToolMap = getToolMap;
exports.getToolDefinitionsForLLM = getToolDefinitionsForLLM;
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
/** Visualizer ids that represent the Meta Editor (meta modeling). Used for context-driven tool selection. */
const META_VISUALIZER_IDS = ["METAAspect"];
function isMetaVisualizer(activeVisualizerId) {
    if (!activeVisualizerId || typeof activeVisualizerId !== "string")
        return false;
    const id = activeVisualizerId.trim();
    return META_VISUALIZER_IDS.some((metaId) => metaId === id);
}
/** Project + branch + state: always included regardless of visualizer. */
function getCoreTools(gmeConfig) {
    return [...project_1.PROJECT_TOOLS, ...branch_1.BRANCH_TOOLS, ...(0, state_1.getStateTools)(gmeConfig)];
}
/** All tools (for the tool map). */
function getAllTools(gmeConfig) {
    return [...project_1.PROJECT_TOOLS, ...branch_1.BRANCH_TOOLS, ...meta_1.META_TOOLS, ...node_1.NODE_TOOLS, ...(0, state_1.getStateTools)(gmeConfig)];
}
/**
 * Tools to expose for this request based on context. When activeVisualizerId is the meta editor,
 * only meta tools are added (plus core). Otherwise only node tools are added (plus core).
 * This reduces token use by not sending the other set.
 */
function getToolsForContext(gmeConfig, context) {
    const core = getCoreTools(gmeConfig);
    const isMeta = isMetaVisualizer(context === null || context === void 0 ? void 0 : context.activeVisualizerId);
    if (isMeta)
        return [...core, ...meta_1.META_TOOLS];
    return [...core, ...node_1.NODE_TOOLS];
}
function getToolMap(gmeConfig) {
    const map = new Map();
    for (const t of getAllTools(gmeConfig)) {
        map.set(t.definition.name, t.handler);
    }
    return map;
}
function getToolDefinitionsForLLM(gmeConfig, context) {
    const tools = context ? getToolsForContext(gmeConfig, context) : getAllTools(gmeConfig);
    return tools.map((t) => ({
        type: "function",
        function: t.definition,
    }));
}
