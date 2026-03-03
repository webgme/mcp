import * as fs from "fs";
import * as path from "path";
import { Tool } from "../tools";

/**
 * State tools: client-side state changes (selection, visualizer).
 * These generate commands that the GMEBot executes in the browser to update WebGMEGlobal.State.
 */

/** Fallback when gmeConfig is not available (e.g. tests). */
const DEFAULT_VISUALIZERS: { id: string; title: string }[] = [
    { id: "ModelEditor", title: "Composition" },
    { id: "Crosscut", title: "Crosscut" },
    { id: "SetEditor", title: "Set membership" },
    { id: "METAAspect", title: "Meta" },
    { id: "GMEBot", title: "GMEBot" },
];

/**
 * Load visualizers (id + title) from gmeConfig.visualization.visualizerDescriptors.
 * Each descriptor path points to a JSON array of { id, title, panel, ... }.
 */
export function getVisualizersFromConfig(gmeConfig: any): { id: string; title: string }[] {
    const descriptors = gmeConfig?.visualization?.visualizerDescriptors;
    if (!Array.isArray(descriptors) || descriptors.length === 0) {
        return [...DEFAULT_VISUALIZERS];
    }
    const byId = new Map<string, string>();
    for (const descPath of descriptors) {
        try {
            const resolved = path.isAbsolute(descPath) ? descPath : path.resolve(descPath);
            const raw = fs.readFileSync(resolved, "utf8");
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                for (const v of arr) {
                    if (v && typeof v.id === "string") {
                        const id = String(v.id).trim();
                        const title = (v.title != null ? String(v.title).trim() : id) || id;
                        if (!byId.has(id)) byId.set(id, title);
                    }
                }
            }
        } catch {
            // skip invalid or unreadable descriptors
        }
    }
    if (byId.size === 0) return DEFAULT_VISUALIZERS;
    return Array.from(byId.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, title]) => ({ id, title }));
}

function createSetClientStateTool(visualizers: { id: string; title: string }[]): Tool {
    const ids = visualizers.map((v) => v.id);
    const idTitleList = visualizers.map((v) => v.id + ' ("' + v.title + '")').join(", ");
    return {
        definition: {
            name: "setClientState",
            description:
                "Change the client UI state: switch the active selection (context) and/or the visualizer panel. " +
                "Use this when the user wants to 'select node X', 'go to node Y', 'switch to the diagram', 'switch to FCO context', etc. " +
                "For FCO context: call findNodesByName with name 'FCO', then pass one of the returned nodePaths as activeNodeId. For other nodes by name: call findNodesByName first. " +
                "Provide at least one of activeNodeId or visualizerId. Both are optional; omit the one you do not need to change. " +
                "visualizerId must be one of: " + idTitleList + ". Use the id (first part). " +
                "Important: ModelEditor = diagram/composition view; METAAspect = Meta editor — these are different; 'meta' → METAAspect, 'model'/'diagram' → ModelEditor.",
            parameters: {
                type: "object",
                properties: {
                    activeNodeId: {
                        type: "string",
                        description:
                            "Node path to select (e.g. '/1', '/' for root). " +
                            "For 'switch to FCO' or 'go to FCO context': call findNodesByName with name 'FCO' first, then pass one of the returned nodePaths here. For nodes by name: call findNodesByName first. Use only paths from tool responses.",
                    },
                    visualizerId: {
                        type: "string",
                        description:
                            "Visualizer id to display (use the id, not the title). ModelEditor=diagram/composition, METAAspect=Meta editor (not the same as ModelEditor). List: " + idTitleList,
                        enum: ids,
                    },
                },
                required: [],
            },
        },
        handler: async (args, _ctx) => {
        const activeNodeId = args.activeNodeId != null ? String(args.activeNodeId).trim() : undefined;
        const visualizerId = args.visualizerId != null ? String(args.visualizerId).trim() : undefined;

        if (!activeNodeId && !visualizerId) {
            return {
                data: {
                    error:
                        "Provide at least one of activeNodeId or visualizerId. Omit the one you do not need to change.",
                },
            };
        }

        const commandArgs: Record<string, string> = {};
        if (activeNodeId) commandArgs.activeNodeId = activeNodeId;
        if (visualizerId) commandArgs.visualizerId = visualizerId;

        return {
            data: {
                setClientState: true,
                ...(activeNodeId ? { activeNodeId } : {}),
                ...(visualizerId ? { visualizerId } : {}),
            },
            commands: [{ type: "setClientState", args: commandArgs }],
        };
        },
    };
}

/** State tools built with visualizers from gmeConfig. Pass gmeConfig for deployment-specific list. */
export function getStateTools(gmeConfig?: any): Tool[] {
    const visualizers = gmeConfig ? getVisualizersFromConfig(gmeConfig) : DEFAULT_VISUALIZERS;
    return [createSetClientStateTool(visualizers)];
}
