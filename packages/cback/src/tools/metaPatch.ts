import { Tool, commitCoreSession, logToolFailure } from "../tools";
import { buildMetaDescriptorFromCore, syncMetaDescriptorPatch } from "../metaDescriptor";

function ensureCoreSession(ctx: any) {
    if (!ctx.coreSession) {
        throw new Error(
            "patchMetaDescriptor requires an open project. Send projectId in context."
        );
    }
}

export const patchMetaDescriptor: Tool = {
    definition: {
        name: "patchMetaDescriptor",
        description:
            "Apply an RFC 6902 JSON Patch to the current metamodel MetaDescriptor and sync supported changes to WebGME. " +
            "The full MetaDescriptor is already in chat context — do not call getMetaInfo first. " +
            "Use /concepts/- to append a concept, /concepts/N/... for edits. " +
            "New concepts are created on the server; removals and some relation edits may return warnings until fully implemented.",
        parameters: {
            type: "object",
            properties: {
                patch: {
                    type: "array",
                    description:
                        "JSON Patch operations (add, remove, replace). Example: [{\"op\":\"add\",\"path\":\"/concepts/-\",\"value\":{\"name\":\"State\",\"extends\":\"FCO\"}}]",
                    items: {
                        type: "object",
                        properties: {
                            op: {
                                type: "string",
                                enum: ["add", "remove", "replace", "test"],
                            },
                            path: { type: "string" },
                            value: { type: "object" },
                        },
                        required: ["op", "path"],
                    },
                } as import("../tools").ToolParameter,
            },
            required: ["patch"],
        },
    },
    handler: async (args, ctx) => {
        ensureCoreSession(ctx);
        const { core, root } = ctx.coreSession;
        const patch = args.patch;
        if (!Array.isArray(patch) || patch.length === 0) {
            return { data: { error: "patch must be a non-empty array of operations." } };
        }

        try {
            const before = buildMetaDescriptorFromCore(core, root);
            const result = await syncMetaDescriptorPatch(
                core,
                root,
                before,
                patch,
                (message) => commitCoreSession(ctx.coreSession!, message)
            );
            return {
                data: {
                    ok: true,
                    applied: result.applied,
                    warnings: result.warnings,
                    metaDescriptor: result.metaDescriptor,
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "patchMetaDescriptor", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};

/** Sole meta tool exposed while drilling down metamodeling UX. */
export const META_PATCH_TOOLS: Tool[] = [patchMetaDescriptor];
