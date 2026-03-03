import { Tool, ToolContext, commitCoreSession } from "../tools";

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
            "Create a new node in the WebGME model (server-side). No arguments are required. " +
            "When the user says 'create a node' or 'add a node' without specifying type or parent, call createNode with an empty object {} — do NOT ask the user for type or parent; the backend uses defaults (current selection or root as parent, FCO as type). " +
            "Only pass container or baseType when the user explicitly specifies a parent path or a type. Never pass projectId as container. " +
            "FCO means First Class Object (not Foundation Class Object). " +
            "The tool returns nodePath (the node's path, e.g. '/1' or '/1/2'). Paths are project-specific; the FCO is typically at '/1', root at '/'. Do not assume or guess paths — use only paths returned by tools (createNode, findNodesByName, getPropertyNames). nodePath is an identifier, NOT the node's name.",
        parameters: {
            type: "object",
            properties: {
                baseType: {
                    type: "string",
                    description:
                        "Optional. Omit unless user specifies a type. Default is FCO (First Class Object).",
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
            // Load container (parent) from root by path; plugin pattern: load root then loadByPath(root, path).
            const containerPathNorm = normalizePath(containerPath);
            const parentNode =
                containerPathNorm === ""
                    ? root
                    : await core.loadByPath(root, containerPathNorm);
            if (!parentNode) {
                return { data: { error: "Container node not found: " + containerPath } };
            }

            // Resolve base: FCO/default -> getFCO(root) or getBase(root); path -> loadByPath(root, path).
            let baseNode: any;
            if (!baseType || baseType === DEFAULT_BASE_TYPE || !String(baseType).includes(PATH_SEP)) {
                baseNode = core.getBase(root) ?? core.getFCO(root) ?? root;
            } else {
                const basePathNorm = normalizePath(baseType);
                baseNode = basePathNorm === "" ? root : await core.loadByPath(root, basePathNorm);
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
            ctx.logger.warn("createNode failed: " + (e && e.message));
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const moveNode: Tool = {
    definition: {
        name: "moveNode",
        description:
            "Move a node to a new parent (container). " +
            "Requires nodeId (the node to move) and newContainer (the new parent node ID). " +
            "If newContainer is omitted, the client-sent context activeNodeId (current selection) is used as the new parent.",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "The node ID to move.",
                },
                newContainer: {
                    type: "string",
                    description:
                        "The new parent node ID. If omitted, the client-sent activeNodeId (current selection) is used.",
                },
            },
            required: ["nodeId"],
        },
    },
    handler: async (args, ctx) => {
        const nodeId = args.nodeId;
        if (!nodeId) {
            return { data: { error: "nodeId is required." } };
        }
        const newContainer = args.newContainer ?? getActiveNodeId(ctx);
        if (!newContainer) {
            return {
                data: {
                    error:
                        "No newContainer specified and no activeNodeId in request context. The client must send the active node, or the user must provide newContainer.",
                },
            };
        }
        return {
            data: { moved: true, nodeId, newContainer },
            commands: [
                {
                    type: "moveNode",
                    args: { nodeId, newContainer },
                },
            ],
        };
    },
};

export const deleteNode: Tool = {
    definition: {
        name: "deleteNode",
        description: "Delete a node from the model. Requires nodeId (node path with leading slash, e.g. '/1' or '/1/2'). The node and its descendants are removed.",
        parameters: {
            type: "object",
            properties: {
                nodeId: {
                    type: "string",
                    description: "Node path to delete (e.g. '/1', '/1/2'). Use leading slash; root is '/'.",
                },
            },
            required: ["nodeId"],
        },
    },
    handler: async (args, ctx) => {
        const nodeId = args.nodeId;
        if (nodeId == null || String(nodeId).trim() === "") {
            return { data: { error: "nodeId is required." } };
        }
        const nodePathNorm = normalizePath(nodeId);

        if (ctx.coreSession) {
            const { core, root, project, commitObject, branchName } = ctx.coreSession;
            try {
                const node = await core.loadByPath(root, nodePathNorm);
                if (!node) {
                    return { data: { error: "Node not found: " + toDisplayPath(nodeId) } };
                }
                core.deleteNode(node);
                await commitCoreSession(ctx.coreSession, "GMEBot: deleteNode");
                return {
                    data: { deleted: true, nodePath: toDisplayPath(nodePathNorm) },
                    commands: [{ type: "deleteNode", args: { nodeId: toDisplayPath(nodePathNorm) } }],
                };
            } catch (e: any) {
                ctx.logger.warn("deleteNode failed: " + (e && e.message));
                return { data: { error: (e && e.message) || String(e) } };
            }
        }

        return {
            data: { deleted: true, nodeId: toDisplayPath(nodeId) },
            commands: [{ type: "deleteNode", args: { nodeId: toDisplayPath(nodeId) } }],
        };
    },
};

/** Find nodes whose 'name' attribute equals the given name. Use when the user refers to a node by name (e.g. 'the node named X'). */
export const findNodesByName: Tool = {
    definition: {
        name: "findNodesByName",
        description:
            "Find node path(s) by the node's name attribute. Call this when the user refers to a node by name (e.g. 'the node named MyNode', 'set position of X'). " +
            "The response includes nodePaths (array). You MUST pass one of these paths as nodeId in the next tool call (getPropertyNames, setAttribute, or setRegistry) that targets that node — do not omit nodeId. If multiple nodes match, use the path that fits the user's context.",
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

            return {
                data: {
                    name: searchName,
                    nodePaths,
                    count: nodePaths.length,
                },
            };
        } catch (e: any) {
            ctx.logger.warn("findNodesByName failed: " + (e && e.message));
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

/** Discovery tool: returns property names and current values so the LLM can use setAttribute/setRegistry with the correct name and format. */
export const getPropertyNames: Tool = {
    definition: {
        name: "getPropertyNames",
        description:
            "List property names and current values for a node (attributes and registry). " +
            "You MUST call this before setAttribute/setRegistry: if the property is in 'registry' use setRegistry; if in 'attributes' use setAttribute. A property appears in only one list — never use setAttribute for a name that is in registry (e.g. position is in registry). " +
            "Use attributeValues and registryValues as the format when setting. When the user referred to a node by name, pass the node path from findNodesByName as nodeId here and in setAttribute/setRegistry.",
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
        const nodePathNorm = normalizePath(nodeId);
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
            ctx.logger.warn("getPropertyNames failed: " + (e && e.message));
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const setAttribute: Tool = {
    definition: {
        name: "setAttribute",
        description:
            "Set an attribute value on a node. Use ONLY when the property is in getPropertyNames 'attributes'. " +
            "If the property is in 'registry' you MUST use setRegistry instead (e.g. position is in registry — use setRegistry). Always call getPropertyNames first. " +
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
            const nodePathNorm = normalizePath(nodeId);
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
                ctx.logger.warn("setAttribute failed: " + (e && e.message));
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
        return {
            data: {
                message: "Requesting attribute from client; the value will appear in the chat.",
                nodeId,
                name,
            },
            commands: [
                {
                    type: "getAttribute",
                    args: { nodeId, name },
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
            const nodePathNorm = normalizePath(nodeId);
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
                ctx.logger.warn("clearAttribute failed: " + (e && e.message));
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
            "Set a registry entry on a node. Use when the property is in getPropertyNames 'registry'. " +
            "If the property is in 'attributes' use setAttribute instead. Position and other layout keys are in registry — use setRegistry. Always call getPropertyNames first. " +
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
            const nodePathNorm = normalizePath(nodeId);
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
                ctx.logger.warn("setRegistry failed: " + (e && e.message));
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
        return {
            data: {
                message: "Requesting registry value from client; the value will appear in the chat.",
                nodeId,
                name,
            },
            commands: [
                {
                    type: "getRegistry",
                    args: { nodeId, name },
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
            const nodePathNorm = normalizePath(nodeId);
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
                ctx.logger.warn("clearRegistry failed: " + (e && e.message));
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

export const NODE_TOOLS: Tool[] = [
    createNode,
    moveNode,
    deleteNode,
    findNodesByName,
    getPropertyNames,
    setAttribute,
    getAttribute,
    clearAttribute,
    setRegistry,
    getRegistry,
    clearRegistry,
];
