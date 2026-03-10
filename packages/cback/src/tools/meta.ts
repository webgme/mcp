import { Tool, commitCoreSession, logToolFailure } from "../tools";
import { getDiagramLayout } from "./node";

const META_SHEETS_REGISTRY = "MetaSheets";
const META_ASPECT_SET_NAME = "MetaAspectSet";
const META_ASPECT_SHEET_PREFIX = "MetaAspectSet_";
/** Registry key for concept position on a meta sheet (matches WebGME client REGISTRY_KEYS.POSITION). */
const POSITION_REGISTRY_KEY = "position";

function ensureCoreSession(ctx: any) {
    if (!ctx.coreSession) {
        throw new Error(
            "Meta tools require an open project with coreSession. Ensure the client sends projectId (and branch) in context."
        );
    }
}

/**
 * Resolve the active meta sheet SetID from context (activeTabId). Sheets are sorted by order; the tab index selects the sheet.
 * Returns null if no sheets or activeTabId is invalid.
 */
function getActiveSheetSetId(ctx: any): string | null {
    if (!ctx.coreSession) return null;
    const { core, root } = ctx.coreSession;
    const rawSheets = core.getRegistry(root, META_SHEETS_REGISTRY) || [];
    const sheets: any[] = Array.isArray(rawSheets) ? rawSheets.slice() : [];
    if (sheets.length === 0) return null;
    sheets.sort((a: any, b: any) => {
        const ao = typeof a.order === "number" ? a.order : 0;
        const bo = typeof b.order === "number" ? b.order : 0;
        return ao - bo;
    });
    const tabIndex = typeof ctx.context?.activeTabId === "number" ? ctx.context.activeTabId : 0;
    const sheet = sheets[tabIndex];
    return sheet && sheet.SetID ? sheet.SetID : sheets[0]?.SetID ?? null;
}

/**
 * Resolve concept path or name to an absolute path.
 * - '/' or root path returns root path.
 * - If value starts with '/', first try loadByPath; if that fails, treat the remainder as concept name (e.g. /FCO → name "FCO").
 * - Otherwise treat as concept name and resolve via MetaAspectSet (getAllMetaNodes); returns first match by 'name' attribute.
 * This avoids the LLM confusing names with paths: "/FCO" is the FCO concept's name, not its path (path is project-specific e.g. /1).
 */
async function resolveMetaPathOrName(
    core: any,
    root: any,
    pathOrName: string
): Promise<string | null> {
    const s = String(pathOrName ?? "").trim();
    if (!s) return null;
    if (s === "/") return core.getPath(root);
    const metaDict = core.getAllMetaNodes(root) || {};
    const resolveByName = (name: string): string | null => {
        for (const path of Object.keys(metaDict)) {
            const node = metaDict[path];
            if (!node) continue;
            const attr = core.getAttribute(node, "name");
            if (attr != null && String(attr).trim() === name) return path;
        }
        return null;
    };
    if (s.startsWith("/")) {
        const pathPart = s.slice(1);
        if (!pathPart) return core.getPath(root);
        const byPath = await core.loadByPath(root, s);
        if (byPath) return core.getPath(byPath);
        return resolveByName(pathPart);
    }
    return resolveByName(s);
}

/** Normalize connection-style pointer names to WebGME reserved 'src' and 'dst'. */
function normalizeConnectionPointerName(raw: string): string {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s === "source" || s === "from" || s === "origin") return "src";
    if (s === "destination" || s === "to" || s === "sink") return "dst";
    if (s === "src" || s === "dst") return s;
    return String(raw ?? "").trim();
}

/** Get targetPath from a pointer/set item; tolerate common LLM typos (e.g. target,Path). */
function getPointerTargetPath(item: any): string {
    if (item == null) return "";
    const v = item.targetPath ?? item.target_path ?? (item as any)["target,Path"];
    return v != null ? String(v).trim() : "";
}

function generateGuid(): string {
    // Lightweight GUID-style generator (matches standard WebGME client behavior for meta sheets).
    const s4 = () =>
        Math.floor((1 + Math.random()) * 0x10000)
            .toString(16)
            .substring(1);
    return (
        s4() +
        s4() +
        "-" +
        s4() +
        "-" +
        s4() +
        "-" +
        s4() +
        "-" +
        s4() +
        s4() +
        s4()
    );
}

export const createMetaSheet: Tool = {
    definition: {
        name: "createMetaSheet",
        description:
            "Create a new meta aspect sheet for the current project. " +
            "Runs on the server: adds a new set on the ROOT node and updates the MetaSheets registry. " +
            "Returns the new SetID, title, and order. Uses a generated SetID like the standard WebGME client.",
        parameters: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description:
                        "Optional title for the new sheet. Defaults to 'New sheet' if omitted.",
                },
            },
            required: [],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;

        try {
            const rawSheets = core.getRegistry(root, META_SHEETS_REGISTRY) || [];
            const sheets: any[] = Array.isArray(rawSheets) ? rawSheets.slice() : [];

            sheets.sort((a, b) => {
                const ao = typeof a.order === "number" ? a.order : 0;
                const bo = typeof b.order === "number" ? b.order : 0;
                return ao - bo;
            });
            sheets.forEach((s, idx) => {
                s.order = idx;
            });

            const setId = META_ASPECT_SHEET_PREFIX + generateGuid();
            const title =
                typeof args.title === "string" && args.title.trim() !== ""
                    ? String(args.title).trim()
                    : "New sheet";

            core.createSet(root, setId);

            const newSheetDesc = {
                SetID: setId,
                order: sheets.length,
                title,
            };
            sheets.push(newSheetDesc);
            core.setRegistry(root, META_SHEETS_REGISTRY, sheets);

            await commitCoreSession(ctx.coreSession, "GMEBot: createMetaSheet");

            return {
                data: {
                    created: true,
                    setId,
                    title,
                    order: newSheetDesc.order,
                    sheets,
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "createMetaSheet", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const switchToMetaSheet: Tool = {
    definition: {
        name: "switchToMetaSheet",
        description:
            "Select a meta aspect sheet for subsequent meta operations (server-side selection only; does not change the browser UI). " +
            "Resolves the sheet by SetID or title and returns the resolved sheet and all available sheets.",
        parameters: {
            type: "object",
            properties: {
                setId: {
                    type: "string",
                    description:
                        "SetID of the sheet (e.g. 'MetaAspectSet_...'). If provided, this takes precedence over title.",
                },
                title: {
                    type: "string",
                    description:
                        "Optional sheet title to resolve when setId is not given.",
                },
            },
            required: [],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;

        const rawSheets = core.getRegistry(root, META_SHEETS_REGISTRY) || [];
        const sheets: any[] = Array.isArray(rawSheets) ? rawSheets.slice() : [];

        if (sheets.length === 0) {
            return { data: { error: "No meta sheets are defined in this project." } };
        }

        const bySetId = typeof args.setId === "string" && args.setId.trim() !== "";
        const byTitle = !bySetId && typeof args.title === "string" && args.title.trim() !== "";

        let selected: any | null = null;
        if (bySetId) {
            const wanted = String(args.setId).trim();
            selected = sheets.find((s) => s.SetID === wanted) || null;
        } else if (byTitle) {
            const wantedTitle = String(args.title).trim();
            selected = sheets.find((s) => s.title === wantedTitle) || null;
        } else {
            // Default to the first sheet (order 0) if no discriminator given.
            sheets.sort((a, b) => {
                const ao = typeof a.order === "number" ? a.order : 0;
                const bo = typeof b.order === "number" ? b.order : 0;
                return ao - bo;
            });
            selected = sheets[0];
        }

        if (!selected) {
            return {
                data: {
                    error: "Meta sheet not found. Provide a valid setId or title.",
                    sheets,
                },
            };
        }

        return {
            data: {
                currentSetId: selected.SetID,
                title: selected.title,
                order: selected.order,
                sheets,
            },
        };
    },
};

export const deleteMetaSheet: Tool = {
    definition: {
        name: "deleteMetaSheet",
        description:
            "Delete a meta aspect sheet. Runs on the server: removes the sheet set on the ROOT, updates the MetaSheets registry, " +
            "and for any node that is no longer present on any named meta sheet, removes it from MetaAspectSet and clears all its meta rules.",
        parameters: {
            type: "object",
            properties: {
                setId: {
                    type: "string",
                    description:
                        "SetID of the meta sheet to delete (e.g. 'MetaAspectSet_...').",
                },
            },
            required: ["setId"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;

        const setIdRaw: string = args.setId;
        const setId = String(setIdRaw || "").trim();
        if (!setId) {
            return { data: { error: "setId is required." } };
        }

        try {
            const rawSheets = core.getRegistry(root, META_SHEETS_REGISTRY) || [];
            let sheets: any[] = Array.isArray(rawSheets) ? rawSheets.slice() : [];

            const sheetIndex = sheets.findIndex((s) => s.SetID === setId);
            if (sheetIndex === -1) {
                return {
                    data: {
                        error:
                            "Meta sheet not found: " +
                            setId +
                            ". Use switchToMetaSheet or inspect MetaSheets to discover valid SetIDs.",
                    },
                };
            }

            // Build membership map: memberPath -> number of sheets containing it.
            const membershipCount = new Map<string, number>();
            for (const sheet of sheets) {
                const sheetSetId: string = sheet.SetID;
                const members: string[] =
                    core.getMemberPaths(root, sheetSetId) || [];
                for (const path of members) {
                    membershipCount.set(path, (membershipCount.get(path) || 0) + 1);
                }
            }

            const itemsOfAspect: string[] =
                core.getMemberPaths(root, setId) || [];
            const toLose: string[] = [];

            for (const path of itemsOfAspect) {
                const count = membershipCount.get(path) || 0;
                if (count === 1) {
                    // Only present on this sheet; candidate for removal from MetaAspectSet.
                    const node = await core.loadByPath(root, path);
                    if (!node) {
                        continue;
                    }
                    const isLib =
                        typeof core.isLibraryElement === "function" &&
                        (core.isLibraryElement(node) ||
                            (typeof core.isLibraryRoot === "function" &&
                                core.isLibraryRoot(node)));
                    if (!isLib) {
                        toLose.push(path);
                    }
                }
            }

            // Apply deletions.
            for (const path of toLose) {
                core.delMember(root, META_ASPECT_SET_NAME, path);
                const node = await core.loadByPath(root, path);
                if (node && typeof core.setMeta === "function") {
                    core.setMeta(node, {});
                }
            }

            // Remove sheet descriptor and re-normalize orders.
            sheets.splice(sheetIndex, 1);
            sheets.sort((a, b) => {
                const ao = typeof a.order === "number" ? a.order : 0;
                const bo = typeof b.order === "number" ? b.order : 0;
                return ao - bo;
            });
            sheets.forEach((s, idx) => {
                s.order = idx;
            });
            core.setRegistry(root, META_SHEETS_REGISTRY, sheets);

            // Delete the underlying set.
            core.deleteSet(root, setId);

            await commitCoreSession(ctx.coreSession, "GMEBot: deleteMetaSheet");

            return {
                data: {
                    deleted: true,
                    setId,
                    removedMetaMembers: toLose,
                    sheets,
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "deleteMetaSheet", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const isMetaNodeTool: Tool = {
    definition: {
        name: "isMetaNode",
        description:
            "Check if a node is a META node (i.e. a member of the global MetaAspectSet). " +
            "Use this to validate bases before creating new concepts.",
        parameters: {
            type: "object",
            properties: {
                nodePath: {
                    type: "string",
                    description:
                        "Absolute path of the node to check ('' or '/' for the project root).",
                },
            },
            required: ["nodePath"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;

        const rawPath: string = args.nodePath;
        const path = String(rawPath ?? "").trim();
        try {
            const node =
                path === "" || path === "/"
                    ? root
                    : await core.loadByPath(root, path);
            if (!node) {
                return {
                    data: {
                        nodePath: path,
                        isMetaNode: false,
                        error: "Node not found at path " + path,
                    },
                };
            }
            const isMeta =
                typeof core.isMetaNode === "function"
                    ? core.isMetaNode(node)
                    : false;
            return {
                data: {
                    nodePath: core.getPath(node),
                    isMetaNode: isMeta,
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "isMetaNode", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const createMetaNode: Tool = {
    definition: {
        name: "createMetaNode",
        description:
            "Create a new META concept (meta-node) under the project ROOT. Use for new concepts/types/metamodel elements—not for instance nodes (use createNode). " +
            "Optional: pass 'contains' to define what the new concept can contain; 'pointers' for 0..1 references. For connection/edge/link concepts you MUST use pointer names 'src' and 'dst' only (e.g. pointers: [{ pointerName: 'src', targetPath: 'NodeA' }, { pointerName: 'dst', targetPath: 'NodeB' }]). Prefer 'src' and 'dst' for connection endpoints so WebGME shows them as connections. For other concepts use any pointer names (e.g. 'target', 'parent'). 'sets' for multi-target references. Backend does concept + all relations in one step. " +
            "basePath: concept name (e.g. FCO) or path from getMetaInfo; omit for FCO.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "Name attribute for the new concept.",
                },
                basePath: {
                    type: "string",
                    description:
                        "Optional. Base concept name (e.g. FCO) or path from getMetaInfo. Omit to use FCO.",
                },
                contains: {
                    type: "array",
                    description:
                        "Optional. Types this concept can contain. Each item: { targetPath: string, min?: number, max?: number }. targetPath = concept name or path (e.g. FCO). Omit min/max for any amount.",
                    items: {
                        type: "object",
                        properties: {
                            targetPath: { type: "string", description: "Contained concept name or path (e.g. FCO)." },
                            min: { type: "number", description: "Optional minimum cardinality." },
                            max: { type: "number", description: "Optional maximum; omit for unlimited." },
                        },
                        required: ["targetPath"],
                    },
                } as import("../tools").ToolParameter,
                pointers: {
                    type: "array",
                    description:
                        "Optional. Pointers on this concept (0..1 each). Each item: { pointerName: string, targetPath: string }. For connection/edge concepts prefer pointerName 'src' and 'dst' so WebGME shows them as connections; order is preserved. targetPath = concept name or path. You can instead create the concept then call setMetaPointer for each pointer if you prefer.",
                    items: {
                        type: "object",
                        properties: {
                            pointerName: { type: "string", description: "Pointer name. For connections prefer 'src' or 'dst' for correct display; backend maps source/destination/from/to to src/dst. Otherwise e.g. 'target', 'parent'." },
                            targetPath: { type: "string", description: "Valid target concept name or path." },
                        },
                        required: ["pointerName", "targetPath"],
                    },
                } as import("../tools").ToolParameter,
                sets: {
                    type: "array",
                    description:
                        "Optional. Sets on this concept (multi-reference). Each item: { setName: string, targetPath: string, min?: number, max?: number }. Omit min/max for no limit.",
                    items: {
                        type: "object",
                        properties: {
                            setName: { type: "string", description: "Set name (e.g. 'members', 'refs')." },
                            targetPath: { type: "string", description: "Valid target concept name or path." },
                            min: { type: "number", description: "Optional minimum." },
                            max: { type: "number", description: "Optional maximum; -1 for no limit." },
                        },
                        required: ["setName", "targetPath"],
                    },
                } as import("../tools").ToolParameter,
            },
            required: ["name"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;

        const nameRaw: string = args.name;
        const name = String(nameRaw ?? "").trim();
        if (!name) {
            return { data: { error: "name is required." } };
        }

        try {
            // Resolve base meta-node: accept path (e.g. from getMetaInfo) or concept name (e.g. FCO or /FCO).
            let baseNode: any = null;
            const basePathRaw: string | undefined = args.basePath;
            const basePath =
                basePathRaw != null ? String(basePathRaw).trim() : "";
            if (basePath) {
                const resolvedPath = await resolveMetaPathOrName(core, root, basePath);
                if (resolvedPath == null) {
                    return {
                        data: {
                            error: "Base concept not found: '" + basePath + "'. Use a concept name (e.g. FCO) or a path from getMetaInfo (concepts[].path).",
                        },
                    };
                }
                const candidate =
                    resolvedPath === core.getPath(root) ? root : await core.loadByPath(root, resolvedPath);
                if (!candidate) {
                    return {
                        data: {
                            error: "Base node not found at resolved path " + resolvedPath,
                        },
                    };
                }
                const isMeta =
                    typeof core.isMetaNode === "function"
                        ? core.isMetaNode(candidate)
                        : false;
                if (!isMeta) {
                    return {
                        data: {
                            error:
                                "Resolved base at path " +
                                resolvedPath +
                                " is not a META node. Use isMetaNode to inspect bases.",
                        },
                    };
                }
                baseNode = candidate;
            } else {
                // Default to FCO as base when omitted.
                baseNode =
                    typeof core.getFCO === "function"
                        ? core.getFCO(root)
                        : null;
                if (!baseNode) {
                    return {
                        data: {
                            error:
                                "Could not resolve FCO for default base when creating meta node.",
                        },
                    };
                }
            }

            // Create the node under ROOT with the chosen base.
            const created = core.createNode({ parent: root, base: baseNode });
            if (created && typeof (created as any).message === "string") {
                return { data: { error: (created as any).message } };
            }
            const node = created;
            const nodePath = core.getPath(node);

            core.setAttribute(node, "name", name);

            // Add to global MetaAspectSet.
            core.addMember(root, META_ASPECT_SET_NAME, node);

            // If there is at least one meta sheet, add to the first one (by order).
            const rawSheets =
                core.getRegistry(root, META_SHEETS_REGISTRY) || [];
            const sheets: any[] = Array.isArray(rawSheets)
                ? rawSheets.slice()
                : [];
            if (sheets.length > 0) {
                sheets.sort((a, b) => {
                    const ao = typeof a.order === "number" ? a.order : 0;
                    const bo = typeof b.order === "number" ? b.order : 0;
                    return ao - bo;
                });
                const first = sheets[0];
                if (first && first.SetID) {
                    core.addMember(root, first.SetID, node);
                }
            }

            const containmentsDone: Array<{ targetPath: string; min?: number; max?: number }> = [];
            const containsArg = args.contains;
            if (Array.isArray(containsArg) && containsArg.length > 0) {
                for (const item of containsArg) {
                    const targetPathOrName = item?.targetPath != null ? String(item.targetPath).trim() : "";
                    if (!targetPathOrName) continue;
                    const targetPath = await resolveMetaPathOrName(core, root, targetPathOrName);
                    if (targetPath == null) {
                        ctx.logger.warn("createMetaNode contains: target not found '" + targetPathOrName + "'");
                        continue;
                    }
                    const targetNode = targetPath === core.getPath(root) ? root : await core.loadByPath(root, targetPath);
                    if (!targetNode) continue;
                    const isTargetMeta = typeof core.isMetaNode === "function" ? core.isMetaNode(targetNode) : false;
                    if (!isTargetMeta) continue;
                    const min = typeof item.min === "number" ? item.min : undefined;
                    const max = typeof item.max === "number" ? item.max : undefined;
                    const res = core.setChildMeta(node, targetNode, min, max);
                    if (res) {
                        ctx.logger.warn("createMetaNode setChildMeta: " + (res as any).message);
                        continue;
                    }
                    containmentsDone.push({ targetPath, min, max });
                }
            }

            const pointersDone: Array<{ pointerName: string; targetPath: string }> = [];
            const pointersArg = args.pointers;
            if (Array.isArray(pointersArg) && pointersArg.length > 0) {
                for (const item of pointersArg) {
                    const rawPointerName = item?.pointerName != null ? String(item.pointerName).trim() : "";
                    const pointerName = normalizeConnectionPointerName(rawPointerName) || rawPointerName;
                    const targetPathOrName = getPointerTargetPath(item);
                    if (!pointerName || !targetPathOrName) continue;
                    const targetPath = await resolveMetaPathOrName(core, root, targetPathOrName);
                    if (targetPath == null) {
                        ctx.logger.warn("createMetaNode pointers: target not found '" + targetPathOrName + "'");
                        continue;
                    }
                    const targetNode = targetPath === core.getPath(root) ? root : await core.loadByPath(root, targetPath);
                    if (!targetNode) continue;
                    const isTargetMeta = typeof core.isMetaNode === "function" ? core.isMetaNode(targetNode) : false;
                    if (!isTargetMeta) continue;
                    try {
                        core.setPointerMetaLimits(node, pointerName, 1, 1);
                        core.setPointerMetaTarget(node, pointerName, targetNode, 1, 1);
                        pointersDone.push({ pointerName, targetPath });
                    } catch (err: any) {
                        ctx.logger.warn("createMetaNode setPointerMeta: " + (err && err.message));
                    }
                }
            }

            const setsDone: Array<{ setName: string; targetPath: string; min?: number; max?: number }> = [];
            const setsArg = args.sets;
            if (Array.isArray(setsArg) && setsArg.length > 0) {
                for (const item of setsArg) {
                    const setName = item?.setName != null ? String(item.setName).trim() : "";
                    const targetPathOrName = getPointerTargetPath(item);
                    if (!setName || !targetPathOrName) continue;
                    const targetPath = await resolveMetaPathOrName(core, root, targetPathOrName);
                    if (targetPath == null) {
                        ctx.logger.warn("createMetaNode sets: target not found '" + targetPathOrName + "'");
                        continue;
                    }
                    const targetNode = targetPath === core.getPath(root) ? root : await core.loadByPath(root, targetPath);
                    if (!targetNode) continue;
                    const isTargetMeta = typeof core.isMetaNode === "function" ? core.isMetaNode(targetNode) : false;
                    if (!isTargetMeta) continue;
                    const min = typeof item.min === "number" ? item.min : -1;
                    const max = typeof item.max === "number" ? item.max : -1;
                    try {
                        core.setPointerMetaTarget(node, setName, targetNode, min, max);
                        core.setPointerMetaLimits(node, setName, min, max);
                        setsDone.push({ setName, targetPath, min: min >= 0 ? min : undefined, max: max >= 0 ? max : undefined });
                    } catch (err: any) {
                        ctx.logger.warn("createMetaNode setMetaSet: " + (err && err.message));
                    }
                }
            }

            await commitCoreSession(
                ctx.coreSession,
                "GMEBot: createMetaNode " + name
            );

            return {
                data: {
                    created: true,
                    path: nodePath,
                    name,
                    basePath: core.getPath(baseNode),
                    ...(containmentsDone.length > 0 ? { containments: containmentsDone } : {}),
                    ...(pointersDone.length > 0 ? { pointers: pointersDone } : {}),
                    ...(setsDone.length > 0 ? { sets: setsDone } : {}),
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "createMetaNode", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const setMetaAttribute: Tool = {
    definition: {
        name: "setMetaAttribute",
        description:
            "Define or update an attribute's META rule on a concept (meta-node). Use only when the user asks to define or change the rule (e.g. type, min, max, default). " +
            "When the user asks to change or set the value of an attribute on a concept (e.g. 'rename Folder to MyFolder', 'set name of concept X to Y'), use node tools instead: findNodesByName, getProperty, setProperty. " +
            "Wraps core.setAttributeMeta on the server. Rule is passed through as-is.",
        parameters: {
            type: "object",
            properties: {
                conceptPath: {
                    type: "string",
                    description:
                        "Absolute path of the concept (meta-node) whose attribute meta to set.",
                },
                attributeName: {
                    type: "string",
                    description: "Name of the attribute (e.g. 'name', 'position').",
                },
                rule: {
                    type: "object",
                    description:
                        "Attribute meta rule object (type, enum, min, max, default, etc.), passed directly to core.setAttributeMeta.",
                },
            },
            required: ["conceptPath", "attributeName", "rule"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;

        const conceptPathRaw: string = args.conceptPath;
        const conceptPath = String(conceptPathRaw ?? "").trim();
        const attributeNameRaw: string = args.attributeName;
        const attributeName = String(attributeNameRaw ?? "").trim();
        const rule = args.rule;

        if (!conceptPath) {
            return { data: { error: "conceptPath is required." } };
        }
        if (!attributeName) {
            return { data: { error: "attributeName is required." } };
        }
        if (!rule || typeof rule !== "object") {
            return { data: { error: "rule must be an object." } };
        }

        try {
            const node =
                conceptPath === "/" ? root : await core.loadByPath(root, conceptPath);
            if (!node) {
                return {
                    data: { error: "Concept node not found at path " + conceptPath },
                };
            }
            const isMeta =
                typeof core.isMetaNode === "function"
                    ? core.isMetaNode(node)
                    : false;
            if (!isMeta) {
                return {
                    data: {
                        error:
                            "Node at path " +
                            conceptPath +
                            " is not a META node. Use isMetaNode to validate concepts.",
                    },
                };
            }

            const res = core.setAttributeMeta(node, attributeName, rule);
            if (res) {
                // setAttributeMeta returns Error | undefined.
                return {
                    data: {
                        error:
                            "setAttributeMeta reported an error: " +
                            (res as any).message,
                    },
                };
            }

            await commitCoreSession(
                ctx.coreSession,
                "GMEBot: setMetaAttribute " + attributeName
            );

            return {
                data: {
                    conceptPath: core.getPath(node),
                    attributeName,
                    rule,
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "setMetaAttribute", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const delMetaAttribute: Tool = {
    definition: {
        name: "delMetaAttribute",
        description:
            "Remove an attribute's META rule from a concept. The attribute will no longer have a meta definition on this concept (inherited rules may still apply). " +
            "conceptPath can be path or concept name; attributeName = name of the attribute whose rule to remove.",
        parameters: {
            type: "object",
            properties: {
                conceptPath: {
                    type: "string",
                    description: "Concept path (e.g. /MyType) or concept name.",
                },
                attributeName: {
                    type: "string",
                    description: "Name of the attribute whose meta rule to remove (e.g. 'name', 'position').",
                },
            },
            required: ["conceptPath", "attributeName"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const conceptPathOrName = String(args.conceptPath ?? "").trim();
        const attributeName = String(args.attributeName ?? "").trim();
        if (!conceptPathOrName || !attributeName) {
            return { data: { error: "conceptPath and attributeName are required." } };
        }
        try {
            const conceptPath = await resolveMetaPathOrName(core, root, conceptPathOrName);
            if (conceptPath == null) return { data: { error: "Concept not found: '" + conceptPathOrName + "'." } };
            const conceptNode = conceptPath === core.getPath(root) ? root : await core.loadByPath(root, conceptPath);
            if (!conceptNode) return { data: { error: "Concept not found at " + conceptPath } };
            core.delAttributeMeta(conceptNode, attributeName);
            await commitCoreSession(ctx.coreSession, "GMEBot: delMetaAttribute");
            return { data: { deleted: true, conceptPath: core.getPath(conceptNode), attributeName } };
        } catch (e: any) {
            logToolFailure(ctx, "delMetaAttribute", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const setMetaContainment: Tool = {
    definition: {
        name: "setMetaContainment",
        description:
            "Define a META-level containment: a concept can contain instances of another (e.g. 'A can contain B'). Uses core.setChildMeta. " +
            "One call = one edge: exactly one source (container) and one target (contained type). " +
            "sourcePath and targetPath can be absolute paths or concept names; the backend resolves names. For 'any amount' / 'any number' of instances, omit min and max. " +
            "To create a new concept and its containment in one step, use createMetaNode with the optional 'contains' array instead.",
        parameters: {
            type: "object",
            properties: {
                sourcePath: {
                    type: "string",
                    description:
                        "Container concept path (e.g. /SM) or concept name. Use leading '/' for path; otherwise treated as name.",
                },
                targetPath: {
                    type: "string",
                    description:
                        "Contained concept path (e.g. /Item) or concept name. Use leading '/' for path; otherwise treated as name.",
                },
                min: {
                    type: "number",
                    description:
                        "Optional minimum cardinality. If the user says 'any' or does not specify cardinality, omit this (do not send).",
                },
                max: {
                    type: "number",
                    description:
                        "Optional maximum cardinality. If the user says 'any' or does not specify cardinality, omit this (do not send).",
                },
            },
            required: ["sourcePath", "targetPath"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;

        const sourcePathRaw: string = args.sourcePath;
        const targetPathRaw: string = args.targetPath;
        const sourcePathOrName = String(sourcePathRaw ?? "").trim();
        const targetPathOrName = String(targetPathRaw ?? "").trim();

        if (!sourcePathOrName || !targetPathOrName) {
            return {
                data: {
                    error: "sourcePath and targetPath are required.",
                },
            };
        }

        try {
            const sourcePath = await resolveMetaPathOrName(core, root, sourcePathOrName);
            const targetPath = await resolveMetaPathOrName(core, root, targetPathOrName);
            if (sourcePath == null) {
                return { data: { error: "Source concept not found: '" + sourcePathOrName + "' (use path like /FCO or concept name from getMetaInfo)." } };
            }
            if (targetPath == null) {
                return { data: { error: "Target concept not found: '" + targetPathOrName + "' (use path like /FCO or concept name from getMetaInfo)." } };
            }

            const rootPath = core.getPath(root);
            const sourceNode = sourcePath === rootPath ? root : await core.loadByPath(root, sourcePath);
            const targetNode = targetPath === rootPath ? root : await core.loadByPath(root, targetPath);

            if (!sourceNode) {
                return {
                    data: { error: "Source concept not found at path " + sourcePath },
                };
            }
            if (!targetNode) {
                return {
                    data: { error: "Target concept not found at path " + targetPath },
                };
            }

            const isSourceMeta =
                typeof core.isMetaNode === "function"
                    ? core.isMetaNode(sourceNode)
                    : false;
            const isTargetMeta =
                typeof core.isMetaNode === "function"
                    ? core.isMetaNode(targetNode)
                    : false;

            if (!isSourceMeta || !isTargetMeta) {
                return {
                    data: {
                        error:
                            "Both source and target must be META nodes. " +
                            "Use isMetaNode to validate concepts before creating relationships.",
                    },
                };
            }

            const min: number | undefined =
                typeof args.min === "number" ? args.min : undefined;
            const max: number | undefined =
                typeof args.max === "number" ? args.max : undefined;

            const res = core.setChildMeta(sourceNode, targetNode, min, max);
            if (res) {
                return {
                    data: {
                        error:
                            "setChildMeta reported an error: " +
                            (res as any).message,
                    },
                };
            }

            await commitCoreSession(
                ctx.coreSession,
                "GMEBot: setMetaContainment"
            );

            return {
                data: {
                    relation: "containment",
                    sourcePath: core.getPath(sourceNode),
                    targetPath: core.getPath(targetNode),
                    min: min ?? null,
                    max: max ?? null,
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "setMetaContainment", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const delMetaContainment: Tool = {
    definition: {
        name: "delMetaContainment",
        description:
            "Remove a META-level containment rule: the container concept can no longer contain the specified child type. " +
            "sourcePath = container concept, targetPath = contained concept to remove from its allowed children. Paths can be absolute or concept names.",
        parameters: {
            type: "object",
            properties: {
                sourcePath: {
                    type: "string",
                    description: "Container concept path or name (the concept that currently allows the child).",
                },
                targetPath: {
                    type: "string",
                    description: "Contained concept path or name to remove from allowed children.",
                },
            },
            required: ["sourcePath", "targetPath"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const sourcePathOrName = String(args.sourcePath ?? "").trim();
        const targetPathOrName = String(args.targetPath ?? "").trim();
        if (!sourcePathOrName || !targetPathOrName) {
            return { data: { error: "sourcePath and targetPath are required." } };
        }
        try {
            const sourcePath = await resolveMetaPathOrName(core, root, sourcePathOrName);
            const targetPath = await resolveMetaPathOrName(core, root, targetPathOrName);
            if (sourcePath == null) return { data: { error: "Source concept not found: '" + sourcePathOrName + "'." } };
            if (targetPath == null) return { data: { error: "Target concept not found: '" + targetPathOrName + "'." } };
            const rootPath = core.getPath(root);
            const sourceNode = sourcePath === rootPath ? root : await core.loadByPath(root, sourcePath);
            if (!sourceNode) return { data: { error: "Source concept not found at " + sourcePath } };
            core.delChildMeta(sourceNode, targetPath);
            await commitCoreSession(ctx.coreSession, "GMEBot: delMetaContainment");
            return { data: { deleted: true, sourcePath, targetPath } };
        } catch (e: any) {
            logToolFailure(ctx, "delMetaContainment", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

/** WebGME uses the same internal set name for mixins. */
const MIXINS_SET = "_mixins";

export const setMetaPointer: Tool = {
    definition: {
        name: "setMetaPointer",
        description:
            "Define a META-level pointer on a concept: instances can reference at most one target. " +
            "Adds a valid target type for the pointer. Uses min=1, max=1 so it is displayed as a pointer (not a set). " +
            "For connection/link/edge concepts prefer pointerName 'src' or 'dst' so WebGME shows them as connections; backend maps source/from/destination/to to src/dst. " +
            "conceptPath and targetPath must be absolute paths (e.g. /FCO, /MyConcept) or concept names; if a value does not start with '/', it is resolved as a concept name from the metamodel.",
        parameters: {
            type: "object",
            properties: {
                conceptPath: {
                    type: "string",
                    description: "Concept path (e.g. /MyType) or concept name that gets the pointer definition. Use leading '/' for path; otherwise treated as name.",
                },
                pointerName: {
                    type: "string",
                    description: "Name of the pointer. For connection/edge concepts prefer 'src' or 'dst' for correct visualization; backend maps source/destination/from/to to src/dst. For other concepts e.g. 'target', 'parent'.",
                },
                targetPath: {
                    type: "string",
                    description: "Concept path (e.g. /OtherType) or concept name that is a valid target type. Use leading '/' for path; otherwise treated as name.",
                },
            },
            required: ["conceptPath", "pointerName", "targetPath"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const conceptPathOrName = String(args.conceptPath ?? "").trim();
        const pointerName = normalizeConnectionPointerName(String(args.pointerName ?? "").trim()) || String(args.pointerName ?? "").trim();
        const targetPathOrName = String(args.targetPath ?? "").trim();
        if (!conceptPathOrName || !pointerName || !targetPathOrName) {
            return { data: { error: "conceptPath, pointerName, and targetPath are required." } };
        }
        try {
            const conceptPath = await resolveMetaPathOrName(core, root, conceptPathOrName);
            const targetPath = await resolveMetaPathOrName(core, root, targetPathOrName);
            if (conceptPath == null) {
                return { data: { error: "Concept not found: '" + conceptPathOrName + "' (use path like /FCO or concept name from getMetaInfo)." } };
            }
            if (targetPath == null) {
                return { data: { error: "Target concept not found: '" + targetPathOrName + "' (use path like /FCO or concept name from getMetaInfo)." } };
            }
            const conceptNode = conceptPath === core.getPath(root) ? root : await core.loadByPath(root, conceptPath);
            const targetNode = targetPath === core.getPath(root) ? root : await core.loadByPath(root, targetPath);
            if (!conceptNode) return { data: { error: "Concept not found at " + conceptPath } };
            if (!targetNode) return { data: { error: "Target concept not found at " + targetPath } };
            core.setPointerMetaLimits(conceptNode, pointerName, 1, 1);
            core.setPointerMetaTarget(conceptNode, pointerName, targetNode, 1, 1);
            await commitCoreSession(ctx.coreSession, "GMEBot: setMetaPointer");
            return {
                data: { conceptPath: core.getPath(conceptNode), pointerName, targetPath: core.getPath(targetNode) },
            };
        } catch (e: any) {
            logToolFailure(ctx, "setMetaPointer", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const delMetaPointer: Tool = {
    definition: {
        name: "delMetaPointer",
        description:
            "Remove a META-level pointer (or set) definition from a concept. The pointer/set and all its target rules are removed. " +
            "conceptPath can be absolute path or concept name; pointerName must match the name used when the pointer was defined (e.g. 'src', 'dst').",
        parameters: {
            type: "object",
            properties: {
                conceptPath: {
                    type: "string",
                    description: "Concept path (e.g. /MyType) or concept name. Use leading '/' for path; otherwise treated as name.",
                },
                pointerName: {
                    type: "string",
                    description: "Name of the pointer or set to remove (e.g. 'src', 'dst', 'target').",
                },
            },
            required: ["conceptPath", "pointerName"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const conceptPathOrName = String(args.conceptPath ?? "").trim();
        const pointerName = String(args.pointerName ?? "").trim();
        if (!conceptPathOrName || !pointerName) {
            return { data: { error: "conceptPath and pointerName are required." } };
        }
        try {
            const conceptPath = await resolveMetaPathOrName(core, root, conceptPathOrName);
            if (conceptPath == null) {
                return { data: { error: "Concept not found: '" + conceptPathOrName + "' (use path or concept name from getMetaInfo)." } };
            }
            const conceptNode = conceptPath === core.getPath(root) ? root : await core.loadByPath(root, conceptPath);
            if (!conceptNode) {
                return { data: { error: "Concept not found at " + conceptPath } };
            }
            core.delPointerMeta(conceptNode, pointerName);
            await commitCoreSession(ctx.coreSession, "GMEBot: delMetaPointer");
            return {
                data: { deleted: true, conceptPath: core.getPath(conceptNode), pointerName },
            };
        } catch (e: any) {
            logToolFailure(ctx, "delMetaPointer", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const delMetaSet: Tool = {
    definition: {
        name: "delMetaSet",
        description:
            "Remove a META-level set definition from a concept. The set and all its target rules are removed. " +
            "conceptPath can be path or concept name; setName must match the set name (e.g. 'members', 'refs').",
        parameters: {
            type: "object",
            properties: {
                conceptPath: {
                    type: "string",
                    description: "Concept path (e.g. /MyType) or concept name.",
                },
                setName: {
                    type: "string",
                    description: "Name of the set to remove (e.g. 'members', 'references').",
                },
            },
            required: ["conceptPath", "setName"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const conceptPathOrName = String(args.conceptPath ?? "").trim();
        const setName = String(args.setName ?? "").trim();
        if (!conceptPathOrName || !setName) {
            return { data: { error: "conceptPath and setName are required." } };
        }
        try {
            const conceptPath = await resolveMetaPathOrName(core, root, conceptPathOrName);
            if (conceptPath == null) return { data: { error: "Concept not found: '" + conceptPathOrName + "'." } };
            const conceptNode = conceptPath === core.getPath(root) ? root : await core.loadByPath(root, conceptPath);
            if (!conceptNode) return { data: { error: "Concept not found at " + conceptPath } };
            core.delPointerMeta(conceptNode, setName);
            await commitCoreSession(ctx.coreSession, "GMEBot: delMetaSet");
            return { data: { deleted: true, conceptPath: core.getPath(conceptNode), setName } };
        } catch (e: any) {
            logToolFailure(ctx, "delMetaSet", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const setMetaSet: Tool = {
    definition: {
        name: "setMetaSet",
        description:
            "Define a META-level set on a concept: instances can reference multiple targets. " +
            "Adds a valid target type for the set. conceptPath and targetPath can be absolute paths or concept names; values without leading '/' are resolved as concept names.",
        parameters: {
            type: "object",
            properties: {
                conceptPath: {
                    type: "string",
                    description: "Concept path (e.g. /MyType) or concept name. Use leading '/' for path; otherwise treated as name.",
                },
                setName: {
                    type: "string",
                    description: "Name of the set (e.g. 'members', 'references').",
                },
                targetPath: {
                    type: "string",
                    description: "Concept path (e.g. /OtherType) or concept name. Use leading '/' for path; otherwise treated as name.",
                },
                min: {
                    type: "number",
                    description: "Optional minimum. Omit for no minimum.",
                },
                max: {
                    type: "number",
                    description: "Optional maximum; -1 or omit for no limit.",
                },
            },
            required: ["conceptPath", "setName", "targetPath"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const conceptPathOrName = String(args.conceptPath ?? "").trim();
        const setName = String(args.setName ?? "").trim();
        const targetPathOrName = String(args.targetPath ?? "").trim();
        if (!conceptPathOrName || !setName || !targetPathOrName) {
            return { data: { error: "conceptPath, setName, and targetPath are required." } };
        }
        try {
            const conceptPath = await resolveMetaPathOrName(core, root, conceptPathOrName);
            const targetPath = await resolveMetaPathOrName(core, root, targetPathOrName);
            if (conceptPath == null) {
                return { data: { error: "Concept not found: '" + conceptPathOrName + "' (use path or concept name from getMetaInfo)." } };
            }
            if (targetPath == null) {
                return { data: { error: "Target concept not found: '" + targetPathOrName + "' (use path or concept name from getMetaInfo)." } };
            }
            const rootPath = core.getPath(root);
            const conceptNode = conceptPath === rootPath ? root : await core.loadByPath(root, conceptPath);
            const targetNode = targetPath === rootPath ? root : await core.loadByPath(root, targetPath);
            if (!conceptNode) return { data: { error: "Concept not found at " + conceptPath } };
            if (!targetNode) return { data: { error: "Target concept not found at " + targetPath } };
            const min = typeof args.min === "number" ? args.min : -1;
            const max = typeof args.max === "number" ? args.max : -1;
            core.setPointerMetaTarget(conceptNode, setName, targetNode, min, max);
            core.setPointerMetaLimits(conceptNode, setName, min, max);
            await commitCoreSession(ctx.coreSession, "GMEBot: setMetaSet");
            return {
                data: { conceptPath: core.getPath(conceptNode), setName, targetPath: core.getPath(targetNode), min, max },
            };
        } catch (e: any) {
            logToolFailure(ctx, "setMetaSet", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const setMetaMixin: Tool = {
    definition: {
        name: "setMetaMixin",
        description:
            "Add a META mixin to a concept: the concept inherits from the mixin type (attributes, containment, pointers, etc.). " +
            "conceptPath and mixinPath can be absolute paths or concept names; values without leading '/' are resolved as concept names.",
        parameters: {
            type: "object",
            properties: {
                conceptPath: {
                    type: "string",
                    description: "Concept path (e.g. /MyType) or concept name that receives the mixin. Use leading '/' for path; otherwise treated as name.",
                },
                mixinPath: {
                    type: "string",
                    description: "Concept path (e.g. /MixinType) or concept name of the mixin to add. Use leading '/' for path; otherwise treated as name.",
                },
            },
            required: ["conceptPath", "mixinPath"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const conceptPathOrName = String(args.conceptPath ?? "").trim();
        const mixinPathOrName = String(args.mixinPath ?? "").trim();
        if (!conceptPathOrName || !mixinPathOrName) {
            return { data: { error: "conceptPath and mixinPath are required." } };
        }
        try {
            const conceptPath = await resolveMetaPathOrName(core, root, conceptPathOrName);
            const mixinPath = await resolveMetaPathOrName(core, root, mixinPathOrName);
            if (conceptPath == null) {
                return { data: { error: "Concept not found: '" + conceptPathOrName + "' (use path or concept name from getMetaInfo)." } };
            }
            if (mixinPath == null) {
                return { data: { error: "Mixin concept not found: '" + mixinPathOrName + "' (use path or concept name from getMetaInfo)." } };
            }
            const rootPath = core.getPath(root);
            const conceptNode = conceptPath === rootPath ? root : await core.loadByPath(root, conceptPath);
            const mixinNode = mixinPath === rootPath ? root : await core.loadByPath(root, mixinPath);
            if (!conceptNode) return { data: { error: "Concept not found at " + conceptPath } };
            if (!mixinNode) return { data: { error: "Mixin concept not found at " + mixinPath } };
            const metaNode = core.getChild(conceptNode, "_meta");
            if (!metaNode) return { data: { error: "Concept has no meta node at " + conceptPath } };
            core.addMember(metaNode, MIXINS_SET, mixinNode);
            await commitCoreSession(ctx.coreSession, "GMEBot: setMetaMixin");
            return {
                data: { conceptPath: core.getPath(conceptNode), mixinPath: core.getPath(mixinNode) },
            };
        } catch (e: any) {
            logToolFailure(ctx, "setMetaMixin", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const delMetaMixin: Tool = {
    definition: {
        name: "delMetaMixin",
        description:
            "Remove a META mixin from a concept. The concept will no longer inherit from that mixin type. " +
            "conceptPath and mixinPath can be absolute paths or concept names.",
        parameters: {
            type: "object",
            properties: {
                conceptPath: {
                    type: "string",
                    description: "Concept path or name that currently has the mixin.",
                },
                mixinPath: {
                    type: "string",
                    description: "Mixin concept path or name to remove.",
                },
            },
            required: ["conceptPath", "mixinPath"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const conceptPathOrName = String(args.conceptPath ?? "").trim();
        const mixinPathOrName = String(args.mixinPath ?? "").trim();
        if (!conceptPathOrName || !mixinPathOrName) {
            return { data: { error: "conceptPath and mixinPath are required." } };
        }
        try {
            const conceptPath = await resolveMetaPathOrName(core, root, conceptPathOrName);
            const mixinPath = await resolveMetaPathOrName(core, root, mixinPathOrName);
            if (conceptPath == null) return { data: { error: "Concept not found: '" + conceptPathOrName + "'." } };
            if (mixinPath == null) return { data: { error: "Mixin concept not found: '" + mixinPathOrName + "'." } };
            const rootPath = core.getPath(root);
            const conceptNode = conceptPath === rootPath ? root : await core.loadByPath(root, conceptPath);
            if (!conceptNode) return { data: { error: "Concept not found at " + conceptPath } };
            const metaNode = core.getChild(conceptNode, "_meta");
            if (!metaNode) return { data: { error: "Concept has no meta node at " + conceptPath } };
            core.delMember(metaNode, MIXINS_SET, mixinPath);
            await commitCoreSession(ctx.coreSession, "GMEBot: delMetaMixin");
            return { data: { deleted: true, conceptPath: core.getPath(conceptNode), mixinPath } };
        } catch (e: any) {
            logToolFailure(ctx, "delMetaMixin", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const checkMetaConsistency: Tool = {
    definition: {
        name: "checkMetaConsistency",
        description:
            "Run WebGME meta-layer consistency check (mixin and meta-rule violations on META concepts only). " +
            "Use after meta modifications to ensure the metamodel itself is consistent. " +
            "For checking that instance nodes in the model obey the meta rules (containment, pointers, etc.), use checkModelConsistency instead.",
        parameters: {
            type: "object",
            properties: {
                scope: {
                    type: "string",
                    description: "Optional. 'metaOnly' (default) = check all meta concepts; 'root' = check from root node with depth limit.",
                },
                maxDepth: {
                    type: "number",
                    description: "Optional. When scope is 'root', max tree depth to traverse (default 20).",
                },
            },
            required: [],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const scope = (args.scope === "root" ? "root" : "metaOnly") as "root" | "metaOnly";
        const maxDepth = typeof args.maxDepth === "number" && args.maxDepth >= 1 && args.maxDepth <= 100 ? args.maxDepth : 20;

        try {
            if (typeof core.getMixinErrors !== "function") {
                return { data: { ok: true, message: "getMixinErrors not available on this Core; skipping consistency check." } };
            }

            const violations: Array<{ path: string; message?: string; severity?: string; type?: string; hint?: string }> = [];
            const rootPath = core.getPath(root);

            if (scope === "metaOnly") {
                const metaDict = core.getAllMetaNodes(root) || {};
                for (const path of Object.keys(metaDict)) {
                    const node = metaDict[path];
                    if (!node) continue;
                    let errs: any[] = [];
                    try {
                        errs = core.getMixinErrors(node) || [];
                    } catch (_e) {
                        continue;
                    }
                    if (!Array.isArray(errs)) continue;
                    for (const v of errs) {
                        violations.push({
                            path,
                            message: v.message != null ? String(v.message) : undefined,
                            severity: v.severity != null ? String(v.severity) : undefined,
                            type: v.type != null ? String(v.type) : undefined,
                            hint: v.hint != null ? String(v.hint) : undefined,
                        });
                    }
                }
            } else {
                async function walk(node: any, depth: number): Promise<void> {
                    if (depth > maxDepth) return;
                    try {
                        const errs = core.getMixinErrors(node) || [];
                        if (Array.isArray(errs)) {
                            const path = core.getPath(node);
                            for (const v of errs) {
                                violations.push({
                                    path,
                                    message: v.message != null ? String(v.message) : undefined,
                                    severity: v.severity != null ? String(v.severity) : undefined,
                                    type: v.type != null ? String(v.type) : undefined,
                                    hint: v.hint != null ? String(v.hint) : undefined,
                                });
                            }
                        }
                    } catch (_e) {
                        // skip node
                    }
                    const children = core.getChildrenPaths(node) || [];
                    for (const p of children) {
                        const child = await core.loadByPath(root, p);
                        if (child) await walk(child, depth + 1);
                    }
                }
                await walk(root, 0);
            }

            return {
                data: {
                    ok: violations.length === 0,
                    scope,
                    violationCount: violations.length,
                    ...(violations.length > 0 ? { violations } : {}),
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "checkMetaConsistency", args, e);
            return { data: { error: (e && e.message) || String(e), ok: false } };
        }
    },
};

/** Run model-vs-meta constraint check: find any instance node (in project or sub-tree) that violates meta rules (containment, pointers, sets). */
export const checkModelConsistency: Tool = {
    definition: {
        name: "checkModelConsistency",
        description:
            "Run the constraint check that finds any element in the project (or a sub-tree) that violates the meta rules. " +
            "Validates instance nodes against the metamodel: containment, pointers, sets. Use this to see if the model obeys the meta (e.g. after meta changes or to audit the project). " +
            "After any model changes (createNode, setProperty, setPointer, etc.), run this for the current scope: pass the client's active node path (context.activeNodeId) as nodePath with includeChildren true. " +
            "Scope: whole project (omit nodePath or use '/' or '') or a sub-tree (pass nodePath and set includeChildren true to check that node and its descendants).",
        parameters: {
            type: "object",
            properties: {
                nodePath: {
                    type: "string",
                    description:
                        "Optional. Root of the scope to check. Use context.activeNodeId for the current selection (recommended after model changes). Omit or '' or '/' = entire project; otherwise the node at this path and, if includeChildren, its descendants.",
                },
                includeChildren: {
                    type: "boolean",
                    description:
                        "Optional. When true (default), check the given node and all its descendants. When false, check only the single node at nodePath.",
                },
                maxDepth: {
                    type: "number",
                    description: "Optional. Max depth to traverse from nodePath (default 100). Prevents runaway on huge trees.",
                },
            },
            required: [],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const nodePathNorm = String(args.nodePath ?? "").trim() || "/";
        const includeChildren = args.includeChildren !== false;
        const maxDepth = typeof args.maxDepth === "number" && args.maxDepth >= 1 && args.maxDepth <= 500 ? args.maxDepth : 100;

        const violations: Array<{ path: string; message: string; type?: string }> = [];
        const rootPath = core.getPath(root);

        function add(path: string, message: string, type?: string) {
            violations.push({ path, message, type: type ?? "meta_rule" });
        }

        try {
            const startNode =
                nodePathNorm === "/" || nodePathNorm === ""
                    ? root
                    : await core.loadByPath(root, nodePathNorm);
            if (!startNode) {
                return { data: { error: "Node not found at path: " + nodePathNorm } };
            }

            const isRoot = (n: any) => core.getPath(n) === rootPath;

            async function checkOne(node: any): Promise<void> {
                const path = core.getPath(node);
                if (isRoot(node) || (typeof core.isLibraryRoot === "function" && core.isLibraryRoot(node))) {
                    return;
                }

                const parent = core.getParent(node);
                if (parent && typeof core.isValidChildOf === "function") {
                    const valid = core.isValidChildOf(node, parent);
                    if (valid !== true) {
                        const msg = typeof valid === "object" && valid !== null && (valid as any).message != null
                            ? String((valid as any).message)
                            : "Node is not a valid child of its parent (containment rule violation).";
                        add(path, msg, "containment");
                    }
                }

                const pointerNames: string[] = typeof core.getPointerNames === "function" ? (core.getPointerNames(node) || []) : [];
                for (const name of pointerNames) {
                    const targetPath = typeof core.getPointerPath === "function" ? core.getPointerPath(node, name) : null;
                    if (targetPath) {
                        const target = await core.loadByPath(root, targetPath);
                        if (target && typeof core.isValidTargetOf === "function") {
                            const valid = core.isValidTargetOf(target, node, name);
                            if (valid !== true) {
                                const msg = typeof valid === "object" && valid !== null && (valid as any).message != null
                                    ? String((valid as any).message)
                                    : "Pointer '" + name + "' targets a node that is not a valid target type.";
                                add(path, msg, "pointer");
                            }
                        }
                    }
                }

                const setNames: string[] = typeof core.getSetNames === "function" ? (core.getSetNames(node) || []) : [];
                for (const setName of setNames) {
                    const memberPaths: string[] = typeof core.getMemberPaths === "function" ? (core.getMemberPaths(node, setName) || []) : [];
                    for (const memberPath of memberPaths) {
                        const member = await core.loadByPath(root, memberPath);
                        if (member && typeof core.isValidTargetOf === "function") {
                            const valid = core.isValidTargetOf(member, node, setName);
                            if (valid !== true) {
                                const msg = typeof valid === "object" && valid !== null && (valid as any).message != null
                                    ? String((valid as any).message)
                                    : "Set '" + setName + "' contains a node that is not a valid member type.";
                                add(path, msg, "set");
                            }
                        }
                    }
                }
            }

            async function walk(node: any, depth: number): Promise<void> {
                if (depth > maxDepth) return;
                await checkOne(node);
                if (!includeChildren) return;
                const childPaths: string[] = typeof core.getChildrenPaths === "function" ? (core.getChildrenPaths(node) || []) : [];
                for (const p of childPaths) {
                    const child = await core.loadByPath(root, p);
                    if (child) await walk(child, depth + 1);
                }
            }

            await walk(startNode, 0);

            return {
                data: {
                    ok: violations.length === 0,
                    scope: nodePathNorm === "/" || nodePathNorm === "" ? "project" : "subtree",
                    nodePath: nodePathNorm,
                    includeChildren,
                    violationCount: violations.length,
                    ...(violations.length > 0 ? { violations } : {}),
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "checkModelConsistency", args, e);
            return { data: { error: (e && e.message) || String(e), ok: false } };
        }
    },
};

export const getMetaInfo: Tool = {
    definition: {
        name: "getMetaInfo",
        description:
            "Collect meta information for the current project. Runs on the server. " +
            "Returns a JSON object with 'concepts' (all meta-nodes from MetaAspectSet with getJsonMeta data) " +
            "and 'sheets' (named meta sheets with their SetIDs and the concepts they contain).",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
    },
    handler: async (_args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;

        try {
            // Collect all meta nodes (global MetaAspectSet) and their JSON meta rules.
            const metaDict = core.getAllMetaNodes(root) || {};
            const conceptPaths = Object.keys(metaDict).sort();

            const concepts: any[] = [];
            const pathToIndex = new Map<string, number>();

            for (let i = 0; i < conceptPaths.length; i++) {
                const path = conceptPaths[i];
                const node = metaDict[path];
                if (!node) continue;
                const name = core.getAttribute(node, "name") ?? "";
                let meta: any = null;
                try {
                    meta = core.getJsonMeta(node);
                } catch (e: any) {
                    ctx.logger.warn(
                        "getMetaInfo: getJsonMeta failed for " +
                            path +
                            ": " +
                            (e && e.message)
                    );
                    meta = { error: (e && e.message) || String(e) };
                }
                concepts.push({ path, name, meta });
                pathToIndex.set(path, i);
            }

            // Collect named meta sheets from ROOT registry.
            const rawSheets = core.getRegistry(root, META_SHEETS_REGISTRY) || [];
            const sheetsArray: any[] = Array.isArray(rawSheets)
                ? rawSheets.slice()
                : [];

            const sheets = sheetsArray.map((s) => {
                const setId: string = s.SetID;
                const order: number =
                    typeof s.order === "number" ? s.order : 0;
                const title: string = s.title || setId;
                const memberPaths: string[] =
                    (setId && core.getMemberPaths(root, setId)) || [];
                const conceptIndexes: number[] = [];
                for (const p of memberPaths) {
                    const idx = pathToIndex.get(p);
                    if (typeof idx === "number") {
                        conceptIndexes.push(idx);
                    }
                }
                return {
                    setId,
                    title,
                    order,
                    conceptPaths: memberPaths,
                    conceptIndexes,
                };
            });

            return {
                data: {
                    concepts,
                    sheets,
                    hint: "For createMetaNode and other META tools: use concepts[].path (e.g. /1) or concepts[].name (e.g. FCO). Do not use /Name as a path—paths are project-specific.",
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "getMetaInfo", _args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

/**
 * Set the position of a single concept on the active meta sheet diagram.
 * Uses the sheet indicated by context.activeTabId. Position is stored via core.setMemberRegistry(root, sheetSetId, conceptPath, 'position', { x, y }).
 */
export const setConceptPosition: Tool = {
    definition: {
        name: "setConceptPosition",
        description:
            "Set the diagram position of a single concept on the active meta sheet. " +
            "The active sheet is determined by the client's activeTabId (current tab). " +
            "conceptPath can be the concept's node path (e.g. /FCO or /MyConcept) or concept name from getMetaInfo. " +
            "Use after getDiagramLayout when arranging a single concept.",
        parameters: {
            type: "object",
            properties: {
                conceptPath: {
                    type: "string",
                    description: "Concept path (e.g. /1/2) or concept name. Use path from getDiagramLayout or getMetaInfo.",
                },
                x: {
                    type: "number",
                    description: "X coordinate for the concept's position on the sheet.",
                },
                y: {
                    type: "number",
                    description: "Y coordinate for the concept's position on the sheet.",
                },
            },
            required: ["conceptPath", "x", "y"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const sheetSetId = getActiveSheetSetId(ctx);
        if (!sheetSetId) {
            return { data: { error: "No meta sheet is active. Ensure the project has meta sheets and the client sends activeTabId (e.g. from the Meta Editor tab)." } };
        }
        const conceptPathOrName = String(args.conceptPath ?? "").trim();
        const x = typeof args.x === "number" ? args.x : Number(args.x);
        const y = typeof args.y === "number" ? args.y : Number(args.y);
        if (conceptPathOrName === "" || Number.isNaN(x) || Number.isNaN(y)) {
            return { data: { error: "conceptPath, x, and y are required (x and y must be numbers)." } };
        }
        try {
            const conceptPath = await resolveMetaPathOrName(core, root, conceptPathOrName);
            if (conceptPath == null) {
                return { data: { error: "Concept not found: '" + conceptPathOrName + "' (use path or concept name from getMetaInfo)." } };
            }
            const members = core.getMemberPaths(root, sheetSetId) || [];
            if (members.indexOf(conceptPath) === -1) {
                return { data: { error: "Concept '" + conceptPath + "' is not on the active sheet. Add it to the sheet first or switch to the correct tab." } };
            }
            core.setMemberRegistry(root, sheetSetId, conceptPath, POSITION_REGISTRY_KEY, { x, y });
            await commitCoreSession(ctx.coreSession, "GMEBot: setConceptPosition");
            return {
                data: { set: true, conceptPath, sheetSetId, x, y },
            };
        } catch (e: any) {
            logToolFailure(ctx, "setConceptPosition", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

/**
 * Set the positions of multiple concepts on the active meta sheet diagram in one commit.
 * Uses the sheet indicated by context.activeTabId. Each node is updated via setMemberRegistry; one commit at the end.
 */
export const setConceptLayout: Tool = {
    definition: {
        name: "setConceptLayout",
        description:
            "Set the diagram positions of multiple concepts on the active meta sheet in one go, then commit once. " +
            "Use after getDiagramLayout when the user asks to arrange or layout concepts on the meta diagram. " +
            "nodes is an array of { path: string, x: number, y: number }; path is the concept path (from getDiagramLayout or getMetaInfo).",
        parameters: {
            type: "object",
            properties: {
                nodes: {
                    type: "array",
                    description: "Array of { path: string, x: number, y: number } for each concept to position.",
                    items: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Concept path (e.g. /1/2 or path from getDiagramLayout)." },
                            x: { type: "number", description: "X coordinate." },
                            y: { type: "number", description: "Y coordinate." },
                        },
                        required: ["path", "x", "y"],
                    },
                } as import("../tools").ToolParameter,
            },
            required: ["nodes"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const sheetSetId = getActiveSheetSetId(ctx);
        if (!sheetSetId) {
            return { data: { error: "No meta sheet is active. Ensure the project has meta sheets and the client sends activeTabId (e.g. from the Meta Editor tab)." } };
        }
        const nodesArg = args.nodes;
        if (!Array.isArray(nodesArg) || nodesArg.length === 0) {
            return { data: { error: "nodes must be a non-empty array of { path, x, y }." } };
        }
        const errors: string[] = [];
        const updated: string[] = [];
        try {
            const members = core.getMemberPaths(root, sheetSetId) || [];
            for (const item of nodesArg) {
                const pathOrName = item?.path != null ? String(item.path).trim() : "";
                const x = typeof item.x === "number" ? item.x : Number(item.x);
                const y = typeof item.y === "number" ? item.y : Number(item.y);
                if (pathOrName === "" || Number.isNaN(x) || Number.isNaN(y)) {
                    errors.push("Invalid item: path, x, y required (numbers).");
                    continue;
                }
                const conceptPath = await resolveMetaPathOrName(core, root, pathOrName);
                if (conceptPath == null) {
                    errors.push("Concept not found: " + pathOrName);
                    continue;
                }
                if (members.indexOf(conceptPath) === -1) {
                    errors.push("Concept " + conceptPath + " is not on the active sheet.");
                    continue;
                }
                core.setMemberRegistry(root, sheetSetId, conceptPath, POSITION_REGISTRY_KEY, { x, y });
                updated.push(conceptPath);
            }
            if (updated.length === 0) {
                return { data: { error: errors.length > 0 ? errors.join("; ") : "No valid nodes to update." } };
            }
            await commitCoreSession(ctx.coreSession, "GMEBot: setConceptLayout");
            return {
                data: {
                    committed: true,
                    sheetSetId,
                    updated,
                    ...(errors.length > 0 ? { warnings: errors } : {}),
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "setConceptLayout", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

export const META_TOOLS: Tool[] = [
    createMetaSheet,
    switchToMetaSheet,
    deleteMetaSheet,
    isMetaNodeTool,
    createMetaNode,
    setMetaAttribute,
    delMetaAttribute,
    setMetaContainment,
    delMetaContainment,
    setMetaPointer,
    delMetaPointer,
    delMetaSet,
    setMetaSet,
    setMetaMixin,
    delMetaMixin,
    checkMetaConsistency,
    checkModelConsistency,
    getMetaInfo,
    getDiagramLayout,
    setConceptPosition,
    setConceptLayout,
];
