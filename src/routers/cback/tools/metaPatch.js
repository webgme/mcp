"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.META_PATCH_TOOLS = exports.patchMetaDescriptor = void 0;
const toolRegistry_1 = require("../toolRegistry");
const metaDescriptor_1 = require("../metaDescriptor");
function ensureCoreSession(ctx) {
    if (!ctx.coreSession) {
        throw new Error("patchMetaDescriptor requires an open project. Send projectId in context.");
    }
}
exports.patchMetaDescriptor = {
    definition: {
        name: "patchMetaDescriptor",
        description: "Apply JSON Patch to the metamodel descriptor (map-based, names only). " +
            "Rules: domain-named main container (not Diagram); contains lists nodes and connection types; " +
            "each link type needs concepts.{Name}={} and relationships.{Name}={from,to}. No attributes.name. " +
            "Prefer one patch with all concepts, contains, and relationships. " +
            "After success, tell the user what they can model in plain language — do not describe patch paths or descriptor layout.",
        parameters: {
            type: "object",
            properties: {
                patch: {
                    type: "array",
                    description: "JSON Patch operations. Example: [{\"op\":\"add\",\"path\":\"/concepts/State\",\"value\":{}},{\"op\":\"add\",\"path\":\"/relationships/Transition\",\"value\":{\"from\":\"State\",\"to\":\"State\"}}]",
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
        const patchLog = JSON.stringify(patch);
        ctx.logger.info("patchMetaDescriptor " +
            (patchLog.length > 48000 ? patchLog.slice(0, 48000) + "…" : patchLog));
        try {
            const before = (0, metaDescriptor_1.buildMetaDescriptorFromCore)(core, root);
            const result = await (0, metaDescriptor_1.syncMetaDescriptorPatch)(core, root, before, patch, (message) => (0, toolRegistry_1.commitCoreSession)(ctx.coreSession, message));
            ctx.logger.info("patchMetaDescriptor done applied=" +
                result.applied.length +
                " warnings=" +
                result.warnings.length);
            const data = { ok: true };
            if (result.warnings.length)
                data.warnings = result.warnings;
            return { data };
        }
        catch (e) {
            (0, toolRegistry_1.logToolFailure)(ctx, "patchMetaDescriptor", args, e);
            return { data: { ok: false, error: (e && e.message) || String(e) } };
        }
    },
};
/** Sole meta tool exposed while drilling down metamodeling UX. */
exports.META_PATCH_TOOLS = [exports.patchMetaDescriptor];
