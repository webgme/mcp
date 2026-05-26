import type { Tool, ToolParameter } from "../toolRegistry";
import { commitCoreSession, logToolFailure } from "../toolRegistry";
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
            "Apply JSON Patch to the metamodel descriptor (map-based, names only). " +
            "Rules: domain-named main container (not Diagram); contains lists nodes and connection types; " +
            "each link type needs concepts.{Name}={} and relationships.{Name}={from,to}. No attributes.name. " +
            "Use **one** patchMetaDescriptor call per user turn with every op in `patch` (never multiple tool calls — one commit). " +
            "Paths: /concepts/{Name}, /concepts/{Container}/contains/{Child}, /relationships/{Link}. " +
            "FSM example: add State, Transition, StateMachine with {\"contains\":{\"State\":\"*\",\"Transition\":\"*\"}}, then relationships.Transition {from,to} State. " +
            "After ok, summarize for the user in plain language — do not call the tool again.",
        parameters: {
            type: "object",
            properties: {
                patch: {
                    type: "array",
                    description:
                        "JSON Patch operations. Example FSM: [{\"op\":\"add\",\"path\":\"/concepts/State\",\"value\":{}},{\"op\":\"add\",\"path\":\"/concepts/Transition\",\"value\":{}},{\"op\":\"add\",\"path\":\"/concepts/StateMachine\",\"value\":{\"contains\":{\"State\":\"*\",\"Transition\":\"*\"}}},{\"op\":\"add\",\"path\":\"/relationships/Transition\",\"value\":{\"from\":\"State\",\"to\":\"State\"}}]",
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
                } as ToolParameter,
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
        ctx.logger.info(
            "patchMetaDescriptor " +
                (patchLog.length > 48000 ? patchLog.slice(0, 48000) + "…" : patchLog)
        );

        try {
            const before = buildMetaDescriptorFromCore(core, root);
            const result = await syncMetaDescriptorPatch(
                core,
                root,
                before,
                patch,
                (message) => commitCoreSession(ctx.coreSession!, message)
            );
            ctx.logger.info(
                "patchMetaDescriptor done applied=" +
                    result.applied.length +
                    " warnings=" +
                    result.warnings.length
            );
            const data: {
                ok: boolean;
                warnings?: string[];
                applied?: string[];
                error?: string;
            } = { ok: true };
            if (result.applied.length) data.applied = result.applied;
            if (result.warnings.length) data.warnings = result.warnings;
            return { data };
        } catch (e: any) {
            logToolFailure(ctx, "patchMetaDescriptor", args, e);
            return { data: { ok: false, error: (e && e.message) || String(e) } };
        }
    },
};

/** Sole meta tool exposed while drilling down metamodeling UX. */
export const META_PATCH_TOOLS: Tool[] = [patchMetaDescriptor];
