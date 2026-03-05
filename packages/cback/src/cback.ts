import express, { Request, Response, NextFunction } from "express";
import { chatCompletion as ollamaChatCompletion, ChatMessage, OllamaConfig, DEFAULT_CONFIG } from "./ollama";
import { chatCompletion as anthropicChatCompletion, DEFAULT_ANTHROPIC_MODEL } from "./anthropic";
import { chatCompletion as openaiChatCompletion, DEFAULT_GROQ_MODEL, DEFAULT_OPENAI_MODEL, GROQ_BASE_URL, OPENAI_BASE_URL } from "./openai";
import { getToolDefinitionsForLLM, getToolMap, ToolContext, ClientCommand, ToolHandler, NEED_CLIENT_DATA_KEYS } from "./tools";

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
    "A single user message often asks for multiple things (e.g. 'create concept X and add a pointer to Y', or 'new concept with three pointers'). You MUST fulfill every part of the request: use as many tool calls as needed, or use createMetaNode with its optional 'contains', 'pointers', and 'sets' arrays to do concept + relations in one call. Do not stop after one tool call and reply until all requested actions are done. For connection, link, or edge concepts use exactly pointer names 'src' and 'dst' (not source/destination/from/to). Example: pointers: [{ pointerName: 'src', targetPath: 'X' }, { pointerName: 'dst', targetPath: 'Y' }]. " +
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
    "Always get the path from a tool first: for 'switch to FCO' or 'go to FCO context', call findNodesByName with name 'FCO', then setClientState with one of the returned nodePaths as activeNodeId. For other nodes by name, call findNodesByName first. For root use '/'. Do not guess paths — use only paths from tool responses. " +
    "For META containment (setMetaContainment): each call defines exactly one containment edge (one source concept, one target concept). The source must be the concept that is the container in the user's description (e.g. for 'SM contains S and T', source is SM, not FCO). Do not use FCO as source unless the user explicitly says FCO is the container; FCO is the root base type. If one container concept should contain multiple types, call setMetaContainment separately for each pair: e.g. (sourcePath=/SM, targetPath=/S) then (sourcePath=/SM, targetPath=/T). When the user says 'any' cardinality or does not specify cardinality, do not send min or max—omit both parameters. For pointers use setMetaPointer (cardinality 0..1 is fixed; no min/max arguments). For sets (multiple targets) use setMetaSet; for mixins use setMetaMixin. For all META relationship tools, path parameters accept either absolute paths (e.g. /FCO, /MyConcept) or concept names: when the user refers to concepts by name (no leading slash), pass the name as-is—the backend resolves names to paths. " +
    "When the user asks to create a 'concept', 'meta concept', 'type', 'metamodel element', or 'new type' (a new META type, not an instance in the model), use createMetaNode, not createNode. createNode creates instance nodes in the model; createMetaNode defines new concepts in the metamodel. For a concept that should contain other types (e.g. 'Folder that can contain FCO'), or have pointers or sets, use createMetaNode with the optional 'contains', 'pointers', and 'sets' arrays so creation and all relations are done in one call. For createMetaNode basePath: pass the base concept's **name** (e.g. FCO) or omit to use FCO. Do NOT pass /FCO as a path—in WebGME the path of the FCO concept is project-specific (e.g. /1). The backend accepts either a concept name or a path from getMetaInfo (concepts[].path); it resolves names to the correct path. For connection, link, or edge concepts (that connect two nodes), WebGME expects two pointers named 'src' (source) and 'dst' (destination). When the user asks for such a concept, create it with pointers named exactly 'src' and 'dst' (each with the appropriate target concept). Never use other names like 'source', 'destination', 'from', 'to' for connection pointers.";

const MAX_TOOL_ROUNDS = 5; // default; override with CBACK_MAX_TOOL_ROUNDS env

/** Keep only system + last N messages to avoid unbounded token growth (e.g. 7k+ on a simple request). */
const MAX_HISTORY_MESSAGES = 40;
/** Cap size of tool result content in history (chars) to limit tokens. */
const MAX_TOOL_RESULT_CHARS = 2500;

/** Match only when "project" is explicitly mentioned — avoid matching "switch to the diagram" etc. */
const SWITCH_PROJECT_PATTERN = /\b(switch|open|go to|change to|load)\s+(?:to\s+)?project\b|(?:switch|open)\s+project\b|\bswitchProject\b/i;

const RECENT_MESSAGES_LOOKBACK = 20;

/** User message sent by the client when continuing after providing client-only data (e.g. diagram layout). */
const CONTINUATION_MESSAGE = "[Continuation: layout data provided.]";
/** Injected when continuation context contains layout so the LLM knows to call the layout tool. */
const CONTINUATION_LAYOUT_HINT = " Layout data is in context; call getDiagramLayout to read it and continue.";

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

/** Trim history to system + last N messages to limit token usage. */
function trimHistory(history: ChatMessage[], maxMessages: number): void {
    if (history.length <= maxMessages) return;
    const systemMsg = history[0].role === "system" ? history[0] : null;
    const rest = history.filter((m) => m.role !== "system");
    const keep = rest.slice(-(maxMessages - (systemMsg ? 1 : 0)));
    history.length = 0;
    if (systemMsg) history.push(systemMsg);
    history.push(...keep);
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
    const llmProvider = (process.env.LLM_PROVIDER || "ollama").toLowerCase();
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const anthropicModel = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
    const groqApiKey = process.env.GROQ_API_KEY;
    const groqModel = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
    const openaiApiKey = process.env.OPENAI_API_KEY;
    const openaiModel = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;

    const maxToolRounds = (() => {
        const raw = process.env.CBACK_MAX_TOOL_ROUNDS;
        if (raw === undefined || raw === "") return MAX_TOOL_ROUNDS;
        const n = parseInt(raw, 10);
        return Number.isInteger(n) && n >= 1 && n <= 50 ? n : MAX_TOOL_ROUNDS;
    })();

    const useAnthropic = llmProvider === "anthropic" && !!anthropicApiKey;
    const useGroq = llmProvider === "groq" && !!groqApiKey;
    const useOpenAI = llmProvider === "openai" && !!openaiApiKey;

    if (useAnthropic) {
        logger.info("cback LLM: anthropic (model=" + anthropicModel + ")");
    } else if (useGroq) {
        logger.info("cback LLM: groq (model=" + groqModel + ")");
    } else if (useOpenAI) {
        logger.info("cback LLM: openai (model=" + openaiModel + ")");
    } else {
        if (llmProvider === "anthropic" && !anthropicApiKey) {
            logger.warn("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY not set; falling back to ollama");
        } else if (llmProvider === "groq" && !groqApiKey) {
            logger.warn("LLM_PROVIDER=groq but GROQ_API_KEY not set; falling back to ollama");
        } else if (llmProvider === "openai" && !openaiApiKey) {
            logger.warn("LLM_PROVIDER=openai but OPENAI_API_KEY not set; falling back to ollama");
        }
        logger.info("cback LLM: ollama (host=" + ollamaConfig.host + ":" + ollamaConfig.port + ", model=" + ollamaConfig.model + ")");
    }

    /** Tool definitions for GET /config (no request context at init). Chat uses per-request toolDefs from context. */
    const defaultToolDefs = getToolDefinitionsForLLM(middlewareOpts.gmeConfig, undefined);
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
        let llm: Record<string, unknown>;
        if (useAnthropic) {
            llm = { provider: "anthropic", model: anthropicModel };
        } else if (useGroq) {
            llm = { provider: "groq", model: groqModel };
        } else if (useOpenAI) {
            llm = { provider: "openai", model: openaiModel };
        } else {
            llm = { provider: "ollama", host: ollamaConfig.host, port: ollamaConfig.port, model: ollamaConfig.model };
        }
        res.json({ llm, tools: defaultToolDefs });
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

        const isContinuation = req.body?.continuation === true;

        const history = getSession(userId);
        const ctxParts: string[] = [];
        if (context && typeof context === "object") {
            if (context.projectId) ctxParts.push("projectId=" + context.projectId);
            if (context.branchName) ctxParts.push("branchName=" + context.branchName);
            if (context.activeNodeId) ctxParts.push("activeNodeId=" + context.activeNodeId);
            if (context.activeVisualizerId) ctxParts.push("activeVisualizerId=" + context.activeVisualizerId);
            if (typeof context.activeTabId === "number") ctxParts.push("activeTabId=" + context.activeTabId);
        }
        const userContent =
            ctxParts.length > 0
                ? userMessage + "\n[Current context: " + ctxParts.join(", ") + ". Use these when the user does not specify otherwise.]"
                : userMessage;
        if (!isContinuation) {
            history.push({ role: "user", content: userContent });
        } else {
            history.push({ role: "user", content: userMessage });
        }
        if (isContinuation && context && typeof context === "object" && context.diagramLayout) {
            const last = history[history.length - 1];
            if (last && last.role === "user" && typeof last.content === "string") {
                last.content = last.content + CONTINUATION_LAYOUT_HINT;
            }
        }

        const toolCtx: ToolContext = {
            userId,
            logger: logger.fork("tools"),
            gmeConfig: middlewareOpts.gmeConfig,
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

        /** Tool definitions for this request: filtered by activeVisualizerId etc. */
        const toolDefs = getToolDefinitionsForLLM(middlewareOpts.gmeConfig, toolCtx.context);

        try {
            const listProjectsHandler = toolMap.get("listProjects");
            if (listProjectsHandler) {
                await ensureProjectListInContext(history, listProjectsHandler, toolCtx);
            }

            trimHistory(history, MAX_HISTORY_MESSAGES);

            let rounds = 0;
            const commands: ClientCommand[] = [];

            logger.debug("chat request from " + userId + ": " + userMessage);

            while (rounds < maxToolRounds) {
                rounds++;

                logger.debug("llm round " + rounds);
                const result = useAnthropic
                    ? await anthropicChatCompletion(history, toolDefs, { apiKey: anthropicApiKey!, model: anthropicModel })
                    : useGroq
                        ? await openaiChatCompletion(history, toolDefs, { apiKey: groqApiKey!, model: groqModel, baseUrl: GROQ_BASE_URL })
                        : useOpenAI
                            ? await openaiChatCompletion(history, toolDefs, { apiKey: openaiApiKey!, model: openaiModel, baseUrl: OPENAI_BASE_URL })
                            : await ollamaChatCompletion(history, toolDefs, ollamaConfig);
                const msg = result.message;

                if (result.usage) {
                    logger.info(
                        "cback tokens round " + rounds + ": prompt=" + result.usage.prompt_tokens +
                        " completion=" + result.usage.completion_tokens +
                        (result.usage.total_tokens != null ? " total=" + result.usage.total_tokens : "")
                    );
                }

                history.push(msg);

                if (!msg.tool_calls || msg.tool_calls.length === 0) {
                    logger.debug("reply: " + (msg.content || "").substring(0, 120));
                    const response: any = { reply: msg.content };
                    if (commands.length > 0) {
                        response.commands = commands;
                    }
                    if (result.usage) {
                        response.usage = result.usage;
                    }
                    res.json(response);
                    return;
                }

                const toolResultsThisRound: { content: string; tool_call_id: string }[] = [];
                let needClientDataKey: string | null = null;

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
                            if (toolResult && typeof toolResult.needClientData === "string" &&
                                toolResult.needClientData === NEED_CLIENT_DATA_KEYS.diagramLayout) {
                                needClientDataKey = toolResult.needClientData;
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

                    const contentStr = (() => {
                        const raw = JSON.stringify(toolResult);
                        return raw.length <= MAX_TOOL_RESULT_CHARS ? raw : raw.substring(0, MAX_TOOL_RESULT_CHARS) + " [truncated]";
                    })();
                    toolResultsThisRound.push({ content: contentStr, tool_call_id: call.id });
                }

                if (needClientDataKey) {
                    history.pop();
                    res.json({
                        reply: "",
                        continuation: true,
                        requestClientData: { key: needClientDataKey },
                    });
                    return;
                }

                for (const tr of toolResultsThisRound) {
                    history.push({
                        role: "tool",
                        content: tr.content,
                        tool_call_id: tr.tool_call_id,
                    });
                }
            }

            logger.warn("max tool rounds (" + maxToolRounds + ") reached for " + userId);
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

    // Test-only: run a single tool with given args and context (for prompt/model assertions).
    if (process.env.NODE_ENV === "test") {
        router.post("/test/run-tool", express.json(), async function (req: Request, res: Response) {
            const userId = getUserId(req);
            const { toolName, args = {}, context } = req.body || {};
            if (!toolName || typeof toolName !== "string") {
                res.status(400).json({ error: "Missing or invalid toolName" });
                return;
            }
            const toolMap = getToolMap(middlewareOpts.gmeConfig);
            const handler = toolMap.get(toolName);
            if (!handler) {
                res.status(400).json({ error: "Unknown tool: " + toolName });
                return;
            }
            const toolCtx: ToolContext = {
                userId,
                logger: logger.fork("test-run-tool"),
                gmeConfig: middlewareOpts.gmeConfig,
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
                if (session) toolCtx.coreSession = session;
            }
            try {
                const result = await handler(args, toolCtx);
                res.json({ data: result.data, commands: result.commands });
            } catch (err: any) {
                logger.warn("test/run-tool error: " + (err && err.message));
                res.status(500).json({ error: (err && err.message) || String(err) });
            }
        });
    }

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
