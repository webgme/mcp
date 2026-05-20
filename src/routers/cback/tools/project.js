"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROJECT_TOOLS = exports.switchProject = exports.listProjects = exports.deleteProject = exports.createProject = exports.listSeeds = void 0;
const toolRegistry_1 = require("../toolRegistry");
exports.listSeeds = {
    definition: {
        name: "listSeeds",
        description: "List all available project seeds that can be used to create new WebGME projects. " +
            "Returns a JSON object with a 'seeds' array containing seed names.",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
    },
    handler: async (_args, ctx) => {
        const gmeConfig = ctx.gmeConfig;
        if (!gmeConfig || !gmeConfig.seedProjects) {
            return { data: { seeds: [] } };
        }
        let seedDict = {};
        try {
            // Prefer the engine helper when available.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const engineUtils = require("webgme-engine/src/utils");
            if (engineUtils && typeof engineUtils.getSeedDictionarySync === "function") {
                seedDict = engineUtils.getSeedDictionarySync(gmeConfig) || {};
            }
        }
        catch (e) {
            ctx.logger.debug("listSeeds: engine utils unavailable: " + (e && e.message));
        }
        const seeds = Object.keys(seedDict).sort();
        return { data: { seeds } };
    },
};
exports.createProject = {
    definition: {
        name: "createProject",
        description: "Create a new WebGME project, optionally from a seed. " +
            "Returns a JSON object with 'created' (boolean) and 'message'.",
        parameters: {
            type: "object",
            properties: {
                projectName: {
                    type: "string",
                    description: "Name for the new project.",
                },
                seedName: {
                    type: "string",
                    description: "Optional seed to initialise the project from (use listSeeds to discover available seeds).",
                },
            },
            required: ["projectName"],
        },
    },
    handler: async (args, ctx) => {
        if (!ctx.safeStorage) {
            return { data: { created: false, message: "storage not available" } };
        }
        const projectName = args.projectName;
        const seedName = args.seedName;
        if (!projectName || typeof projectName !== "string") {
            return { data: { created: false, message: "projectName is required." } };
        }
        const data = {
            projectName,
            username: ctx.userId,
            ownerId: ctx.userId,
        };
        // For now we store the requested seed as project kind; actual seeding is handled by WebGME tooling.
        if (seedName && typeof seedName === "string") {
            data.kind = seedName;
        }
        try {
            const project = await ctx.safeStorage.createProject(data);
            const projectId = (project && typeof project.getProjectId === "function"
                ? project.getProjectId()
                : (project && (project.projectId || project._id))) || "";
            return {
                data: {
                    created: true,
                    message: seedName
                        ? `Project '${projectName}' created (seed '${seedName}' requested).`
                        : `Project '${projectName}' created.`,
                    projectId,
                },
            };
        }
        catch (e) {
            (0, toolRegistry_1.logToolFailure)(ctx, "createProject", args, e);
            return {
                data: {
                    created: false,
                    message: "Failed to create project: " + (e && e.message),
                },
            };
        }
    },
};
exports.deleteProject = {
    definition: {
        name: "deleteProject",
        description: "Delete a WebGME project on the server. " +
            "The user must have delete rights on the project. " +
            "Returns a JSON object with 'deleted' (boolean) and 'projectId'.",
        parameters: {
            type: "object",
            properties: {
                projectId: {
                    type: "string",
                    description: "Identifier of the project to delete (e.g. owner+MyProject). Use listProjects to discover available IDs.",
                },
            },
            required: ["projectId"],
        },
    },
    handler: async (args, ctx) => {
        if (!ctx.safeStorage) {
            return { data: { deleted: false, message: "storage not available" } };
        }
        const projectId = args.projectId;
        if (!projectId || typeof projectId !== "string") {
            return { data: { deleted: false, message: "projectId is required." } };
        }
        try {
            const didExist = await ctx.safeStorage.deleteProject({
                projectId,
                username: ctx.userId,
            });
            return {
                data: {
                    deleted: !!didExist,
                    projectId,
                },
            };
        }
        catch (e) {
            (0, toolRegistry_1.logToolFailure)(ctx, "deleteProject", args, e);
            return {
                data: {
                    deleted: false,
                    projectId,
                    message: "Failed to delete project: " + (e && e.message),
                },
            };
        }
    },
};
exports.listProjects = {
    definition: {
        name: "listProjects",
        description: "List all WebGME projects accessible to the current user. " +
            "Returns a JSON object with a 'projects' array and 'count'. " +
            "Each project has: projectId (unique, format 'owner+name'), " +
            "owner, name, displayName, and description. " +
            "Always use the full projectId when referencing a specific project.",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
    },
    handler: async (_args, ctx) => {
        if (!ctx.safeStorage) {
            return { data: { error: "storage not available" } };
        }
        const raw = await ctx.safeStorage.getProjects({
            username: ctx.userId,
            info: true,
        });
        ctx.logger.debug("listProjects raw response: " + JSON.stringify(raw, null, 2));
        const projects = raw.map((p) => {
            const id = p._id || "";
            const parts = id.split("+");
            const owner = parts[0] || "";
            const name = parts.slice(1).join("+") || "";
            return {
                projectId: id,
                owner: owner,
                name: name,
                displayName: owner + " / " + name,
                description: (p.info && p.info.description) || "",
            };
        });
        return { data: { projects, count: projects.length } };
    },
};
exports.switchProject = {
    definition: {
        name: "switchProject",
        description: "Switch the user's active browser view to a different WebGME project " +
            "and optionally to a specific branch. " +
            "Returns a JSON object with 'switched' (boolean), 'projectId', and 'branchName' if provided.",
        parameters: {
            type: "object",
            properties: {
                projectId: {
                    type: "string",
                    description: "The project identifier to switch to (e.g. guest+MyProject). Use listProjects to discover available IDs.",
                },
                branchName: {
                    type: "string",
                    description: "Optional branch name to open (e.g. master). If omitted, the default branch is used.",
                },
            },
            required: ["projectId"],
        },
    },
    handler: async (args, _ctx) => {
        // TODO: validate projectId exists before emitting the command
        const cmdArgs = { projectId: args.projectId };
        if (args.branchName) {
            cmdArgs.branchName = args.branchName;
        }
        return {
            data: { switched: true, projectId: args.projectId, branchName: args.branchName || null },
            commands: [
                { type: "switchProject", args: cmdArgs },
            ],
        };
    },
};
exports.PROJECT_TOOLS = [
    exports.listSeeds,
    exports.createProject,
    exports.listProjects,
    exports.switchProject,
    exports.deleteProject,
];
