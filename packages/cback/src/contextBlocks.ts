import {
    buildConceptRegistryFromCore,
    buildConceptRegistryFromObjectList,
    buildMetaDescriptorFromCore,
    buildObjectListFromCore,
    type ConceptRegistry,
    type MetaDescriptor,
    type ObjectList,
} from "./metaDescriptor";
import type { ToolContext } from "./toolRegistry";
import { resolveModelingMode, type ModelingMode } from "./toolRegistry";

const MAX_CONTEXT_JSON_CHARS = 12000;

function truncateJson(obj: unknown, maxChars: number): string {
    const full = JSON.stringify(obj, null, 2);
    if (full.length <= maxChars) return full;
    return full.slice(0, maxChars) + "\n… (truncated)";
}

export type SessionContextPayload = {
    modelingMode: ModelingMode;
    metaDescriptor?: MetaDescriptor;
    /** Metamodel: name-only registry for the LLM. Domain: full object list (paths kept for future tools). */
    conceptRegistry?: ConceptRegistry;
    objectList?: ObjectList;
};

/** Build meta descriptor + object list when project is open. */
export function buildSessionContextPayload(ctx: ToolContext): SessionContextPayload | null {
    const mode = resolveModelingMode(ctx.context);
    const clientList = ctx.context?.objectList;
    if (!ctx.coreSession) {
        const stubList: ObjectList = {
            existing: clientList?.existing ?? [],
            new: clientList?.new ?? [],
            deleted: clientList?.deleted ?? [],
        };
        return mode === "metamodel"
            ? { modelingMode: mode, conceptRegistry: buildConceptRegistryFromObjectList(stubList) }
            : { modelingMode: mode, objectList: stubList };
    }
    const { core, root } = ctx.coreSession;
    if (mode === "metamodel") {
        return {
            modelingMode: mode,
            metaDescriptor: buildMetaDescriptorFromCore(core, root),
            conceptRegistry: buildConceptRegistryFromCore(core, root, clientList),
        };
    }
    return {
        modelingMode: mode,
        objectList: buildObjectListFromCore(core, root, clientList),
    };
}

/** Blocks appended to the system prompt so tools need not fetch meta first. */
export function formatContextBlocksForSystem(payload: SessionContextPayload | null): string {
    if (!payload) return "";
    const parts: string[] = [];
    parts.push("modelingMode=" + payload.modelingMode);
    if (payload.modelingMode === "metamodel") {
        parts.push(
            "[Metamodel editing — internal, do not repeat to the user]\n" +
                "Use patchMetaDescriptor on the Meta descriptor below. Names only (no paths/guids). " +
                "Maps keyed by name: /concepts/State, /concepts/StateMachine/contains/State, /relationships/Transition. " +
                "Main container = domain name (StateMachine, not Diagram); contains must list node types and connection types. " +
                "Each link: concepts.Transition = {} plus relationships.Transition = { from, to }. No attributes.name."
        );
        parts.push(
            "[How to reply to the user]\n" +
                "Describe the metamodel in modeling terms: what the main model is called, which element types exist, how connections work. " +
                "Do not explain JSON Patch, descriptor structure, contains/relationships syntax, FCO, or cardinality unless asked."
        );
        if (payload.metaDescriptor) {
            parts.push(
                "[Meta descriptor — for edits only, not for quoting to the user]\n" +
                    truncateJson(payload.metaDescriptor, MAX_CONTEXT_JSON_CHARS)
            );
        }
        if (payload.conceptRegistry) {
            parts.push(
                "[Concept registry]\n" + truncateJson(payload.conceptRegistry, MAX_CONTEXT_JSON_CHARS)
            );
        }
    } else {
        parts.push(
            "You are in **domain modeling** mode. Instance-edit tools are hidden for now; answer from context and explain what would change."
        );
    }
    if (payload.modelingMode !== "metamodel" && payload.objectList) {
        parts.push("[Object list]\n" + truncateJson(payload.objectList, MAX_CONTEXT_JSON_CHARS));
    }
    return parts.join("\n\n");
}

/** Short per-turn hint (project/selection). */
export function formatTurnContextLine(ctx: ToolContext): string {
    const c = ctx.context;
    if (!c) return "";
    const bits: string[] = [];
    if (c.projectId) bits.push("projectId=" + c.projectId);
    if (c.branchName) bits.push("branchName=" + c.branchName);
    const mode = resolveModelingMode(c);
    if (mode !== "metamodel" && c.activeNodeId) bits.push("activeNodeId=" + c.activeNodeId);
    if (c.activeVisualizerId) bits.push("activeVisualizerId=" + c.activeVisualizerId);
    if (typeof c.activeTabId === "number") bits.push("activeTabId=" + c.activeTabId);
    if (c.modelingMode) bits.push("modelingMode=" + c.modelingMode);
    return bits.length ? bits.join(", ") : "";
}
