import {
    buildMetaDescriptorFromCore,
    buildObjectListFromCore,
    type MetaDescriptor,
    type ObjectList,
} from "./metaDescriptor";
import type { ToolContext } from "./tools";
import { resolveModelingMode, type ModelingMode } from "./tools";

const MAX_CONTEXT_JSON_CHARS = 12000;

function truncateJson(obj: unknown, maxChars: number): string {
    const full = JSON.stringify(obj, null, 2);
    if (full.length <= maxChars) return full;
    return full.slice(0, maxChars) + "\n… (truncated)";
}

export type SessionContextPayload = {
    modelingMode: ModelingMode;
    metaDescriptor?: MetaDescriptor;
    objectList?: ObjectList;
};

/** Build meta descriptor + object list when project is open. */
export function buildSessionContextPayload(ctx: ToolContext): SessionContextPayload | null {
    const mode = resolveModelingMode(ctx.context);
    const clientList = ctx.context?.objectList;
    if (!ctx.coreSession) {
        return {
            modelingMode: mode,
            objectList: {
                existing: clientList?.existing ?? [],
                new: clientList?.new ?? [],
                deleted: clientList?.deleted ?? [],
            },
        };
    }
    const { core, root } = ctx.coreSession;
    if (mode === "metamodel") {
        return {
            modelingMode: mode,
            metaDescriptor: buildMetaDescriptorFromCore(core, root),
            objectList: buildObjectListFromCore(core, root, clientList),
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
            "You are editing the **metamodel** (META types). Use patchMetaDescriptor with JSON Patch on the MetaDescriptor below."
        );
        if (payload.metaDescriptor) {
            parts.push(
                "[Meta descriptor]\n" + truncateJson(payload.metaDescriptor, MAX_CONTEXT_JSON_CHARS)
            );
        }
    } else {
        parts.push(
            "You are in **domain modeling** mode. Instance-edit tools are hidden for now; answer from context and explain what would change."
        );
    }
    if (payload.objectList) {
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
    if (c.activeNodeId) bits.push("activeNodeId=" + c.activeNodeId);
    if (c.activeVisualizerId) bits.push("activeVisualizerId=" + c.activeVisualizerId);
    if (typeof c.activeTabId === "number") bits.push("activeTabId=" + c.activeTabId);
    if (c.modelingMode) bits.push("modelingMode=" + c.modelingMode);
    return bits.length ? bits.join(", ") : "";
}
