"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.META_PATCH_TOOLS = exports.patchMetaDescriptor = void 0;
const tools_1 = require("../tools");
const metaDescriptor_1 = require("../metaDescriptor");
function ensureCoreSession(ctx) {
    if (!ctx.coreSession) {
        throw new Error("patchMetaDescriptor requires an open project. Send projectId in context.");
    }
}
exports.patchMetaDescriptor = {
    definition: {
        name: "patchMetaDescriptor",
        description: "Apply an RFC 6902 JSON Patch to the current metamodel MetaDescriptor and sync supported changes to WebGME. " +
            "The full MetaDescriptor is already in chat context — do not call getMetaInfo first. " +
            "Use /concepts/- to append a concept, /concepts/N/... for edits. " +
            "New concepts are created on the server; removals and some relation edits may return warnings until fully implemented.",
        parameters: {
            type: "object",
            properties: {
                patch: {
                    type: "array",
                    description: "JSON Patch operations (add, remove, replace). Example: [{\"op\":\"add\",\"path\":\"/concepts/-\",\"value\":{\"name\":\"State\",\"extends\":\"FCO\"}}]",
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
                },
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
            const before = (0, metaDescriptor_1.buildMetaDescriptorFromCore)(core, root);
            const result = await (0, metaDescriptor_1.syncMetaDescriptorPatch)(core, root, before, patch, (message) => (0, tools_1.commitCoreSession)(ctx.coreSession, message));
            return {
                data: {
                    ok: true,
                    applied: result.applied,
                    warnings: result.warnings,
                    metaDescriptor: result.metaDescriptor,
                },
            };
        }
        catch (e) {
            (0, tools_1.logToolFailure)(ctx, "patchMetaDescriptor", args, e);
            return { data: { error: (e && e.message) || String(e) } };
        }
    },
};
/** Sole meta tool exposed while drilling down metamodeling UX. */
exports.META_PATCH_TOOLS = [exports.patchMetaDescriptor];
