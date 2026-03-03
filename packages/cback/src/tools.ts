export interface ToolParameter {
    type: string;
    description: string;
    enum?: string[];
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, ToolParameter>;
        required: string[];
    };
}

export interface ToolContext {
    userId: string;
    logger: any;
    safeStorage?: any;
    gmeAuth?: any;
    /** Set by the backend when request context has projectId: open project, create Core, load root.
     * Tools use this for server-side node operations; they must not import webgme/core. */
    coreSession?: {
        core: any;
        root: any;
        project: any;
        commitObject: any;
        branchName: string;
    };
    /** Context from the client only. The server does not gather or store active node state;
     * the client sends this with each chat request (e.g. activeNodeId from the current selection). */
    context?: {
        projectId?: string;
        branchName?: string;
        /** Active/selected node ID sent by the client; used as default container or target when omitted from tool args. */
        activeNodeId?: string;
    };
}

export interface ClientCommand {
    type: string;
    args: Record<string, any>;
}

export interface ToolResult {
    data: any;
    commands?: ClientCommand[];
}

export type ToolHandler = (
    args: Record<string, any>,
    ctx: ToolContext
) => Promise<ToolResult>;

/**
 * Persist the core state and make a commit on the project. Use after any server-side mutation.
 * Requires ctx.coreSession (project open with Core and root loaded).
 */
export async function commitCoreSession(
    coreSession: NonNullable<ToolContext["coreSession"]>,
    message: string
): Promise<void> {
    const { core, root, project, commitObject, branchName } = coreSession;
    const persisted = core.persist(root);
    await project.makeCommit(
        branchName,
        [commitObject._id],
        persisted.rootHash,
        persisted.objects,
        message
    );
}

export interface Tool {
    definition: ToolDefinition;
    handler: ToolHandler;
}

import { PROJECT_TOOLS } from "./tools/project";
import { BRANCH_TOOLS } from "./tools/branch";
import { META_TOOLS } from "./tools/meta";
import { NODE_TOOLS } from "./tools/node";
import { getStateTools } from "./tools/state";

const BASE_TOOLS: Tool[] = [
    ...PROJECT_TOOLS,
    ...BRANCH_TOOLS,
    ...META_TOOLS,
    ...NODE_TOOLS,
];

function getAllTools(gmeConfig?: any): Tool[] {
    return [...BASE_TOOLS, ...getStateTools(gmeConfig)];
}

export function getToolMap(gmeConfig?: any): Map<string, ToolHandler> {
    const map = new Map<string, ToolHandler>();
    for (const t of getAllTools(gmeConfig)) {
        map.set(t.definition.name, t.handler);
    }
    return map;
}

export function getToolDefinitionsForLLM(gmeConfig?: any): object[] {
    return getAllTools(gmeConfig).map((t) => ({
        type: "function",
        function: t.definition,
    }));
}
