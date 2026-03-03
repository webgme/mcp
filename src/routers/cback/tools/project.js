"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROJECT_TOOLS = exports.switchProject = exports.listProjects = exports.createProject = exports.listSeeds = void 0;
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
    handler: async (_args, _ctx) => {
        // TODO: use ctx.safeStorage / gmeConfig to enumerate available seeds
        return { data: { seeds: [] } };
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
    handler: async (_args, _ctx) => {
        // TODO: call ctx.safeStorage.createProject / seed logic
        return { data: { created: false, message: "not implemented yet" } };
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
        ctx.logger.info("getProjects raw response: " + JSON.stringify(raw, null, 2));
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
];
