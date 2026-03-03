import express, { Request, Response, NextFunction } from "express";
import { chatCompletion, ChatMessage, OllamaConfig, DEFAULT_CONFIG } from "./ollama";
import { getToolDefinitionsForLLM, getToolMap, ToolContext, ClientCommand, ToolHandler } from "./tools";

const router = express.Router();

type MiddlewareOptions = {
    gmeConfig: any;
    logger: any;
    ensureAuthenticated: (req: Request, res: Response, next: NextFunction) => void;
    getUserId: (req: Request) => string;
    gmeAuth: any;
    safeStorage: any;
    workerManager: any;
};

const SYSTEM_PROMPT =
    "You are GMEBot, an assistant embedded in a WebGME modeling environment. " +
    "You help users manage their projects and metamodels. " +
    "You have tools available — always call them instead of guessing. " +
    "For example, call listProjects to see projects, listSeeds to see seeds, " +
    "createProject to create one, and switchProject to navigate to one. " +
    "Each tool returns JSON data. Present the results clearly to the user. " +
    "If a tool returns an error or 'not implemented', tell the user. " +
    "When the client sends current context (projectId, branchName, activeNodeId), that is the user's open project and selection. " +
    "Use that as the default when the user does not specify a project or node — do not ask them to choose a project unless they explicitly want to switch or create one. " +
    "For tool calls, omit optional parameters when the user did not specify them; the backend will use default values. " +
    "If the user asks to 'create a node' or 'add a node' without giving type or parent, call createNode with no arguments (empty object) and do not ask them for type or parent. " +
    "In WebGME, FCO means First Class Object (not Foundation Class Object). " +
    "When the user says 'set the X to Y' or 'set X of the node to Y' (e.g. set the position to 400 400, set the name to MyNode), you MUST call getPropertyNames first. Look at the response: if the property is in the 'registry' array you MUST use setRegistry; if it is in the 'attributes' array you MUST use setAttribute. Never use setAttribute for a property that is in registry (e.g. position is always in registry — use setRegistry). " +
    "When the user refers to a node by name (e.g. 'the node named X', 'set position of MyNode'), call findNodesByName first. The response includes nodePaths. You MUST then pass one of those nodePaths as the nodeId parameter in every following tool call that targets that node (getPropertyNames, setAttribute, setRegistry). Do not omit nodeId when you have a path from findNodesByName. " +
    "When setting a property, use the same format as the current value in getPropertyNames (attributeValues or registryValues); if the value is empty, use valueFormats when provided. " +
    "When the user wants to select a node, go to a node, or switch the visualizer (e.g. 'select node X', 'go to the root', 'switch to the diagram'), use setClientState with activeNodeId and/or visualizerId. " +
    "Always get the path from a tool first: for 'switch to FCO' or 'go to FCO context', call findNodesByName with name 'FCO', then setClientState with one of the returned nodePaths as activeNodeId. For other nodes by name, call findNodesByName first. For root use '/'. Do not guess paths — use only paths from tool responses.";

const MAX_TOOL_ROUNDS = 5;

/** Match only when "project" is explicitly mentioned — avoid matching "switch to the diagram" etc. */
const SWITCH_PROJECT_PATTERN = /\b(switch|open|go to|change to|load)\s+(?:to\s+)?project\b|(?:switch|open)\s+project\b|\bswitchProject\b/i;

const RECENT_MESSAGES_LOOKBACK = 20;

function looksLikeSwitchProjectRequest(text: string): boolean {
    return SWITCH_PROJECT_PATTERN.test(text);
}

function historyHasProjectList(history: ChatMessage[]): boolean {
    const start = Math.max(0, history.length - RECENT_MESSAGES_LOOKBACK);
    for (let i = start; i < history.length; i++) {
        const m = history[i];
        if (m.role !== "tool" || !m.content) continue;
        try {
            const data = JSON.parse(m.content);
            if (data && Array.isArray(data.projects)) return true;
        } catch (_e) { /* ignore */ }
    }
    return false;
}

async function ensureProjectListInContext(
    history: ChatMessage[],
    listProjectsHandler: ToolHandler,
    toolCtx: ToolContext
): Promise<void> {
    const lastUser = history.filter(m => m.role === "user").pop();
    if (!lastUser || typeof lastUser.content !== "string") return;
    if (!looksLikeSwitchProjectRequest(lastUser.content)) return;
    if (historyHasProjectList(history)) return;

    const { data } = await listProjectsHandler({}, toolCtx);
    const MAX_INJECTED = 30;
    const projects = Array.isArray(data?.projects)
        ? data.projects
            .slice(0, MAX_INJECTED)
            .map((p: any) => ({ projectId: p.projectId, displayName: p.displayName || p.projectId }))
        : [];
    const payload = { projects, count: data?.count ?? projects.length };
    const injectedId = "injected-list-projects-" + Date.now();
    history.push({
        role: "assistant",
        content: "",
        tool_calls: [{
            id: injectedId,
            type: "function",
            function: { name: "listProjects", arguments: "{}" },
        }],
    });
    history.push({
        role: "tool",
        content: JSON.stringify(payload),
        tool_call_id: injectedId,
    });
}

const sessions = new Map<string, ChatMessage[]>();

function getSession(userId: string): ChatMessage[] {
    if (!sessions.has(userId)) {
        sessions.set(userId, [{ role: "system", content: SYSTEM_PROMPT }]);
    }
    return sessions.get(userId)!;
}

/**
 * Create a Core session from storage (open project, load root).
 * Only the backend/router should call this; tools must not import webgme/core.
 * Uses middleware's safeStorage and gmeConfig.
 */
async function createCoreSession(
    safeStorage: any,
    gmeConfig: any,
    userId: string,
    projectId: string,
    branchName: string,
    log: any
): Promise<ToolContext["coreSession"] | null> {
    if (!safeStorage || !gmeConfig) return null;
    let CoreClass: any;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const webgme = require("webgme");
        CoreClass = webgme.requirejs("common/core/coreQ");
    } catch (e: any) {
        log.warn("createCoreSession: could not load Core: " + (e && e.message));
        return null;
    }
    let project: any;
    try {
        project = await safeStorage.openProject({ username: userId, projectId });
    } catch (e: any) {
        log.warn("createCoreSession openProject failed: " + (e && e.message));
        return null;
    }
    const branch = branchName || "master";
    let commitObject: any;
    try {
        commitObject = await project.getCommitObject(branch);
    } catch (e: any) {
        log.warn("createCoreSession getCommitObject failed: " + (e && e.message));
        return null;
    }
    const core = new CoreClass(project, {
        globConf: gmeConfig,
        logger: log.fork("core"),
    });
    let root: any;
    try {
        root = await core.loadRoot(commitObject.root);
    } catch (e: any) {
        log.warn("createCoreSession loadRoot failed: " + (e && e.message));
        return null;
    }
    return { core, root, project, commitObject, branchName: branch };
}

function initialize(middlewareOpts: MiddlewareOptions) {
    const logger = middlewareOpts.logger.fork("cback");
    const ensureAuthenticated = middlewareOpts.ensureAuthenticated;
    const getUserId = middlewareOpts.getUserId;

    const ollamaConfig: OllamaConfig = { ...DEFAULT_CONFIG };

    const toolDefs = getToolDefinitionsForLLM(middlewareOpts.gmeConfig);
    const toolMap = getToolMap(middlewareOpts.gmeConfig);

    logger.debug("initializing ...");

    router.use("*", function (_req: Request, res: Response, next: NextFunction) {
        res.setHeader("X-WebGME-Media-Type", "webgme.v1");
        next();
    });

    router.use("*", ensureAuthenticated);

    router.get("/test", function (req: Request, res: Response) {
        const userId = getUserId(req);
        res.json({ ok: true, router: "cback", userId });
    });

    router.get("/config", function (_req: Request, res: Response) {
        res.json({
            ollama: {
                host: ollamaConfig.host,
                port: ollamaConfig.port,
                model: ollamaConfig.model,
            },
            tools: toolDefs,
        });
    });

    router.post("/chat", express.json(), async function (req: Request, res: Response) {
        const userId = getUserId(req);
        const userMessage: string = req.body?.message;
        /** Context is provided by the client only (active node, project, branch). Server never gathers or stores it. */
        const context = req.body?.context;

        if (context && typeof context === "object") {
            logger.debug("chat context from client: " + JSON.stringify(context));
        }

        logger.info("chat payload received: " + JSON.stringify({
            message: userMessage,
            context: context,
        }, null, 2));

        if (!userMessage || typeof userMessage !== "string") {
            res.status(400).json({ error: "Missing 'message' in request body" });
            return;
        }

        const history = getSession(userId);
        const ctxParts: string[] = [];
        if (context && typeof context === "object") {
            if (context.projectId) ctxParts.push("projectId=" + context.projectId);
            if (context.branchName) ctxParts.push("branchName=" + context.branchName);
            if (context.activeNodeId) ctxParts.push("activeNodeId=" + context.activeNodeId);
        }
        const userContent =
            ctxParts.length > 0
                ? userMessage + "\n[Current context: " + ctxParts.join(", ") + ". Use these when the user does not specify otherwise.]"
                : userMessage;
        history.push({ role: "user", content: userContent });

        const toolCtx: ToolContext = {
            userId,
            logger: logger.fork("tools"),
            safeStorage: middlewareOpts.safeStorage,
            gmeAuth: middlewareOpts.gmeAuth,
            context: context && typeof context === "object" ? context : undefined,
        };

        if (context && typeof context === "object" && context.projectId) {
            const session = await createCoreSession(
                middlewareOpts.safeStorage,
                middlewareOpts.gmeConfig,
                userId,
                context.projectId,
                context.branchName || "master",
                logger
            );
            if (session) {
                toolCtx.coreSession = session;
            }
        }

        try {
            const listProjectsHandler = toolMap.get("listProjects");
            if (listProjectsHandler) {
                await ensureProjectListInContext(history, listProjectsHandler, toolCtx);
            }

            let rounds = 0;
            const commands: ClientCommand[] = [];

            logger.debug("chat request from " + userId + ": " + userMessage);

            while (rounds < MAX_TOOL_ROUNDS) {
                rounds++;

                logger.debug("ollama round " + rounds);
                const result = await chatCompletion(history, toolDefs, ollamaConfig);
                const msg = result.message;

                history.push(msg);

                if (!msg.tool_calls || msg.tool_calls.length === 0) {
                    logger.debug("reply: " + (msg.content || "").substring(0, 120));
                    const response: any = { reply: msg.content };
                    if (commands.length > 0) {
                        response.commands = commands;
                    }
                    res.json(response);
                    return;
                }

                for (const call of msg.tool_calls) {
                    const rawArgs = call.function.arguments;
                    logger.debug("tool call: " + call.function.name +
                        "(" + JSON.stringify(rawArgs) + ")");

                    let args: Record<string, any> = {};
                    if (typeof rawArgs === "string") {
                        try {
                            args = JSON.parse(rawArgs);
                        } catch (parseErr: any) {
                            logger.warn("tool arguments invalid JSON (" + call.function.name + "): " +
                                parseErr.message + "; raw=" + String(rawArgs).slice(0, 80));
                            args = {};
                        }
                    } else if (rawArgs && typeof rawArgs === "object") {
                        args = rawArgs;
                    }

                    const handler = toolMap.get(call.function.name);
                    let toolResult: any;

                    logger.info("tool received: " + call.function.name + " args=" + JSON.stringify(args) +
                        " ctx=" + JSON.stringify({
                            userId: toolCtx.userId,
                            context: toolCtx.context,
                            hasCoreSession: !!toolCtx.coreSession,
                        }));

                    if (handler) {
                        try {
                            const handlerResult = await handler(args, toolCtx);
                            toolResult = handlerResult.data;
                            if (handlerResult.commands) {
                                commands.push(...handlerResult.commands);
                            }
                            const resultStr = JSON.stringify(toolResult);
                            const resultPreview = resultStr.length > 2000
                                ? resultStr.substring(0, 2000) + "... (truncated)"
                                : resultStr;
                            logger.info("tool response: " + call.function.name + " -> " + resultPreview);
                            logger.debug("tool result: " + resultStr);
                        } catch (err: any) {
                            logger.warn("tool error (" + call.function.name + "): " +
                                err.message);
                            toolResult = { error: err.message };
                        }
                    } else {
                        logger.warn("unknown tool: " + call.function.name);
                        toolResult = { error: `Unknown tool: ${call.function.name}` };
                    }

                    history.push({
                        role: "tool",
                        content: JSON.stringify(toolResult),
                        tool_call_id: call.id,
                    });
                }
            }

            logger.warn("max tool rounds reached for " + userId);
            res.json({ reply: "Reached maximum tool call rounds without a final answer." });
        } catch (err: any) {
            logger.error("chat error for " + userId + ": " + err.message);
            logger.error(err.stack || err);
            res.status(502).json({ error: err.message });
        }
    });

    router.delete("/session", function (req: Request, res: Response) {
        const userId = getUserId(req);
        sessions.delete(userId);
        res.json({ cleared: true });
    });

    logger.debug("ready");
}

function start(callback: () => void) {
    callback();
}

function stop(callback: () => void) {
    callback();
}

module.exports = {
    initialize: initialize,
    router: router,
    start: start,
    stop: stop,
};
