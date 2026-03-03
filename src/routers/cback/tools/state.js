"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVisualizersFromConfig = getVisualizersFromConfig;
exports.getStateTools = getStateTools;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * State tools: client-side state changes (selection, visualizer).
 * These generate commands that the GMEBot executes in the browser to update WebGMEGlobal.State.
 */
/** Fallback when gmeConfig is not available (e.g. tests). */
const DEFAULT_VISUALIZERS = [
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
function getVisualizersFromConfig(gmeConfig) {
    var _a;
    const descriptors = (_a = gmeConfig === null || gmeConfig === void 0 ? void 0 : gmeConfig.visualization) === null || _a === void 0 ? void 0 : _a.visualizerDescriptors;
    if (!Array.isArray(descriptors) || descriptors.length === 0) {
        return [...DEFAULT_VISUALIZERS];
    }
    const byId = new Map();
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
                        if (!byId.has(id))
                            byId.set(id, title);
                    }
                }
            }
        }
        catch {
            // skip invalid or unreadable descriptors
        }
    }
    if (byId.size === 0)
        return DEFAULT_VISUALIZERS;
    return Array.from(byId.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, title]) => ({ id, title }));
}
function createSetClientStateTool(visualizers) {
    const ids = visualizers.map((v) => v.id);
    const idTitleList = visualizers.map((v) => v.id + ' ("' + v.title + '")').join(", ");
    return {
        definition: {
            name: "setClientState",
            description: "Change the client UI state: switch the active selection (context) and/or the visualizer panel. " +
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
                        description: "Node path to select (e.g. '/1', '/' for root). " +
                            "For 'switch to FCO' or 'go to FCO context': call findNodesByName with name 'FCO' first, then pass one of the returned nodePaths here. For nodes by name: call findNodesByName first. Use only paths from tool responses.",
                    },
                    visualizerId: {
                        type: "string",
                        description: "Visualizer id to display (use the id, not the title). ModelEditor=diagram/composition, METAAspect=Meta editor (not the same as ModelEditor). List: " + idTitleList,
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
                        error: "Provide at least one of activeNodeId or visualizerId. Omit the one you do not need to change.",
                    },
                };
            }
            const commandArgs = {};
            if (activeNodeId)
                commandArgs.activeNodeId = activeNodeId;
            if (visualizerId)
                commandArgs.visualizerId = visualizerId;
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
function getStateTools(gmeConfig) {
    const visualizers = gmeConfig ? getVisualizersFromConfig(gmeConfig) : DEFAULT_VISUALIZERS;
    return [createSetClientStateTool(visualizers)];
}
