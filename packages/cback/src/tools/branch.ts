import type { Tool } from "../toolRegistry";
import { logToolFailure } from "../toolRegistry";

const MASTER_BRANCH = "master";

/** List branches in a project (server-side). Uses context.projectId when projectId is omitted. */
export const listBranches: Tool = {
    definition: {
        name: "listBranches",
        description:
            "List all branches in a WebGME project. Runs on the server. " +
            "Returns branch names and their current commit hashes. " +
            "Use projectId from context when the user refers to the current project.",
        parameters: {
            type: "object",
            properties: {
                projectId: {
                    type: "string",
                    description:
                        "Project to list branches for (e.g. owner+ProjectName). Omit to use the project from the current context.",
                },
            },
            required: [],
        },
    },
    handler: async (args, ctx) => {
        const projectId = args.projectId || ctx.context?.projectId;
        if (!projectId) {
            return {
                data: {
                    error:
                        "No project specified. Provide projectId or ensure the client sends projectId in context.",
                },
            };
        }
        if (!ctx.safeStorage) {
            return { data: { error: "Storage not available" } };
        }

        let project: any;
        try {
            project = await ctx.safeStorage.openProject({
                username: ctx.userId,
                projectId,
            });
        } catch (e: any) {
            logToolFailure(ctx, "listBranches", args, e);
            return { data: { error: "Failed to open project: " + (e && e.message) } };
        }

        try {
            const branches =
                typeof project.getBranches === "function"
                    ? await (project.getBranches() as Promise<Record<string, string>>)
                    : {};
            const branchNames = Object.keys(branches);
            const list = branchNames.map((name) => ({
                name,
                hash: branches[name],
            }));
            return {
                data: {
                    projectId,
                    branches: list,
                    count: list.length,
                },
            };
        } catch (e: any) {
            logToolFailure(ctx, "listBranches", args, e);
            return { data: { error: "Failed to get branches: " + (e && e.message) } };
        }
    },
};

/** Create a branch from a commit (server-side create, then switch client to the new branch). */
export const createBranch: Tool = {
    definition: {
        name: "createBranch",
        description:
            "Create a new branch and switch the user's view to it. Branch is created on the server. " +
            "When fromCommitHash is omitted, the current branch head from context is used (client must send projectId and branchName in context). " +
            "After creation, the client view is switched to the new branch.",
        parameters: {
            type: "object",
            properties: {
                branchName: {
                    type: "string",
                    description: "Name for the new branch.",
                },
                fromCommitHash: {
                    type: "string",
                    description:
                        "Commit hash the new branch head will point to. Omit to use the current branch head from context.",
                },
            },
            required: ["branchName"],
        },
    },
    handler: async (args, ctx) => {
        const projectId = ctx.context?.projectId;
        if (!projectId) {
            return {
                data: {
                    error:
                        "Branches can only be created in the currently open project. Ensure the client sends projectId in context.",
                },
            };
        }
        const branchName = args.branchName;
        if (!branchName) {
            return { data: { error: "branchName is required." } };
        }

        if (!ctx.safeStorage) {
            return { data: { error: "Storage not available" } };
        }
        let project: any;
        try {
            project = await ctx.safeStorage.openProject({
                username: ctx.userId,
                projectId,
            });
        } catch (e: any) {
            logToolFailure(ctx, "createBranch", args, e);
            return { data: { error: "Failed to open project: " + (e && e.message) } };
        }

        let fromCommitHash = args.fromCommitHash;
        if (!fromCommitHash) {
            const contextBranch = ctx.context?.branchName || MASTER_BRANCH;
            try {
                const branches =
                    typeof project.getBranches === "function"
                        ? await (project.getBranches() as Promise<Record<string, string>>)
                        : {};
                fromCommitHash = branches[contextBranch];
            } catch (e: any) {
                logToolFailure(ctx, "createBranch", args, e);
                return { data: { error: "Failed to get branch head for context branch: " + (e && e.message) } };
            }
            if (!fromCommitHash) {
                return {
                    data: {
                        error: `Could not resolve commit hash for branch '${contextBranch}'. Provide fromCommitHash or ensure context has an open branch.`,
                    },
                };
            }
        }

        try {
            await (project.createBranch(branchName, fromCommitHash) as Promise<any>);
        } catch (e: any) {
            logToolFailure(ctx, "createBranch", args, e);
            return { data: { error: "Failed to create branch: " + (e && e.message) } };
        }

        return {
            data: {
                created: true,
                projectId,
                branchName,
                fromCommitHash,
            },
            commands: [
                {
                    type: "switchProject",
                    args: { projectId, branchName },
                },
            ],
        };
    },
};

/** Switch the client view to a branch (client-driven). */
export const switchBranch: Tool = {
    definition: {
        name: "switchBranch",
        description:
            "Switch the user's browser view to a different branch of the current project. Executed in the browser. " +
            "Use listBranches to see available branches.",
        parameters: {
            type: "object",
            properties: {
                branchName: {
                    type: "string",
                    description: "Branch to switch to (e.g. master, feature-x).",
                },
                projectId: {
                    type: "string",
                    description:
                        "Project whose branch to switch. Omit to use the project from context.",
                },
            },
            required: ["branchName"],
        },
    },
    handler: async (args, ctx) => {
        const projectId = args.projectId || ctx.context?.projectId;
        if (!projectId) {
            return {
                data: {
                    error:
                        "No project specified. Provide projectId or ensure the client sends projectId in context.",
                },
            };
        }
        const branchName = args.branchName;
        if (!branchName) {
            return { data: { error: "branchName is required." } };
        }
        return {
            data: { switched: true, projectId, branchName },
            commands: [
                {
                    type: "switchProject",
                    args: { projectId, branchName },
                },
            ],
        };
    },
};

/** Delete a branch and switch the client back to master (master cannot be deleted). */
export const deleteBranch: Tool = {
    definition: {
        name: "deleteBranch",
        description:
            "Delete a branch and switch the user's view back to master. The master branch cannot be deleted. " +
            "Server validates and resolves the branch hash; the actual delete and switch run in the browser.",
        parameters: {
            type: "object",
            properties: {
                branchName: {
                    type: "string",
                    description: "Name of the branch to delete.",
                },
                projectId: {
                    type: "string",
                    description:
                        "Project containing the branch. Omit to use the project from context.",
                },
            },
            required: ["branchName"],
        },
    },
    handler: async (args, ctx) => {
        const branchName = args.branchName;
        if (!branchName) {
            return { data: { error: "branchName is required." } };
        }
        if (branchName === MASTER_BRANCH) {
            return { data: { error: "Cannot delete the master branch." } };
        }

        const projectId = args.projectId || ctx.context?.projectId;
        if (!projectId) {
            return {
                data: {
                    error:
                        "No project specified. Provide projectId or ensure the client sends projectId in context.",
                },
            };
        }
        if (!ctx.safeStorage) {
            return { data: { error: "Storage not available" } };
        }

        let project: any;
        try {
            project = await ctx.safeStorage.openProject({
                username: ctx.userId,
                projectId,
            });
        } catch (e: any) {
            logToolFailure(ctx, "deleteBranch", args, e);
            return { data: { error: "Failed to open project: " + (e && e.message) } };
        }

        let branches: Record<string, string>;
        try {
            branches =
                typeof project.getBranches === "function"
                    ? await (project.getBranches() as Promise<Record<string, string>>)
                    : {};
        } catch (e: any) {
            logToolFailure(ctx, "deleteBranch", args, e);
            return { data: { error: "Failed to get branches: " + (e && e.message) } };
        }

        const branchHash = branches[branchName];
        if (!branchHash) {
            return {
                data: {
                    error: `Branch '${branchName}' not found in project. Use listBranches to see available branches.`,
                },
            };
        }

        return {
            data: {
                deleted: true,
                branchName,
                projectId,
                switchTo: MASTER_BRANCH,
            },
            commands: [
                {
                    type: "deleteBranch",
                    args: { projectId, branchName, branchHash },
                },
                {
                    type: "switchProject",
                    args: { projectId, branchName: MASTER_BRANCH },
                },
            ],
        };
    },
};

/** Squash commits on a branch (client-driven). Uses WebGME client squash; connects history from a given commit to branch head. */
export const squashBranch: Tool = {
    definition: {
        name: "squashBranch",
        description:
            "Squash commits on a branch into a single commit from a given commit up to the branch head, hiding intermediate history. " +
            "Executed in the browser using the client's squash support. fromCommitId is the commit hash above which all commits are squashed (that commit is not included).",
        parameters: {
            type: "object",
            properties: {
                branchName: {
                    type: "string",
                    description:
                        "Branch to squash (e.g. current branch). Omit to use the branch from context.",
                },
                fromCommitId: {
                    type: "string",
                    description:
                        "Commit hash: squash all commits above this one (exclusive) up to the branch head. Use getHistory to find a suitable base commit.",
                },
                message: {
                    type: "string",
                    description: "Optional commit message for the squashed commit.",
                },
                projectId: {
                    type: "string",
                    description:
                        "Project. Omit to use the project from context.",
                },
            },
            required: ["fromCommitId"],
        },
    },
    handler: async (args, ctx) => {
        const projectId = args.projectId || ctx.context?.projectId;
        const branchName = args.branchName || ctx.context?.branchName;
        if (!projectId) {
            return {
                data: {
                    error:
                        "No project specified. Provide projectId or ensure the client sends projectId in context.",
                },
            };
        }
        if (!branchName) {
            return {
                data: {
                    error:
                        "No branch specified. Provide branchName or ensure the client sends branchName in context.",
                },
            };
        }
        const fromCommitId = args.fromCommitId;
        if (!fromCommitId) {
            return { data: { error: "fromCommitId is required." } };
        }
        const message = args.message != null ? String(args.message) : undefined;
        return {
            data: {
                squashRequested: true,
                projectId,
                branchName,
                fromCommitId,
            },
            commands: [
                {
                    type: "squashBranch",
                    args: { projectId, branchName, fromCommitId, message },
                },
            ],
        };
    },
};

export const BRANCH_TOOLS: Tool[] = [
    listBranches,
    createBranch,
    switchBranch,
    deleteBranch,
    squashBranch,
];
