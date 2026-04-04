import { Tool, ToolContext, commitCoreSession, NEED_CLIENT_DATA_KEYS, logToolFailure } from "../tools";

const DEFAULT_BASE_TYPE = "FCO";
const PATH_SEP = "/";

/** Path for loadByPath: "" or "/" means root (we pass "" to loadByPath), else path must start with /. */
function normalizePath(path: string | undefined | null): string {
    if (path == null || path === "") return "";
    const s = String(path).trim();
    if (s === "" || s === PATH_SEP) return "";
    return s.charAt(0) === PATH_SEP ? s : PATH_SEP + s;
}

/** Return path for display/API: root is "/", others have leading slash. */
function toDisplayPath(path: string | null | undefined): string {
    if (path == null || path === "") return PATH_SEP;
    const s = String(path).trim();
    return s === "" || s === PATH_SEP ? PATH_SEP : (s.charAt(0) === PATH_SEP ? s : PATH_SEP + s);
}

function getActiveNodeId(ctx: ToolContext): string | undefined {
    /** Only from client-sent context; server has no other source for the active node. */
    return ctx.context?.activeNodeId;
}

const RESOLVE_NAME_MAX_DEPTH = 50;

/**
 * Find the first node (under root or container) whose 'name' attribute equals searchName.
 * Returns its path or null. Used for pathOrName resolution when the value is not a path.
 */
async function findFirstNodeByName(
    core: any,
    root: any,
    searchName: string,
    containerPathNorm: string,
    maxDepth: number
): Promise<string | null> {
    const startNode = containerPathNorm === "" ? root : await core.loadByPath(root, containerPathNorm);
    if (!startNode) return null;
    const nameStr = String(searchName).trim();
    if (!nameStr) return null;

    async function search(node: any, depth: number): Promise<string | null> {
        if (depth > maxDepth) return null;
        const nodeName = core.getAttribute(node, "name");
        if (nodeName != null && String(nodeName).trim() === nameStr) {
            return core.getPath(node);
        }
        const childPaths = core.getChildrenPaths(node) || [];
        for (const p of childPaths) {
            const child = await core.loadByPath(root, p);
            if (child) {
                const found = await search(child, depth + 1);
                if (found) return found;
            }
        }
        return null;
    }
    return search(startNode, 0);
}

/**
 * Resolve pathOrName to an absolute node path. Accepts path (e.g. /1/2) or name (e.g. StateMachine).
 * - "" or "/" -> root path.
 * - Starts with /: try loadByPath; if not found, try resolving the remainder as name (e.g. /META -> name "META").
 * - Otherwise: resolve as name (search by 'name' attribute).
 */
async function resolveNodePathOrName(
    core: any,
    root: any,
    pathOrName: string | undefined | null,
    containerPath?: string
): Promise<string | null> {
    const s = pathOrName == null ? "" : String(pathOrName).trim();
    if (s === "" || s === PATH_SEP) return core.getPath(root);
    const containerNorm = normalizePath(containerPath ?? "");
    if (s.charAt(0) === PATH_SEP) {
        const node = await core.loadByPath(root, s);
        if (node) return core.getPath(node);
        const namePart = s.slice(1).trim();
        if (namePart) return findFirstNodeByName(core, root, namePart, containerNorm, RESOLVE_NAME_MAX_DEPTH);
        return null;
    }
    return findFirstNodeByName(core, root, s, containerNorm, RESOLVE_NAME_MAX_DEPTH);
}

/** Optional format hints for known properties when current value is empty. Keys can be attribute or registry names. */
const VALUE_FORMAT_HINTS: Record<string, string> = {
    position: "JSON string with x and y numbers, e.g. {\"x\":400,\"y\":200}",
    aspect: "string (aspect name)",
};

function formatPropertyValue(val: unknown): string {
    if (val === undefined || val === null) return "";
    if (typeof val === "string") return val;
    try {
        return JSON.stringify(val);
    } catch {
        return String(val);
    }
}

export const createNode: Tool = {
    definition: {
        name: "createNode",
        description:
            "Create a new node in the WebGME model (server-side). Primary tool for **instances** in the **model editor**. " +
            "When the user says **instance**, **instances**, **behavior**, **state machine instance**, or similar, use createNode with **baseType** set to an existing META concept path or name from **getMetaInfo** (e.g. State, Transition)—not createMetaNode. " +
            "Use createMetaNode only when defining a **new META concept type** in the metamodel, not when instantiating existing types. " +
            "No arguments are required. When the user says 'create a node' or 'add a node' without specifying type or parent, call createNode with an empty object {} — do NOT ask the user for type or parent; the backend uses defaults (current selection or root as parent, FCO as type). " +
            "Only pass container or baseType when the user explicitly specifies a parent path or a type. baseType must be FCO or an existing node path (from findNodesByName or getMetaInfo); do not invent type names that do not exist in the project. Never pass projectId as container. " +
            "FCO means First Class Object (not Foundation Class Object). " +
            "The tool returns nodePath (the node's path, e.g. '/1' or '/1/2'). Paths are project-specific; the FCO is typically at '/1', root at '/'. Do not assume or guess paths — use only paths returned by tools (createNode, findNodesByName, getProperty). nodePath is an identifier, NOT the node's name.",
        parameters: {
            type: "object",
            properties: {
                baseType: {
                    type: "string",
                    description:
                        "Optional. Omit unless user specifies a type. Must be FCO or an existing node path (e.g. from findNodesByName or getMetaInfo); do not invent type names.",
                },
                container: {
                    type: "string",
                    description:
                        "Optional. Omit unless user specifies a parent path. Default is current selection or root.",
                },
            },
            required: [],
        },
    },
    handler: async (args, ctx) => {
        if (!ctx.coreSession) {
            return {
                data: {
                    error:
                        "Project context is required for createNode and the backend could not open the project. " +
                        "The client must send projectId (and optionally branchName) in the request context.",
                },
            };
        }
        const containerPathRaw = args.container ?? getActiveNodeId(ctx);
        // Empty or missing activeNodeId means project root; use "" as container path.
        let containerPath =
            containerPathRaw !== undefined && containerPathRaw !== null && String(containerPathRaw).trim() !== ""
                ? String(containerPathRaw).trim()
                : "";
        // If LLM mistakenly passed projectId (e.g. "owner+ProjectName") as container, use root instead.
        if (containerPath !== "" && containerPath.includes("+") && !containerPath.includes(PATH_SEP)) {
            ctx.logger.warn("createNode: container looks like projectId (e.g. owner+name), using project root instead: " + containerPath);
            containerPath = "";
        }
        const baseType = args.baseType ?? DEFAULT_BASE_TYPE;
        const { core, root, project, commitObject, branchName } = ctx.coreSession;

        try {
            // Resolve container: path or name.
            const containerResolved = await resolveNodePathOrName(core, root, containerPath || undefined);
            const containerPathNorm = containerResolved === null ? "" : (containerResolved === core.getPath(root) ? "" : containerResolved);
            const parentNode =
                containerPathNorm === ""
                    ? root
                    : await core.loadByPath(root, containerPathNorm);
            if (!parentNode) {
                return { data: { error: "Container node not found (path or name): " + String(containerPath) } };
            }

            // Resolve base: FCO/default -> getFCO(root); path or name -> resolveNodePathOrName.
            let baseNode: any;
            if (!baseType || baseType === DEFAULT_BASE_TYPE || String(baseType).trim() === "") {
                baseNode = core.getBase(root) ?? core.getFCO(root) ?? root;
            } else {
                const baseResolved = await resolveNodePathOrName(core, root, baseType);
                if (!baseResolved) {
                    return { data: { error: "Base type/path not found (path or name): " + baseType } };
                }
                baseNode = baseResolved === core.getPath(root) ? root : await core.loadByPath(root, baseResolved);
            }
            if (!baseNode) {
                return { data: { error: "Base type/path not found: " + baseType } };
            }

            const created = core.createNode({ parent: parentNode, base: baseNode });
            if (created && typeof (created as any).message === "string") {
                return { data: { error: (created as any).message } };
            }
            const path = created ? core.getPath(created) : null;

            await commitCoreSession(ctx.coreSession, "GMEBot: createNode");

            return {
                data: {
                    created: true,
                    nodePath: toDisplayPath(path),
                    container: toDisplayPath(containerPathNorm || core.getPath(root)),
                    baseType,
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "createNode", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const moveNode: Tool = {
    definition: {
        name: "moveNode",
        description:
            "Move a node to a new parent (container). The move is performed on the server and committed. " +
            "Requires nodeId (the node to move) and newContainer (the new parent). When the user refers to nodes by name (e.g. 'move StateMachine into META'), call findNodesByName first to get paths for both, then call moveNode with those nodePaths. You may pass path or name—the backend resolves names. " +
            "If newContainer is omitted, the client-sent context activeNodeId is used. The response includes nodeName and containerName so you can report back to the user (e.g. 'Moved StateMachine into META').",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node to move: path (e.g. /1/2) or name (e.g. StateMachine). Resolved on the backend.",
                },
                newContainer: {
                    type: "string",
                    description:
                        "The new parent node: path (e.g. /1) or name (e.g. META). Resolved on the backend. If omitted, activeNodeId is used.",
                },
            },
            required: ["nodeId"],
        },
    },
    handler: async (args, ctx) => {
        const nodeIdRaw = args.nodeId;
        if (!nodeIdRaw) {
            return { data: { error: "nodeId is required." } };
        }
        const newContainerRaw = args.newContainer ?? getActiveNodeId(ctx);
        if (!newContainerRaw) {
            return {
                data: {
                    error:
                        "No newContainer specified and no activeNodeId in request context. The client must send the active node, or the user must provide newContainer.",
                },
            };
        }
        if (!ctx.coreSession) {
            return {
                data: { moved: true, nodeId: nodeIdRaw, newContainer: newContainerRaw },
                commands: [{ type: "moveNode", args: { nodeId: nodeIdRaw, newContainer: newContainerRaw } }],
            };
        }
        const { core, root } = ctx.coreSession;
        try {
            const nodePath = await resolveNodePathOrName(core, root, nodeIdRaw);
            const containerPathRes = await resolveNodePathOrName(core, root, newContainerRaw);
            if (!nodePath) {
                return { data: { error: "Node not found (path or name): " + String(nodeIdRaw) } };
            }
            if (!containerPathRes) {
                return { data: { error: "New container not found (path or name): " + String(newContainerRaw) } };
            }
            const node = await core.loadByPath(root, nodePath);
            const newParent = await core.loadByPath(root, containerPathRes);
            if (!node) {
                return { data: { error: "Node not found at path: " + toDisplayPath(nodePath) } };
            }
            if (!newParent) {
                return { data: { error: "New container not found at path: " + toDisplayPath(containerPathRes) } };
            }
            const rootPath = core.getPath(root);
            if (nodePath === rootPath) {
                return { data: { error: "Cannot move the project root." } };
            }
            const nodeName = core.getAttribute(node, "name") ?? nodeIdRaw;
            const containerName = core.getAttribute(newParent, "name") ?? newContainerRaw;
            // moveNode returns the updated node; use it for paths (commit does not refresh cached refs).
            const movedNode = core.moveNode(node, newParent);
            await commitCoreSession(ctx.coreSession, "GMEBot: moveNode");
            const newNodePath = core.getPath(movedNode);
            const newContainerPath = core.getPath(newParent);
            return {
                data: {
                    moved: true,
                    nodeId: toDisplayPath(newNodePath),
                    newContainer: toDisplayPath(newContainerPath),
                    nodeName: String(nodeName),
                    containerName: String(containerName),
                    message: "Moved '" + nodeName + "' into '" + containerName + "' and committed.",
                },
                commands: [{ type: "moveNode", args: { nodeId: toDisplayPath(newNodePath), newContainer: toDisplayPath(newContainerPath) } }],
            };
        } catch (e: any) {
            logToolFailure(ctx, "moveNode", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

/**
 * Walk the model tree and collect paths + name attributes (authoritative vs diagram layout alone).
 */
async function collectNodesDepthFirst(
    core: any,
    root: any,
    startNode: any,
    maxDepth: number,
    depth: number,
    out: Array<{ path: string; name: string }>
): Promise<void> {
    if (depth > maxDepth) return;
    const p = core.getPath(startNode);
    out.push({
        path: toDisplayPath(p),
        name: core.getAttribute(startNode, "name") != null ? String(core.getAttribute(startNode, "name")) : "",
    });
    const children = await core.loadChildren(startNode);
    for (const child of children) {
        await collectNodesDepthFirst(core, root, child, maxDepth, depth + 1, out);
    }
}

/** List nodes in the core tree — use when layout is not enough or the user asks what exists / bulk delete. */
export const listNodes: Tool = {
    definition: {
        name: "listNodes",
        description:
            "List nodes in the WebGME **core tree** under a container (depth-first): path and name for each node in that subtree. " +
            "Use for **model / subtree** scope: any multi-level hierarchy under a chosen parent (not only the whole project). " +
            "For **diagram** scope (single level, current canvas), use getDiagramLayout instead. " +
            "For **project** scope (everything), omit container or use '/'. Pass context.activeNodeId or a path when the user means a specific fragment of the model. deleteNode removes a node and all its descendants.",
        parameters: {
            type: "object",
            properties: {
                container: {
                    type: "string",
                    description:
                        "Root of the subtree: path (e.g. /1/2) or name. Omit or '/' for the **entire project**. Use a deeper path or activeNodeId when the user refers to a **model context** that spans several levels but not the full tree.",
                },
                maxDepth: {
                    type: "number",
                    description:
                        "Optional. Max depth below the container (default 40). Shrink if you only need a few levels under that subtree.",
                },
            },
            required: [],
        },
    },
    handler: async (args, ctx) => {
        if (!ctx.coreSession) {
            return {
                data: {
                    error: "Project context is required. Ensure a project is open and context is sent.",
                },
            };
        }
        const { core, root } = ctx.coreSession;
        const raw = args.container;
        const maxDepth = Math.min(Math.max(Number(args.maxDepth) || 40, 1), 100);
        try {
            let startNode: any;
            if (raw == null || String(raw).trim() === "" || String(raw).trim() === "/") {
                startNode = root;
            } else {
                const resolved = await resolveNodePathOrName(core, root, raw);
                if (!resolved) {
                    return { data: { error: "Container not found (path or name): " + String(raw) } };
                }
                const np = resolved === core.getPath(root) ? "" : resolved;
                startNode = np === "" ? root : await core.loadByPath(root, np);
                if (!startNode) {
                    return { data: { error: "Container not found at path: " + toDisplayPath(resolved) } };
                }
            }
            const nodes: Array<{ path: string; name: string }> = [];
            await collectNodesDepthFirst(core, root, startNode, maxDepth, 0, nodes);
            return {
                data: {
                    containerPath: toDisplayPath(core.getPath(startNode)),
                    count: nodes.length,
                    nodes,
                    hint:
                        "Scopes: diagram = getDiagramLayout; subtree = listNodes(container); project = listNodes('/'). " +
                        "If findNodesByName count is 1, use that nodePath. For bulk delete on a subtree, pick container to match the user's model context.",
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "listNodes", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const deleteNode: Tool = {
    definition: {
        name: "deleteNode",
        description: "Delete a node from the model. nodeId accepts path (e.g. /1/2) or name—the backend resolves names to paths. The node and its descendants are removed.",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node to delete: path (e.g. /1/2) or name. Resolved on the backend.",
                },
            },
            required: ["nodeId"],
        },
    },
    handler: async (args, ctx) => {
        const nodeIdRaw = args.nodeId;
        if (nodeIdRaw == null || String(nodeIdRaw).trim() === "") {
            return { data: { error: "nodeId is required." } };
        }

        if (ctx.coreSession) {
            const { core, root, project, commitObject, branchName } = ctx.coreSession;
            try {
                const nodePath = await resolveNodePathOrName(core, root, nodeIdRaw);
                if (!nodePath) {
                    return { data: { error: "Node not found (path or name): " + String(nodeIdRaw) } };
                }
                const node = await core.loadByPath(root, nodePath);
                if (!node) {
                    return { data: { error: "Node not found: " + toDisplayPath(nodePath) } };
                }
                core.deleteNode(node);
                await commitCoreSession(ctx.coreSession, "GMEBot: deleteNode");
                return {
                    data: { deleted: true, nodePath: toDisplayPath(nodePath) },
                    commands: [{ type: "deleteNode", args: { nodeId: toDisplayPath(nodePath) } }],
                };
            } catch (e: any) {
                logToolFailure(ctx, "deleteNode", args, e);
                return { data: { error: (e && e.message) || String(e) } };
            }
        }

        return {
            data: { deleted: true, nodeId: toDisplayPath(nodeIdRaw) },
            commands: [{ type: "deleteNode", args: { nodeId: toDisplayPath(nodeIdRaw) } }],
        };
    },
};

/** Find nodes whose 'name' attribute equals the given name. Use when the user refers to a node by name (e.g. 'the node named X'). */
export const findNodesByName: Tool = {
    definition: {
        name: "findNodesByName",
        description:
            "Find node path(s) by the node's name attribute. Call this when the user refers to a node by name (e.g. 'the node named MyNode', 'set position of X'). " +
            "Use it for META concept nodes too when metamodeling (e.g. 'the Folder concept', 'select concept X') — pass the concept name, then use the returned path with getProperty, setProperty, or setClientState. " +
            "The response includes nodePaths (array). You MUST pass one of these paths as nodeId in the next tool call (getProperty, setProperty) that targets that node — do not omit nodeId. If multiple nodes match, use the path that fits the user's context.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "The name attribute to search for (case-sensitive match).",
                },
                container: {
                    type: "string",
                    description: "Optional. Path to search within (e.g. '/' or '/1'). Omit to search from project root.",
                },
                maxDepth: {
                    type: "number",
                    description: "Optional. Maximum depth to search (default 15).",
                },
            },
            required: ["name"],
        },
    },
    handler: async (args, ctx) => {
        const name = args.name;
        if (name == null || String(name).trim() === "") {
            return { data: { error: "name is required." } };
        }
        if (!ctx.coreSession) {
            return {
                data: {
                    error: "Project context is required. Ensure a project is open and context is sent.",
                },
            };
        }
        const { core, root } = ctx.coreSession;
        const containerPathNorm = normalizePath(args.container ?? "");
        const maxDepth = Math.min(Math.max(Number(args.maxDepth) || 15, 1), 50);

        try {
            const startNode = containerPathNorm === "" ? root : await core.loadByPath(root, containerPathNorm);
            if (!startNode) {
                return { data: { error: "Container not found: " + (args.container ?? "/") } };
            }

            const nodePaths: string[] = [];
            const searchName = String(name).trim();

            async function search(node: any, depth: number): Promise<void> {
                if (depth > maxDepth) return;
                const nodeName = core.getAttribute(node, "name");
                if (nodeName != null && String(nodeName).trim() === searchName) {
                    nodePaths.push(toDisplayPath(core.getPath(node)));
                }
                let children = await core.loadChildren(node);
                for (let child of children) {
                    try {
                        await search(child, depth + 1);
                    } catch (_e) {
                        // skip if load fails
                    }
                }
            }

            await search(startNode, 1);

            const data: Record<string, unknown> = {
                name: searchName,
                nodePaths,
                count: nodePaths.length,
            };
            if (nodePaths.length === 1) {
                data.hint = "Single match — use this nodePath; no need to disambiguate.";
            }
            return { data };
        } catch (e: any) {
            logToolFailure(ctx, "findNodesByName", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

/** Unified get: list all properties or get one. Backend resolves attributes vs registry (attributes first). */
export const getProperty: Tool = {
    definition: {
        name: "getProperty",
        description:
            "Get property/properties of a node. With no name: lists all properties (attributes and registry) with current values. With name: returns that property's value. " +
            "Use findNodesByName first when the user refers to a node by name; pass one of the returned nodePaths as nodeId. Omit nodeId to use the current selection.",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node path (e.g. '/1'). From findNodesByName or omit for current selection.",
                },
                name: {
                    type: "string",
                    description: "Property name. Omit to list all properties and their values.",
                },
            },
            required: [],
        },
    },
    handler: async (args, ctx) => {
        const nodeId = args.nodeId ?? getActiveNodeId(ctx);
        if (nodeId == null || String(nodeId).trim() === "") {
            return { data: { error: "No nodeId and no activeNodeId. Provide nodeId or ensure the client sends the active node." } };
        }
        if (!ctx.coreSession) {
            return { data: { error: "Project context is required. Ensure a project is open." } };
        }
        const { core, root } = ctx.coreSession;
        const resolvedPath = await resolveNodePathOrName(core, root, nodeId);
        if (!resolvedPath) {
            return { data: { error: "Node not found: " + String(nodeId) } };
        }
        const nodePathNorm = resolvedPath === core.getPath(root) ? "" : resolvedPath;
        try {
            const node = nodePathNorm === "" ? root : await core.loadByPath(root, nodePathNorm);
            if (!node) {
                return { data: { error: "Node not found: " + toDisplayPath(nodeId) } };
            }
            const attrNames = core.getAttributeNames(node) || [];
            const regNames = core.getRegistryNames(node) || [];

            const name = args.name != null ? String(args.name).trim() : null;
            if (name) {
                // Single property: attributes have priority
                if (attrNames.includes(name)) {
                    const val = core.getAttribute(node, name);
                    return {
                        data: {
                            nodePath: toDisplayPath(core.getPath(node)),
                            name,
                            value: formatPropertyValue(val),
                            in: "attributes",
                        },
                    };
                }
                if (regNames.includes(name)) {
                    const val = core.getRegistry(node, name);
                    return {
                        data: {
                            nodePath: toDisplayPath(core.getPath(node)),
                            name,
                            value: formatPropertyValue(val),
                            in: "registry",
                        },
                    };
                }
                return { data: { error: "Property '" + name + "' not found. Use getProperty with no name to list available properties." } };
            }

            // List all
            const attributeValues: Record<string, string> = {};
            const registryValues: Record<string, string> = {};
            for (const n of attrNames) attributeValues[n] = formatPropertyValue(core.getAttribute(node, n));
            for (const n of regNames) registryValues[n] = formatPropertyValue(core.getRegistry(node, n));
            const valueFormats: Record<string, string> = {};
            for (const key of [...attrNames, ...regNames]) {
                const v = key in attributeValues ? attributeValues[key] : registryValues[key];
                if ((v === undefined || v === "") && VALUE_FORMAT_HINTS[key]) valueFormats[key] = VALUE_FORMAT_HINTS[key];
            }
            return {
                data: {
                    nodePath: toDisplayPath(core.getPath(node)),
                    attributes: attrNames,
                    registry: regNames,
                    attributeValues,
                    registryValues,
                    ...(Object.keys(valueFormats).length > 0 ? { valueFormats } : {}),
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "getProperty", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

/** Unified set: backend resolves attributes vs registry; attributes have priority. */
export const setProperty: Tool = {
    definition: {
        name: "setProperty",
        description:
            "Set a property on a node. The backend determines whether it is an attribute or registry entry (attributes have priority). " +
            "Use findNodesByName when the user refers to a node by name; pass the node path as nodeId. Call getProperty with no name first to see available properties and value formats.",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node path. From findNodesByName or omit for current selection.",
                },
                name: {
                    type: "string",
                    description: "Property name (e.g. name, position).",
                },
                value: {
                    type: "string",
                    description: "New value. Use the format from getProperty (attributeValues/registryValues or valueFormats).",
                },
            },
            required: ["name", "value"],
        },
    },
    handler: async (args, ctx) => {
        const nodeId = args.nodeId ?? getActiveNodeId(ctx);
        const name = args.name;
        const value = args.value;
        if (name == null || value === undefined) {
            return { data: { error: "name and value are required." } };
        }
        if (!nodeId) {
            return { data: { error: "No nodeId and no activeNodeId. Provide nodeId or ensure the client sends the active node." } };
        }
        if (!ctx.coreSession) {
            return {
                data: { set: true, nodeId, name },
                commands: [{ type: "setProperty", args: { nodeId, name, value: String(value) } }],
            };
        }
        const { core, root } = ctx.coreSession;
        const resolvedPath = await resolveNodePathOrName(core, root, nodeId);
        if (!resolvedPath) {
            return { data: { error: "Node not found: " + String(nodeId) } };
        }
        const nodePathNorm = resolvedPath === core.getPath(root) ? "" : resolvedPath;
        try {
            const node = nodePathNorm === "" ? root : await core.loadByPath(root, nodePathNorm);
            if (!node) {
                return { data: { error: "Node not found: " + toDisplayPath(nodeId) } };
            }
            const attrNames = core.getAttributeNames(node) || [];
            const regNames = core.getRegistryNames(node) || [];
            // Attributes have priority
            if (attrNames.includes(name)) {
                const res = core.setAttribute(node, name, value);
                if (res) return { data: { error: (res as any).message || String(res) } };
                await commitCoreSession(ctx.coreSession, "GMEBot: setProperty");
                return { data: { set: true, nodePath: toDisplayPath(core.getPath(node)), name, in: "attributes" } };
            }
            if (regNames.includes(name)) {
                let valueToSet: unknown = value;
                const currentVal = core.getRegistry(node, name);
                if (currentVal !== undefined && currentVal !== null && typeof currentVal === "object") {
                    try {
                        valueToSet = typeof value === "string" ? JSON.parse(value) : value;
                    } catch {
                        valueToSet = value;
                    }
                }
                const res = core.setRegistry(node, name, valueToSet);
                if (res) return { data: { error: (res as any).message || String(res) } };
                await commitCoreSession(ctx.coreSession, "GMEBot: setProperty");
                return { data: { set: true, nodePath: toDisplayPath(core.getPath(node)), name, in: "registry" } };
            }
            return { data: { error: "Property '" + name + "' not found. Call getProperty with no name to list available properties." } };
        } catch (e: any) {
            logToolFailure(ctx, "setProperty", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

/** @deprecated Use getProperty. Kept for bulkSet and tool map compatibility. */
export const getPropertyNames: Tool = {
    definition: {
        name: "getPropertyNames",
        description:
            "List property names and current values for a node (attributes and registry). " +
            "REQUIRED before any setAttribute or setRegistry: you cannot assume where a property lives—'name' may be in attributes or registry depending on the metamodel. Call this first for rename, set, change, or modify requests. " +
            "If the property is in 'registry' use setRegistry; if in 'attributes' use setAttribute. Use attributeValues and registryValues as the format when setting. When the user referred to a node by name, pass the node path from findNodesByName as nodeId here and in setAttribute/setRegistry.",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node path (e.g. '/1'). When the target node came from findNodesByName, pass one of nodePaths here. Otherwise omit to use current selection.",
                },
            },
            required: [],
        },
    },
    handler: async (args, ctx) => {
        const nodeId = args.nodeId ?? getActiveNodeId(ctx);
        if (nodeId == null || String(nodeId).trim() === "") {
            return {
                data: {
                    error: "No nodeId and no activeNodeId in request context. Provide nodeId or ensure the client sends the active node.",
                },
            };
        }
        if (!ctx.coreSession) {
            return {
                data: {
                    error: "Project context is required to list properties. Ensure a project is open and context is sent.",
                },
            };
        }
        const { core, root } = ctx.coreSession;
        const resolvedPath = await resolveNodePathOrName(core, root, nodeId);
        if (!resolvedPath) {
            return { data: { error: "Node not found (path or name): " + String(nodeId) } };
        }
        const nodePathNorm = resolvedPath === core.getPath(root) ? "" : resolvedPath;
        try {
            const node = nodePathNorm === "" ? root : await core.loadByPath(root, nodePathNorm);
            if (!node) {
                return { data: { error: "Node not found: " + toDisplayPath(nodeId) } };
            }
            const attributes: string[] = core.getAttributeNames(node) || [];
            const registry: string[] = core.getRegistryNames(node) || [];
            const attributeValues: Record<string, string> = {};
            const registryValues: Record<string, string> = {};
            for (const name of attributes) {
                attributeValues[name] = formatPropertyValue(core.getAttribute(node, name));
            }
            for (const name of registry) {
                registryValues[name] = formatPropertyValue(core.getRegistry(node, name));
            }
            const valueFormats: Record<string, string> = {};
            for (const key of [...attributes, ...registry]) {
                const current = key in attributeValues ? attributeValues[key] : registryValues[key];
                if ((current === undefined || current === "") && VALUE_FORMAT_HINTS[key]) {
                    valueFormats[key] = VALUE_FORMAT_HINTS[key];
                }
            }
            return {
                data: {
                    nodePath: toDisplayPath(core.getPath(node)),
                    attributes,
                    registry,
                    attributeValues,
                    registryValues,
                    ...(Object.keys(valueFormats).length > 0 ? { valueFormats } : {}),
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "getPropertyNames", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const setAttribute: Tool = {
    definition: {
        name: "setAttribute",
        description:
            "Set an attribute value on a node. Use ONLY when getPropertyNames shows the property in 'attributes'. " +
            "Never call without getPropertyNames first—you cannot assume 'name' is an attribute; it may be in registry. If in 'registry', use setRegistry instead. " +
            "When the user asks to change or set an attribute of a concept (e.g. 'rename Folder to X', 'set name of concept Y'), use findNodesByName to get the concept path, then getPropertyNames and setAttribute — do not use setMetaAttribute. " +
            "When you have a node path from findNodesByName, you MUST pass it as nodeId. Requires name and value.",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node path (e.g. '/1'). Required when the target node came from findNodesByName — use one of the nodePaths from that response. Otherwise defaults to activeNodeId.",
                },
                name: {
                    type: "string",
                    description: "Attribute name.",
                },
                value: {
                    type: "string",
                    description:
                        "New value. Use the same format as the current value in getPropertyNames (attributeValues); if none, use valueFormats when present.",
                },
            },
            required: ["name", "value"],
        },
    },
    handler: async (args, ctx) => {
        const nodeId = args.nodeId ?? getActiveNodeId(ctx);
        if (!nodeId) {
            return {
                data: {
                    error:
                        "No nodeId and no activeNodeId in request context. The client must send the active node with the request, or the user must provide nodeId.",
                },
            };
        }
        const name = args.name;
        const value = args.value;
        if (name === undefined || name === null || value === undefined) {
            return { data: { error: "name and value are required." } };
        }

        if (ctx.coreSession) {
            const { core, root, project, commitObject, branchName } = ctx.coreSession;
            const resolvedPath = await resolveNodePathOrName(core, root, nodeId);
            if (!resolvedPath) {
                return { data: { error: "Node not found (path or name): " + String(nodeId) } };
            }
            const nodePathNorm = resolvedPath === core.getPath(root) ? "" : resolvedPath;
            try {
                const node = nodePathNorm === "" ? root : await core.loadByPath(root, nodePathNorm);
                if (!node) {
                    return { data: { error: "Node not found: " + toDisplayPath(nodeId) } };
                }
                const res = core.setAttribute(node, name, value);
                if (res) {
                    return { data: { error: (res as any).message || String(res) } };
                }
                await commitCoreSession(ctx.coreSession, "GMEBot: setAttribute");
                return {
                    data: {
                        set: true,
                        nodePath: toDisplayPath(core.getPath(node)),
                        name,
                    },
                };
            } catch (e: any) {
                logToolFailure(ctx, "setAttribute", args, e);
                return { data: { error: (e && e.message) || String(e) } };
            }
        }

        return {
            data: { set: true, nodeId, name },
            commands: [
                {
                    type: "setAttribute",
                    args: { nodeId, name, value: String(value) },
                },
            ],
        };
    },
};

export const getAttribute: Tool = {
    definition: {
        name: "getAttribute",
        description:
            "Get an attribute value of a node. " +
            "Requires name; nodeId is optional (defaults to client-sent activeNodeId). " +
            "The value is retrieved on the client and shown in the chat.",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node ID. If omitted, the client-sent activeNodeId (current selection) is used.",
                },
                name: {
                    type: "string",
                    description: "Attribute name.",
                },
            },
            required: ["name"],
        },
    },
    handler: async (args, ctx) => {
        const nodeId = args.nodeId ?? getActiveNodeId(ctx);
        if (!nodeId) {
            return {
                data: {
                    error:
                        "No nodeId and no activeNodeId in request context. The client must send the active node with the request, or the user must provide nodeId.",
                },
            };
        }
        const name = args.name;
        if (name === undefined || name === null) {
            return { data: { error: "name is required." } };
        }
        let nodeIdForCommand = nodeId;
        if (ctx.coreSession) {
            const resolved = await resolveNodePathOrName(ctx.coreSession.core, ctx.coreSession.root, nodeId);
            if (resolved) nodeIdForCommand = toDisplayPath(resolved);
        }
        return {
            data: {
                message: "Requesting attribute from client; the value will appear in the chat.",
                nodeId: nodeIdForCommand,
                name,
            },
            commands: [
                {
                    type: "getAttribute",
                    args: { nodeId: nodeIdForCommand, name },
                },
            ],
        };
    },
};

export const clearAttribute: Tool = {
    definition: {
        name: "clearAttribute",
        description:
            "Clear (remove) an attribute value on a node so it falls back to inherited/default. " +
            "Requires name; nodeId is optional (defaults to client-sent activeNodeId).",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node ID. If omitted, the client-sent activeNodeId (current selection) is used.",
                },
                name: {
                    type: "string",
                    description: "Attribute name to clear.",
                },
            },
            required: ["name"],
        },
    },
    handler: async (args, ctx) => {
        const nodeId = args.nodeId ?? getActiveNodeId(ctx);
        if (!nodeId) {
            return {
                data: {
                    error:
                        "No nodeId and no activeNodeId in request context. The client must send the active node with the request, or the user must provide nodeId.",
                },
            };
        }
        const name = args.name;
        if (name === undefined || name === null) {
            return { data: { error: "name is required." } };
        }

        if (ctx.coreSession) {
            const { core, root, project, commitObject, branchName } = ctx.coreSession;
            const resolvedPath = await resolveNodePathOrName(core, root, nodeId);
            if (!resolvedPath) {
                return { data: { error: "Node not found (path or name): " + String(nodeId) } };
            }
            const nodePathNorm = resolvedPath === core.getPath(root) ? "" : resolvedPath;
            try {
                const node = nodePathNorm === "" ? root : await core.loadByPath(root, nodePathNorm);
                if (!node) {
                    return { data: { error: "Node not found: " + toDisplayPath(nodeId) } };
                }
                const res = core.delAttribute(node, name);
                if (res) {
                    return { data: { error: (res as any).message || String(res) } };
                }
                await commitCoreSession(ctx.coreSession, "GMEBot: clearAttribute");
                return {
                    data: {
                        cleared: true,
                        nodePath: toDisplayPath(core.getPath(node)),
                        name,
                    },
                };
            } catch (e: any) {
                logToolFailure(ctx, "clearAttribute", args, e);
                return { data: { error: (e && e.message) || String(e) } };
            }
        }

        return {
            data: { cleared: true, nodeId, name },
            commands: [
                {
                    type: "clearAttribute",
                    args: { nodeId, name },
                },
            ],
        };
    },
};

export const setRegistry: Tool = {
    definition: {
        name: "setRegistry",
        description:
            "Set a registry entry on a node. Use ONLY when getPropertyNames shows the property in 'registry'. " +
            "Never call without getPropertyNames first—you cannot assume where a property lives; 'name' may be in attributes or registry. If in 'attributes', use setAttribute instead. " +
            "When you have a node path from findNodesByName, you MUST pass it as nodeId. Requires name and value.",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node path (e.g. '/1'). Required when the target node came from findNodesByName — use one of the nodePaths from that response. Otherwise defaults to activeNodeId.",
                },
                name: {
                    type: "string",
                    description: "Registry entry name.",
                },
                value: {
                    type: "string",
                    description:
                        "New value. Use the same format as the current value in getPropertyNames (registryValues); if none, use valueFormats when present.",
                },
            },
            required: ["name", "value"],
        },
    },
    handler: async (args, ctx) => {
        const nodeId = args.nodeId ?? getActiveNodeId(ctx);
        if (!nodeId) {
            return {
                data: {
                    error:
                        "No nodeId and no activeNodeId in request context. The client must send the active node with the request, or the user must provide nodeId.",
                },
            };
        }
        const name = args.name;
        const value = args.value;
        if (name === undefined || name === null || value === undefined) {
            return { data: { error: "name and value are required." } };
        }

        if (ctx.coreSession) {
            const { core, root, project, commitObject, branchName } = ctx.coreSession;
            const resolvedPath = await resolveNodePathOrName(core, root, nodeId);
            if (!resolvedPath) {
                return { data: { error: "Node not found (path or name): " + String(nodeId) } };
            }
            const nodePathNorm = resolvedPath === core.getPath(root) ? "" : resolvedPath;
            try {
                const node = nodePathNorm === "" ? root : await core.loadByPath(root, nodePathNorm);
                if (!node) {
                    return { data: { error: "Node not found: " + toDisplayPath(nodeId) } };
                }
                let valueToSet: unknown = value;
                const currentVal = core.getRegistry(node, name);
                if (currentVal !== undefined && currentVal !== null && typeof currentVal === "object") {
                    try {
                        valueToSet = typeof value === "string" ? JSON.parse(value) : value;
                    } catch {
                        valueToSet = value;
                    }
                }
                const res = core.setRegistry(node, name, valueToSet);
                if (res) {
                    return { data: { error: (res as any).message || String(res) } };
                }
                await commitCoreSession(ctx.coreSession, "GMEBot: setRegistry");
                return {
                    data: {
                        set: true,
                        nodePath: toDisplayPath(core.getPath(node)),
                        name,
                    },
                };
            } catch (e: any) {
                logToolFailure(ctx, "setRegistry", args, e);
                return { data: { error: (e && e.message) || String(e) } };
            }
        }

        return {
            data: { set: true, nodeId, name },
            commands: [
                {
                    type: "setRegistry",
                    args: { nodeId, name, value: String(value) },
                },
            ],
        };
    },
};

export const getRegistry: Tool = {
    definition: {
        name: "getRegistry",
        description:
            "Get a registry entry value of a node. " +
            "Requires name; nodeId is optional (defaults to client-sent activeNodeId). " +
            "The value is retrieved on the client and shown in the chat.",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node ID. If omitted, the client-sent activeNodeId (current selection) is used.",
                },
                name: {
                    type: "string",
                    description: "Registry entry name.",
                },
            },
            required: ["name"],
        },
    },
    handler: async (args, ctx) => {
        const nodeId = args.nodeId ?? getActiveNodeId(ctx);
        if (!nodeId) {
            return {
                data: {
                    error:
                        "No nodeId and no activeNodeId in request context. The client must send the active node with the request, or the user must provide nodeId.",
                },
            };
        }
        const name = args.name;
        if (name === undefined || name === null) {
            return { data: { error: "name is required." } };
        }
        let nodeIdForCommand = nodeId;
        if (ctx.coreSession) {
            const resolved = await resolveNodePathOrName(ctx.coreSession.core, ctx.coreSession.root, nodeId);
            if (resolved) nodeIdForCommand = toDisplayPath(resolved);
        }
        return {
            data: {
                message: "Requesting registry value from client; the value will appear in the chat.",
                nodeId: nodeIdForCommand,
                name,
            },
            commands: [
                {
                    type: "getRegistry",
                    args: { nodeId: nodeIdForCommand, name },
                },
            ],
        };
    },
};

export const clearRegistry: Tool = {
    definition: {
        name: "clearRegistry",
        description:
            "Clear (remove) a registry entry on a node. " +
            "Requires name; nodeId is optional (defaults to client-sent activeNodeId).",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node ID. If omitted, the client-sent activeNodeId (current selection) is used.",
                },
                name: {
                    type: "string",
                    description: "Registry entry name to clear.",
                },
            },
            required: ["name"],
        },
    },
    handler: async (args, ctx) => {
        const nodeId = args.nodeId ?? getActiveNodeId(ctx);
        if (!nodeId) {
            return {
                data: {
                    error:
                        "No nodeId and no activeNodeId in request context. The client must send the active node with the request, or the user must provide nodeId.",
                },
            };
        }
        const name = args.name;
        if (name === undefined || name === null) {
            return { data: { error: "name is required." } };
        }

        if (ctx.coreSession) {
            const { core, root, project, commitObject, branchName } = ctx.coreSession;
            const resolvedPath = await resolveNodePathOrName(core, root, nodeId);
            if (!resolvedPath) {
                return { data: { error: "Node not found (path or name): " + String(nodeId) } };
            }
            const nodePathNorm = resolvedPath === core.getPath(root) ? "" : resolvedPath;
            try {
                const node = nodePathNorm === "" ? root : await core.loadByPath(root, nodePathNorm);
                if (!node) {
                    return { data: { error: "Node not found: " + toDisplayPath(nodeId) } };
                }
                const res = core.delRegistry(node, name);
                if (res) {
                    return { data: { error: (res as any).message || String(res) } };
                }
                await commitCoreSession(ctx.coreSession, "GMEBot: clearRegistry");
                return {
                    data: {
                        cleared: true,
                        nodePath: toDisplayPath(core.getPath(node)),
                        name,
                    },
                };
            } catch (e: any) {
                logToolFailure(ctx, "clearRegistry", args, e);
                return { data: { error: (e && e.message) || String(e) } };
            }
        }

        return {
            data: { cleared: true, nodeId, name },
            commands: [
                {
                    type: "clearRegistry",
                    args: { nodeId, name },
                },
            ],
        };
    },
};

/**
 * Bulk-set attributes and registry entries on multiple nodes, then commit once.
 * Use this to apply layout or other multi-node changes in a single commit (e.g. after getDiagramLayout).
 * Each node is loaded by path; attributes and registry are applied in turn. One commit at the end.
 */
export const bulkSet: Tool = {
    definition: {
        name: "bulkSet",
        description:
            "Set attributes and registry entries on multiple nodes in one go, then save and commit once. " +
            "Use after getDiagramLayout when the user asks to arrange or layout nodes: pass the node paths with the new positions (and optionally other attributes/registry). " +
            "Each item in nodes has path (node path), and optionally attributes (name→value) and registry (name→value). " +
            "Registry values that are objects (e.g. position) can be passed as JSON strings or objects. One commit after all changes.",
        parameters: {
            type: "object",
            properties: {
                nodes: {
                    type: "array",
                    description:
                        "Array of { path: string, attributes?: Record<string, string>, registry?: Record<string, value> }. path is the node path (e.g. '/1' or '/1/2').",
                    items: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Node path." },
                            attributes: {
                                type: "object",
                                description: "Attribute name → value (string).",
                                additionalProperties: { type: "string" },
                            },
                            registry: {
                                type: "object",
                                description: "Registry name → value (string or object, e.g. position: { x, y }).",
                                additionalProperties: true,
                            },
                        },
                        required: ["path"],
                    },
                } as import("../tools").ToolParameter,
            },
            required: ["nodes"],
        },
    },
    handler: async (args, ctx) => {
        if (!ctx.coreSession) {
            return {
                data: {
                    error:
                        "Project context is required for bulkSet. The client must send projectId (and optionally branchName) in the request context.",
                },
            };
        }
        const nodesArg = args.nodes;
        if (!Array.isArray(nodesArg) || nodesArg.length === 0) {
            return { data: { error: "nodes must be a non-empty array of { path, attributes?, registry? }." } };
        }
        const { core, root } = ctx.coreSession;
        const errors: string[] = [];
        const updated: string[] = [];
        try {
            for (const item of nodesArg) {
                const pathRaw = item?.path != null ? String(item.path).trim() : "";
                const resolvedPath = await resolveNodePathOrName(core, root, pathRaw || undefined);
                if (!resolvedPath) {
                    errors.push("Node not found (path or name): " + (pathRaw || "(root)"));
                    continue;
                }
                const pathNorm = resolvedPath === core.getPath(root) ? "" : resolvedPath;
                const node = pathNorm === "" ? root : await core.loadByPath(root, pathNorm);
                if (!node) {
                    errors.push("Node not found: " + (pathRaw || "(root)"));
                    continue;
                }
                const nodePath = core.getPath(node);
                if (item.attributes && typeof item.attributes === "object") {
                    for (const [name, value] of Object.entries(item.attributes)) {
                        if (name === undefined || value === undefined) continue;
                        const res = core.setAttribute(node, name, String(value));
                        if (res) {
                            errors.push(toDisplayPath(nodePath) + " setAttribute(" + name + "): " + ((res as any).message || String(res)));
                        }
                    }
                }
                if (item.registry && typeof item.registry === "object") {
                    for (const [name, value] of Object.entries(item.registry)) {
                        if (name === undefined) continue;
                        let valueToSet: unknown = value;
                        const currentVal = core.getRegistry(node, name);
                        if (currentVal !== undefined && currentVal !== null && typeof currentVal === "object" && typeof value === "string") {
                            try {
                                valueToSet = JSON.parse(value);
                            } catch {
                                valueToSet = value;
                            }
                        }
                        const res = core.setRegistry(node, name, valueToSet);
                        if (res) {
                            errors.push(toDisplayPath(nodePath) + " setRegistry(" + name + "): " + ((res as any).message || String(res)));
                        }
                    }
                }
                updated.push(toDisplayPath(nodePath));
            }
            if (errors.length > 0 && updated.length === 0) {
                return { data: { error: errors.join("; ") } };
            }
            await commitCoreSession(ctx.coreSession, "GMEBot: bulkSet");
            return {
                data: {
                    committed: true,
                    updated,
                    ...(errors.length > 0 ? { warnings: errors } : {}),
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "bulkSet", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

/**
 * Get the current diagram layout (node/concept positions and optional dimensions) for the active diagram.
 * Works for both model diagram and meta diagram: layout is collected from whichever visualizer is active.
 * Layout is only available on the client. If context.diagramLayout is not set, returns needClientData
 * so the client will send a continuation request with the layout.
 */
export const getDiagramLayout: Tool = {
    definition: {
        name: "getDiagramLayout",
        description:
            "Get the layout of the **current** diagram (active visualizer): **diagram scope** — one level, what is on the canvas. " +
            "Returns paths with positions (x, y) and optional dimensions; connections when available. Model and meta editor. " +
            "Use for arrange/align and for anything that means **only this diagram** (list/count/delete on-canvas nodes). " +
            "For multi-level hierarchy under a specific model fragment, use listNodes with a container instead. " +
            "Layout comes from the client; if not yet available, the backend requests it and continues.",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
    },
    handler: async (_args, ctx) => {
        const layout = ctx.context?.diagramLayout;
        if (layout && Array.isArray(layout.nodes)) {
            return { data: { diagramLayout: layout } };
        }
        return {
            data: { needClientData: NEED_CLIENT_DATA_KEYS.diagramLayout },
        };
    },
};

export const NODE_TOOLS: Tool[] = [
    createNode,
    moveNode,
    listNodes,
    deleteNode,
    findNodesByName,
    getProperty,
    setProperty,
    getDiagramLayout,
    clearAttribute,
    clearRegistry,
    bulkSet,
];
