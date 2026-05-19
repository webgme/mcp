"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const llmAdapter_1 = require("./llmAdapter");
const tools_1 = require("./tools");
const contextBlocks_1 = require("./contextBlocks");
const router = express_1.default.Router();
const SYSTEM_PROMPT_BASE = "You are GMEBot, an assistant embedded in a WebGME modeling environment. " +
    "Use the API tool-calling mechanism when a tool is available — each action must be a named tool invocation, not free-form JSON pretending to be a tool. " +
    "When referring to concepts or nodes, use Name (path), e.g. State (/3). " +
    "The client sends modelingMode (metamodel | domain), project/selection context, a MetaDescriptor snapshot, and an object-list (existing / new / deleted). " +
    "Do not ask to fetch the metamodel first — it is already in context. " +
    "In metamodel mode the only tool is patchMetaDescriptor: apply RFC 6902 JSON Patch to the MetaDescriptor (see docs/schemas/meta-descriptor.schema.json). " +
    "Prefer small, focused patches. For a new concept use {\"op\":\"add\",\"path\":\"/concepts/-\",\"value\":{\"name\":\"...\",\"extends\":\"FCO\",...}}. " +
    "Connection types belong in relationships (e.g. \"Transition: State -> State\") or concept pointers src/dst. " +
    "In domain mode tools are hidden for now — explain changes clearly from context. " +
    "If a tool returns an error, report it. In WebGME, FCO means First Class Object.";
const MAX_TOOL_ROUNDS = 5; // default; override with CBACK_MAX_TOOL_ROUNDS env
/** Default timeout for a single LLM request (ms). 0 = no timeout. Override with CBACK_LLM_REQUEST_TIMEOUT_MS. */
const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120000; // 2 minutes
/** Wrap a promise so it rejects after ms with message. Clears timer on settle. */
function withTimeout(promise, ms, message) {
    if (ms <= 0)
        return promise;
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(message)), ms);
        promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}
/** Keep only system + last N messages to avoid unbounded token growth (e.g. 7k+ on a simple request). */
const MAX_HISTORY_MESSAGES = 40;
/** Cap size of tool result content in history (chars) to limit tokens. */
const MAX_TOOL_RESULT_CHARS = 2500;
/** Build a stable fingerprint of tool_calls to detect repeated identical rounds (loop guard). */
function getToolCallsFingerprint(toolCalls) {
    if (!toolCalls || toolCalls.length === 0)
        return "";
    const parts = toolCalls.map((c) => {
        const name = (c.function && c.function.name) ? String(c.function.name) : "";
        const args = c.function && c.function.arguments;
        const argsStr = typeof args === "string" ? args : (args != null ? JSON.stringify(args) : "");
        return name + ":" + argsStr.slice(0, 400);
    });
    parts.sort();
    return parts.join(" | ");
}
/** Match only when "project" is explicitly mentioned — avoid matching "switch to the diagram" etc. */
const SWITCH_PROJECT_PATTERN = /\b(switch|open|go to|change to|load)\s+(?:to\s+)?project\b|(?:switch|open)\s+project\b|\bswitchProject\b/i;
const RECENT_MESSAGES_LOOKBACK = 20;
/** User message sent by the client when continuing after providing client-only data (e.g. diagram layout). */
const CONTINUATION_MESSAGE = "[Continuation: layout data provided.]";
/** Injected when continuation context contains layout so the LLM knows to call the layout tool. */
const CONTINUATION_LAYOUT_HINT = " Layout data is in context; call getDiagramLayout to read it and continue.";
function looksLikeSwitchProjectRequest(text) {
    return SWITCH_PROJECT_PATTERN.test(text);
}
function historyHasProjectList(history) {
    const start = Math.max(0, history.length - RECENT_MESSAGES_LOOKBACK);
    for (let i = start; i < history.length; i++) {
        const m = history[i];
        if (m.role !== "tool" || !m.content)
            continue;
        try {
            const data = JSON.parse(m.content);
            if (data && Array.isArray(data.projects))
                return true;
        }
        catch (_e) { /* ignore */ }
    }
    return false;
}
async function ensureProjectListInContext(history, listProjectsHandler, toolCtx) {
    var _a;
    const lastUser = history.filter(m => m.role === "user").pop();
    if (!lastUser || typeof lastUser.content !== "string")
        return;
    if (!looksLikeSwitchProjectRequest(lastUser.content))
        return;
    if (historyHasProjectList(history))
        return;
    const { data } = await listProjectsHandler({}, toolCtx);
    const MAX_INJECTED = 30;
    const projects = Array.isArray(data === null || data === void 0 ? void 0 : data.projects)
        ? data.projects
            .slice(0, MAX_INJECTED)
            .map((p) => ({ projectId: p.projectId, displayName: p.displayName || p.projectId }))
        : [];
    const payload = { projects, count: (_a = data === null || data === void 0 ? void 0 : data.count) !== null && _a !== void 0 ? _a : projects.length };
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
const sessions = new Map();
/** Logging: info = event + main context (e.g. tool name, node path); debug = full parameters/payloads. */
const TOOL_CONTEXT_KEYS = [
    "nodePath", "nodeId", "containerPath", "projectId", "path", "name", "conceptPath",
    "sourcePath", "targetPath", "message", "setId", "branchName", "activeNodeId", "container",
];
const MAX_CONTEXT_VAL = 80;
function toolArgsContext(args) {
    const parts = [];
    for (const k of TOOL_CONTEXT_KEYS) {
        const v = args[k];
        if (v === undefined || v === null)
            continue;
        const s = typeof v === "string" ? v : JSON.stringify(v);
        parts.push(k + "=" + (s.length > MAX_CONTEXT_VAL ? s.slice(0, MAX_CONTEXT_VAL) + "…" : s));
    }
    return parts.length ? parts.join(" ") : "";
}
/** Final /chat JSON body: status tells the client when empty reply is OK vs an error. */
function buildChatResponse(opts) {
    const reply = opts.content != null ? String(opts.content) : "";
    const trimmed = reply.trim();
    const hadTools = opts.toolActivity.length > 0;
    const hadCommands = !!(opts.commands && opts.commands.length > 0);
    const base = {};
    if (opts.commands && opts.commands.length > 0) {
        base.commands = opts.commands;
    }
    if (opts.usage) {
        base.usage = opts.usage;
    }
    if (hadTools) {
        base.toolActivity = opts.toolActivity;
    }
    if (trimmed) {
        return { status: "complete", reply, ...base };
    }
    if (hadTools || hadCommands) {
        return {
            status: "complete",
            reply: "",
            complete: true,
            ...base,
        };
    }
    return {
        status: "empty",
        reply: "The model returned no text. Try rephrasing your request or check the server log.",
        ...base,
    };
}
function logChatRequest(log, userId, context, messageLen) {
    const ctx = context && typeof context === "object" ? context : {};
    const parts = ["userId=" + userId, "messageLen=" + messageLen];
    if (ctx.projectId)
        parts.push("projectId=" + ctx.projectId);
    if (ctx.activeNodeId)
        parts.push("activeNodeId=" + ctx.activeNodeId);
    if (ctx.modelingMode === "metamodel" || ctx.modelingMode === "domain") {
        parts.push("modelingMode=" + ctx.modelingMode);
    }
    log.info("chat_request " + parts.join(" "));
}
function logChatRequestDebug(log, body) {
    log.debug("chat_request payload: " + JSON.stringify(body));
}
function logLlmRequest(log, round) {
    log.info("llm_request round=" + round);
}
function logLlmRequestDebug(log, round, historyLength) {
    log.debug("llm_request round=" + round + " historyMessages=" + historyLength);
}
function logLlmResponse(log, round, msg) {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        const names = msg.tool_calls.map((c) => { var _a; return ((_a = c.function) === null || _a === void 0 ? void 0 : _a.name) || "?"; }).join(",");
        log.info("llm_response round=" + round + " tool_calls=" + msg.tool_calls.length + " " + names);
    }
    else {
        const len = typeof msg.content === "string" ? msg.content.length : 0;
        log.info("llm_response round=" + round + " contentLen=" + len);
    }
}
function logLlmResponseDebug(log, round, msg) {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        const summary = msg.tool_calls.map((c) => {
            var _a, _b;
            return ({
                name: (_a = c.function) === null || _a === void 0 ? void 0 : _a.name,
                args: ((_b = c.function) === null || _b === void 0 ? void 0 : _b.arguments) != null ? String(c.function.arguments).slice(0, 200) : "",
            });
        });
        log.debug("llm_response round=" + round + " tool_calls: " + JSON.stringify(summary));
    }
    else {
        log.debug("llm_response round=" + round + " content: " + (msg.content || "").slice(0, 500));
    }
}
function logToolCall(log, name, args) {
    log.info("tool_call " + name + " " + toolArgsContext(args));
}
function logToolCallDebug(log, name, args, ctx) {
    log.debug("tool_call " + name + " args=" + JSON.stringify(args) + " hasCoreSession=" + !!ctx.coreSession +
        " context=" + JSON.stringify(ctx.context));
}
function logToolResponse(log, name, result, err) {
    var _a, _b;
    if (err) {
        log.info("tool_response " + name + " error " + (err.message || String(err)).slice(0, 120));
        return;
    }
    const error = result && result.error;
    if (error) {
        log.info("tool_response " + name + " error " + String(error).slice(0, 120));
        return;
    }
    const path = result && ((_b = (_a = result.path) !== null && _a !== void 0 ? _a : result.nodePath) !== null && _b !== void 0 ? _b : result.createdPath);
    const extra = path != null ? " path=" + String(path).slice(0, MAX_CONTEXT_VAL) : "";
    log.info("tool_response " + name + " ok" + extra);
}
function logToolResponseDebug(log, name, result) {
    const str = JSON.stringify(result);
    log.debug("tool_response " + name + " " + (str.length > 2000 ? str.slice(0, 2000) + "…" : str));
}
function getSession(userId) {
    if (!sessions.has(userId)) {
        sessions.set(userId, [{ role: "system", content: SYSTEM_PROMPT_BASE }]);
    }
    return sessions.get(userId);
}
function refreshSystemMessage(history, toolCtx) {
    const payload = (0, contextBlocks_1.buildSessionContextPayload)(toolCtx);
    const blocks = (0, contextBlocks_1.formatContextBlocksForSystem)(payload);
    const content = blocks ? SYSTEM_PROMPT_BASE + "\n\n" + blocks : SYSTEM_PROMPT_BASE;
    if (history.length > 0 && history[0].role === "system") {
        history[0].content = content;
    }
    else {
        history.unshift({ role: "system", content });
    }
}
/** Trim history to system + last N messages to limit token usage. */
function trimHistory(history, maxMessages) {
    if (history.length <= maxMessages)
        return;
    const systemMsg = history[0].role === "system" ? history[0] : null;
    const rest = history.filter((m) => m.role !== "system");
    const keep = rest.slice(-(maxMessages - (systemMsg ? 1 : 0)));
    history.length = 0;
    if (systemMsg)
        history.push(systemMsg);
    history.push(...keep);
}
/**
 * Create a Core session from storage (open project, load root).
 * Only the backend/router should call this; tools must not import webgme/core.
 * Uses middleware's safeStorage and gmeConfig.
 */
async function createCoreSession(safeStorage, gmeConfig, userId, projectId, branchName, log) {
    if (!safeStorage || !gmeConfig)
        return null;
    let CoreClass;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const webgme = require("webgme");
        CoreClass = webgme.requirejs("common/core/coreQ");
    }
    catch (e) {
        log.warn("createCoreSession: could not load Core: " + (e && e.message));
        return null;
    }
    let project;
    try {
        project = await safeStorage.openProject({ username: userId, projectId });
    }
    catch (e) {
        log.warn("createCoreSession openProject failed: " + (e && e.message));
        return null;
    }
    const branch = branchName || "master";
    let commitObject;
    try {
        commitObject = await project.getCommitObject(branch);
    }
    catch (e) {
        log.warn("createCoreSession getCommitObject failed: " + (e && e.message));
        return null;
    }
    const core = new CoreClass(project, {
        globConf: gmeConfig,
        logger: log.fork("core"),
    });
    let root;
    try {
        root = await core.loadRoot(commitObject.root);
    }
    catch (e) {
        log.warn("createCoreSession loadRoot failed: " + (e && e.message));
        return null;
    }
    return { core, root, project, commitObject, branchName: branch };
}
function initialize(middlewareOpts) {
    const logger = middlewareOpts.logger.fork("cback");
    const ensureAuthenticated = middlewareOpts.ensureAuthenticated;
    const getUserId = middlewareOpts.getUserId;
    const { config: llmAdapterConfig, usedFallbackFromAnthropic } = (0, llmAdapter_1.resolveLlmFromEnv)();
    const maxToolRounds = (() => {
        const raw = process.env.CBACK_MAX_TOOL_ROUNDS;
        if (raw === undefined || raw === "")
            return MAX_TOOL_ROUNDS;
        const n = parseInt(raw, 10);
        return Number.isInteger(n) && n >= 1 && n <= 50 ? n : MAX_TOOL_ROUNDS;
    })();
    const llmRequestTimeoutMs = (() => {
        const raw = process.env.CBACK_LLM_REQUEST_TIMEOUT_MS;
        if (raw === undefined || raw === "")
            return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
        const n = parseInt(raw, 10);
        return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    })();
    if (usedFallbackFromAnthropic) {
        logger.warn("LLM_BACKEND=anthropic but LLM_API_KEY not set; using openai backend at default local base URL");
    }
    if (llmAdapterConfig.backend === "anthropic") {
        logger.info("cback LLM: anthropic (model=" + llmAdapterConfig.model + ", apiBase=" + llmAdapterConfig.baseOrigin + ")");
    }
    else {
        logger.info("cback LLM: openai-compatible (baseUrl=" + llmAdapterConfig.baseUrl + ", model=" + llmAdapterConfig.model + ")");
    }
    /** Tool definitions for GET /config (no request context at init). Chat uses per-request toolDefs from context. */
    const defaultToolDefs = (0, tools_1.getToolDefinitionsForLLM)(middlewareOpts.gmeConfig, undefined);
    const toolMap = (0, tools_1.getToolMap)(middlewareOpts.gmeConfig);
    logger.debug("initializing ...");
    router.use("*", function (_req, res, next) {
        res.setHeader("X-WebGME-Media-Type", "webgme.v1");
        next();
    });
    router.use("*", ensureAuthenticated);
    router.get("/test", function (req, res) {
        const userId = getUserId(req);
        res.json({ ok: true, router: "cback", userId });
    });
    router.get("/config", function (_req, res) {
        const llm = llmAdapterConfig.backend === "anthropic"
            ? {
                backend: "anthropic",
                model: llmAdapterConfig.model,
                apiBase: llmAdapterConfig.baseOrigin,
            }
            : {
                backend: "openai",
                model: llmAdapterConfig.model,
                baseUrl: llmAdapterConfig.baseUrl,
                ...(usedFallbackFromAnthropic ? { fallbackFromAnthropic: true } : {}),
            };
        res.json({ llm, tools: defaultToolDefs });
    });
    router.post("/chat", express_1.default.json(), async function (req, res) {
        var _a, _b, _c;
        const userId = getUserId(req);
        const userMessage = (_a = req.body) === null || _a === void 0 ? void 0 : _a.message;
        /** Context is provided by the client only (active node, project, branch). Server never gathers or stores it. */
        const context = (_b = req.body) === null || _b === void 0 ? void 0 : _b.context;
        logChatRequest(logger, userId, context, typeof userMessage === "string" ? userMessage.length : 0);
        logChatRequestDebug(logger, { message: userMessage, context });
        if (!userMessage || typeof userMessage !== "string") {
            res.status(400).json({ error: "Missing 'message' in request body" });
            return;
        }
        const isContinuation = ((_c = req.body) === null || _c === void 0 ? void 0 : _c.continuation) === true;
        const history = getSession(userId);
        const toolCtxEarly = {
            userId,
            logger: logger.fork("tools"),
            gmeConfig: middlewareOpts.gmeConfig,
            safeStorage: middlewareOpts.safeStorage,
            gmeAuth: middlewareOpts.gmeAuth,
            context: context && typeof context === "object" ? context : undefined,
        };
        if (context && typeof context === "object" && context.projectId) {
            const sessionEarly = await createCoreSession(middlewareOpts.safeStorage, middlewareOpts.gmeConfig, userId, context.projectId, context.branchName || "master", logger);
            if (sessionEarly) {
                toolCtxEarly.coreSession = sessionEarly;
            }
        }
        refreshSystemMessage(history, toolCtxEarly);
        const turnCtx = (0, contextBlocks_1.formatTurnContextLine)(toolCtxEarly);
        const mode = (0, tools_1.resolveModelingMode)(toolCtxEarly.context);
        const userContent = turnCtx
            ? userMessage + "\n[Turn context: " + turnCtx + ", modelingMode=" + mode + "]"
            : userMessage + "\n[Turn context: modelingMode=" + mode + "]";
        if (!isContinuation) {
            history.push({ role: "user", content: userContent });
        }
        else {
            history.push({ role: "user", content: userMessage });
        }
        if (isContinuation && context && typeof context === "object" && context.diagramLayout) {
            const last = history[history.length - 1];
            if (last && last.role === "user" && typeof last.content === "string") {
                last.content = last.content + CONTINUATION_LAYOUT_HINT;
            }
        }
        const toolCtx = toolCtxEarly;
        /** Tool definitions for this request: metamodel → patchMetaDescriptor only; domain → none. */
        const toolDefs = (0, tools_1.getToolDefinitionsForLLM)(middlewareOpts.gmeConfig, toolCtx.context);
        try {
            trimHistory(history, MAX_HISTORY_MESSAGES);
            let rounds = 0;
            let lastRoundFingerprint = null;
            const commands = [];
            const toolActivity = [];
            while (rounds < maxToolRounds) {
                rounds++;
                logLlmRequest(logger, rounds);
                logLlmRequestDebug(logger, rounds, history.length);
                const completionPromise = (0, llmAdapter_1.chatCompletion)(history, toolDefs, llmAdapterConfig);
                const timeoutMessage = "LLM request timed out after " + (llmRequestTimeoutMs / 1000) + "s.";
                const result = await withTimeout(completionPromise, llmRequestTimeoutMs, timeoutMessage);
                const msg = result.message;
                if (result.finishReason === "tool_calls" && (!msg.tool_calls || msg.tool_calls.length === 0)) {
                    logger.warn("chat LLM finish_reason=tool_calls but message.tool_calls is missing; " +
                        "vLLM did not expose structured tool calls — check --tool-call-parser and, for reasoning models, --reasoning-parser.");
                }
                if ((!msg.tool_calls || msg.tool_calls.length === 0) &&
                    typeof msg.content === "string" &&
                    msg.content.indexOf("<tool_call") !== -1) {
                    logger.warn("chat assistant text contains <tool_call> but no API tool_calls; tools will not run until the " +
                        "inference server parses tool output into message.tool_calls (see vLLM tool calling docs).");
                }
                if (result.usage) {
                    logger.info("llm_usage round=" + rounds + " prompt_tokens=" + result.usage.prompt_tokens +
                        " completion_tokens=" + result.usage.completion_tokens +
                        (result.usage.total_tokens != null ? " total=" + result.usage.total_tokens : ""));
                }
                history.push(msg);
                if (!msg.tool_calls || msg.tool_calls.length === 0) {
                    logLlmResponse(logger, rounds, msg);
                    logLlmResponseDebug(logger, rounds, msg);
                    res.json(buildChatResponse({
                        content: msg.content,
                        toolActivity,
                        commands,
                        usage: result.usage,
                    }));
                    return;
                }
                const roundFingerprint = getToolCallsFingerprint(msg.tool_calls);
                if (roundFingerprint && roundFingerprint === lastRoundFingerprint) {
                    history.pop();
                    logger.warn("chat loop_guard userId=" + userId + " round=" + rounds + " repeated tool calls");
                    res.json({
                        status: "error",
                        reply: "Stopped: the same tool calls were repeated without progress. Please try rephrasing your request or a different approach.",
                        loopGuard: true,
                        ...(toolActivity.length > 0 ? { toolActivity } : {}),
                    });
                    return;
                }
                lastRoundFingerprint = roundFingerprint;
                const toolResultsThisRound = [];
                let needClientDataKey = null;
                for (const call of msg.tool_calls) {
                    const rawArgs = call.function.arguments;
                    let args = {};
                    if (typeof rawArgs === "string") {
                        try {
                            args = JSON.parse(rawArgs);
                        }
                        catch (parseErr) {
                            logger.warn("tool_call " + call.function.name + " invalid JSON: " + parseErr.message);
                            logger.debug("tool_call " + call.function.name + " raw args: " + String(rawArgs).slice(0, 200));
                            args = {};
                        }
                    }
                    else if (rawArgs && typeof rawArgs === "object") {
                        args = rawArgs;
                    }
                    logToolCall(logger, call.function.name, args);
                    logToolCallDebug(logger, call.function.name, args, toolCtx);
                    const argsSummary = toolArgsContext(args);
                    toolActivity.push({
                        name: call.function.name,
                        ...(argsSummary ? { argsSummary } : {}),
                    });
                    const handler = toolMap.get(call.function.name);
                    let toolResult;
                    if (!(0, tools_1.isToolEnabled)(call.function.name, toolCtx.context)) {
                        const mode = (0, tools_1.resolveModelingMode)(toolCtx.context);
                        toolResult = {
                            error: "Tool '" +
                                call.function.name +
                                "' is not available in " +
                                mode +
                                " mode. Use patchMetaDescriptor in metamodel mode.",
                        };
                        logToolResponse(logger, call.function.name, toolResult);
                    }
                    else if (handler) {
                        try {
                            const handlerResult = await handler(args, toolCtx);
                            toolResult = handlerResult.data;
                            if (handlerResult.commands) {
                                commands.push(...handlerResult.commands);
                            }
                            if (toolResult && typeof toolResult.needClientData === "string" &&
                                toolResult.needClientData === tools_1.NEED_CLIENT_DATA_KEYS.diagramLayout) {
                                needClientDataKey = toolResult.needClientData;
                            }
                            logToolResponse(logger, call.function.name, toolResult);
                            logToolResponseDebug(logger, call.function.name, toolResult);
                        }
                        catch (err) {
                            logToolResponse(logger, call.function.name, {}, err);
                            logger.debug("tool_response " + call.function.name + " error stack: " + (err.stack || ""));
                            toolResult = { error: err.message };
                        }
                    }
                    else {
                        logger.warn("tool_call " + call.function.name + " unknown tool");
                        logToolResponse(logger, call.function.name, { error: "Unknown tool" });
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
                        status: "continuation",
                        reply: "",
                        continuation: true,
                        requestClientData: { key: needClientDataKey },
                        ...(toolActivity.length > 0 ? { toolActivity } : {}),
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
            logger.warn("chat max_rounds userId=" + userId + " rounds=" + maxToolRounds);
            res.json({
                status: "error",
                reply: "Reached maximum tool call rounds without a final answer.",
                ...(toolActivity.length > 0 ? { toolActivity } : {}),
            });
        }
        catch (err) {
            logger.error("chat_error userId=" + userId + " " + err.message);
            logger.debug("chat_error stack: " + (err.stack || ""));
            const isTimeout = err && err.message && String(err.message).indexOf("timed out") !== -1;
            if (isTimeout) {
                res.status(504).json({
                    error: "The model took too long to respond.",
                    reply: "The model took too long to respond. Please try again or use a smaller request.",
                });
                return;
            }
            res.status(502).json({ error: err.message });
        }
    });
    router.delete("/session", function (req, res) {
        const userId = getUserId(req);
        sessions.delete(userId);
        res.json({ cleared: true });
    });
    // Test-only: run a single tool with given args and context (for prompt/model assertions).
    if (process.env.NODE_ENV === "test") {
        router.post("/test/run-tool", express_1.default.json(), async function (req, res) {
            const userId = getUserId(req);
            const { toolName, args = {}, context } = req.body || {};
            if (!toolName || typeof toolName !== "string") {
                res.status(400).json({ error: "Missing or invalid toolName" });
                return;
            }
            const toolMap = (0, tools_1.getToolMap)(middlewareOpts.gmeConfig);
            const handler = toolMap.get(toolName);
            if (!handler) {
                res.status(400).json({ error: "Unknown tool: " + toolName });
                return;
            }
            const toolCtx = {
                userId,
                logger: logger.fork("test-run-tool"),
                gmeConfig: middlewareOpts.gmeConfig,
                safeStorage: middlewareOpts.safeStorage,
                gmeAuth: middlewareOpts.gmeAuth,
                context: context && typeof context === "object" ? context : undefined,
            };
            if (context && typeof context === "object" && context.projectId) {
                const session = await createCoreSession(middlewareOpts.safeStorage, middlewareOpts.gmeConfig, userId, context.projectId, context.branchName || "master", logger);
                if (session)
                    toolCtx.coreSession = session;
            }
            try {
                const result = await handler(args, toolCtx);
                res.json({ data: result.data, commands: result.commands });
            }
            catch (err) {
                logger.warn("test run_tool error tool=" + toolName + " " + (err && err.message));
                logger.debug("test run_tool args: " + JSON.stringify(args));
                res.status(500).json({ error: (err && err.message) || String(err) });
            }
        });
    }
    logger.debug("ready");
}
function start(callback) {
    callback();
}
function stop(callback) {
    callback();
}
module.exports = {
    initialize: initialize,
    router: router,
    start: start,
    stop: stop,
};
