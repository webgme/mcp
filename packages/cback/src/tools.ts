export interface ToolParameter {
    type: string;
    description: string;
    enum?: string[];
    /** For type "array", optional item schema (object with type, properties, etc.). */
    items?: Record<string, unknown>;
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
    /** Full WebGME configuration object used by the server. */
    gmeConfig?: any;
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
     * the client sends this with each chat request (e.g. from WebGME client + State). */
    context?: {
        projectId?: string;
        branchName?: string;
        /** Active/selected node ID sent by the client; used as default container or target when omitted from tool args. */
        activeNodeId?: string;
        /** Active visualizer id from State.getActiveVisualizer() (e.g. ModelEditor, METAAspect). Used for context-driven tool sets. */
        activeVisualizerId?: string;
        /** Active tab index from State.getActiveTab(). When visualizer is Meta Editor, this is the meta sheet index. */
        activeTabId?: number;
        /** Filled by client on continuation when backend requested diagramLayout. */
        diagramLayout?: DiagramLayoutData;
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

/** When a tool needs data only the client has (e.g. diagram layout), it sets needClientData in data. */
export const NEED_CLIENT_DATA_KEYS = {
    diagramLayout: "diagramLayout",
} as const;

/** Layout data for the active diagram (model or meta): node/concept paths and bounding boxes from the client. */
export interface DiagramLayoutData {
    nodes: Array<{ path: string; x: number; y: number; width?: number; height?: number }>;
    /** Optional: edges between nodes (paths match nodes[].path). Helps the LLM understand diagram structure. */
    connections?: Array<{ sourcePath: string; targetPath: string }>;
}

export type ToolHandler = (
    args: Record<string, any>,
    ctx: ToolContext
) => Promise<ToolResult>;

/** Use in tool catch blocks: info-level = tool name + error message; debug = full args. */
export function logToolFailure(ctx: ToolContext, toolName: string, args: Record<string, any>, err: any): void {
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
export async function commitCoreSession(
    coreSession: NonNullable<ToolContext["coreSession"]>,
    message: string
): Promise<void> {
    const { core, root, project, commitObject, branchName } = coreSession;
    const persisted = core.persist(root);
    const result = await project.makeCommit(
        branchName,
        [commitObject._id],
        persisted.rootHash,
        persisted.objects,
        message
    );
    if (!result || typeof result.hash !== "string") {
        throw new Error("makeCommit did not return a commit hash");
    }
    const newCommitObject = await project.getCommitObject(result.hash);
    const newRoot = await core.loadRoot(newCommitObject.root);
    coreSession.commitObject = newCommitObject;
    coreSession.root = newRoot;
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

/** Visualizer ids that represent the Meta Editor (meta modeling). Used for context-driven tool selection. */
const META_VISUALIZER_IDS = ["METAAspect"];

/** True when the user is in the Meta editor (METAAspect); false for model/instance editors (e.g. ModelEditor). */
export function isMetaVisualizer(activeVisualizerId: string | undefined): boolean {
    if (!activeVisualizerId || typeof activeVisualizerId !== "string") return false;
    const id = activeVisualizerId.trim();
    return META_VISUALIZER_IDS.some((metaId) => metaId === id);
}

/** Project + branch + state: always included regardless of visualizer. */
function getCoreTools(gmeConfig?: any): Tool[] {
    return [...PROJECT_TOOLS, ...BRANCH_TOOLS, ...getStateTools(gmeConfig)];
}

/** All tools (for the tool map). */
function getAllTools(gmeConfig?: any): Tool[] {
    return [...PROJECT_TOOLS, ...BRANCH_TOOLS, ...META_TOOLS, ...NODE_TOOLS, ...getStateTools(gmeConfig)];
}

/**
 * Tools to expose for this request based on context. When activeVisualizerId is the meta editor,
 * only meta tools are added (plus core). Otherwise only node tools are added (plus core).
 * This reduces token use by not sending the other set.
 */
export function getToolsForContext(gmeConfig: any | undefined, context: ToolContext["context"]): Tool[] {
    const core = getCoreTools(gmeConfig);
    const isMeta = isMetaVisualizer(context?.activeVisualizerId);
    if (isMeta) return [...core, ...META_TOOLS];
    return [...core, ...NODE_TOOLS];
}

export function getToolMap(gmeConfig?: any): Map<string, ToolHandler> {
    const map = new Map<string, ToolHandler>();
    for (const t of getAllTools(gmeConfig)) {
        map.set(t.definition.name, t.handler);
    }
    return map;
}

/** Always expose the full tool set to the LLM (no activeVisualizerId / context-based subset). */
export function getToolDefinitionsForLLM(gmeConfig: any | undefined, _context?: ToolContext["context"]): object[] {
    const tools = getAllTools(gmeConfig);
    return tools.map((t) => ({
        type: "function",
        function: t.definition,
    }));
}
