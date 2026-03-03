"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.commitCoreSession = commitCoreSession;
exports.getToolMap = getToolMap;
exports.getToolDefinitionsForLLM = getToolDefinitionsForLLM;
/**
 * Persist the core state and make a commit on the project. Use after any server-side mutation.
 * Requires ctx.coreSession (project open with Core and root loaded).
 */
async function commitCoreSession(coreSession, message) {
    const { core, root, project, commitObject, branchName } = coreSession;
    const persisted = core.persist(root);
    await project.makeCommit(branchName, [commitObject._id], persisted.rootHash, persisted.objects, message);
}
const project_1 = require("./tools/project");
const branch_1 = require("./tools/branch");
const meta_1 = require("./tools/meta");
const node_1 = require("./tools/node");
const state_1 = require("./tools/state");
const BASE_TOOLS = [
    ...project_1.PROJECT_TOOLS,
    ...branch_1.BRANCH_TOOLS,
    ...meta_1.META_TOOLS,
    ...node_1.NODE_TOOLS,
];
function getAllTools(gmeConfig) {
    return [...BASE_TOOLS, ...(0, state_1.getStateTools)(gmeConfig)];
}
function getToolMap(gmeConfig) {
    const map = new Map();
    for (const t of getAllTools(gmeConfig)) {
        map.set(t.definition.name, t.handler);
    }
    return map;
}
function getToolDefinitionsForLLM(gmeConfig) {
    return getAllTools(gmeConfig).map((t) => ({
        type: "function",
        function: t.definition,
    }));
}
