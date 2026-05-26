import express, { Request, Response, NextFunction } from "express";
import { chatCompletion, ChatMessage, resolveLlmFromEnv } from "./llmAdapter";
import {
    getToolDefinitionsForLLM,
    getToolMap,
    ToolContext,
    ClientCommand,
    ToolHandler,
    NEED_CLIENT_DATA_KEYS,
    isToolEnabled,
    resolveModelingMode,
} from "./toolRegistry";
import {
    buildSessionContextPayload,
    formatContextBlocksForSystem,
    formatTurnContextLine,
} from "./contextBlocks";

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

const SYSTEM_PROMPT_BASE =
    "You are GMEBot, an assistant embedded in a WebGME modeling environment. " +
    "Use the API tool-calling mechanism when a tool is available — each action must be a named tool invocation, not free-form JSON pretending to be a tool. " +
    "In metamodel mode, concepts are identified by **name** only — never use paths, guids, or node ids in patches or when referring to META types. " +
    "The client sends modelingMode, a MetaDescriptor snapshot, and a concept registry (existing / new / deleted names). " +
    "Do not ask to fetch the metamodel first — it is already in context. " +
    "In metamodel mode the only tool is patchMetaDescriptor: apply RFC 6902 JSON Patch to the MetaDescriptor (see docs/schemas/meta-descriptor.schema.json). " +
    "Use **exactly one** patchMetaDescriptor call per user turn: put every op in that call's `patch` array (order matters). Do not split one edit across several tool calls — one call keeps undo/redo and commits clean. " +
    "MetaDescriptor uses **objects keyed by name**, not arrays. Paths must start with /concepts/ or /relationships/ — never /StateMachine/contains/State (wrong). " +
    "Example finite-state machine (one patch, one commit): add concepts State, Transition, StateMachine; StateMachine value must include contains listing State and Transition; add relationships.Transition from State to State. " +
    "Never put cardinality in concept names (wrong: concepts.State:*; right: /concepts/StateMachine/contains/State = \"*\" or contains map on the StateMachine concept body). " +
    "Never add attributes.name — the name attribute is inherited from FCO. " +
    "Metamodel structure: (1) **main container** named for the domain (StateMachine, not Diagram) — contains must list **both** node types and **connection** types (Transition, etc.) so they can be instantiated; " +
    "(2) each link type as concepts.{Name} = {} (empty = FCO) plus relationships.{Name} = { from, to }; " +
    "(3) other node concepts as needed. Never use Diagram, ConnectionName, or Connector as concept names. " +
    "Prefer one patch with all concepts, main container contains, and relationships. After patchMetaDescriptor returns ok, reply to the user — do not call the tool again in the same turn. " +
    "Omit extends when a concept extends FCO (use \"FCO\" only in contains/pointers/relationship ends when needed). " +
    "**User-facing replies (metamodel):** After patchMetaDescriptor, summarize what the user can now model — type names, what goes inside the main container, how links work — in everyday modeling language. " +
    "Do not walk the user through MetaDescriptor, JSON Patch, contains maps, relationships blocks, FCO, cardinality, or tool results unless they ask for technical detail. " +
    "Never assume the user knows the descriptor format; the format is your edit surface only. " +
    "In domain mode tools are hidden for now — explain changes clearly from context. " +
    "If a tool returns an error, describe the problem in plain language; use technical detail only when helpful.";

const MAX_TOOL_ROUNDS = 5; // default; override with CBACK_MAX_TOOL_ROUNDS env

/** Default timeout for a single LLM request (ms). 0 = no timeout. Override with CBACK_LLM_REQUEST_TIMEOUT_MS. */
const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120000; // 2 minutes

/** Wrap a promise so it rejects after ms with message. Clears timer on settle. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    if (ms <= 0) return promise;
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); }
        );
    });
}

/** Keep only system + last N messages to avoid unbounded token growth (e.g. 7k+ on a simple request). */
const MAX_HISTORY_MESSAGES = 40;
/** Cap size of tool result content in history (chars) to limit tokens. */
const MAX_TOOL_RESULT_CHARS = 2500;

/** Stable fingerprint of an LLM tool-call round (order preserved — do not sort). */
function getToolCallsFingerprint(toolCalls: any[]): string {
    if (!toolCalls || toolCalls.length === 0) return "";
    return toolCalls
        .map((c: any) => {
            const name = c.function && c.function.name ? String(c.function.name) : "";
            const args = c.function && c.function.arguments;
            const argsStr = typeof args === "string" ? args : args != null ? JSON.stringify(args) : "";
            return name + ":" + argsStr.slice(0, 400);
        })
        .join(" | ");
}

/** Compact tool message for chat history (full meta descriptor lives in refreshed system context). */
function toolResultContentForHistory(toolName: string, toolResult: any): string {
    if (toolName === "patchMetaDescriptor") {
        if (toolResult && (toolResult.error || toolResult.ok === false)) {
            return JSON.stringify({ ok: false, error: toolResult.error || "patch failed" });
        }
        const out: { ok: boolean; warnings?: string[]; applied?: string[] } = { ok: true };
        if (Array.isArray(toolResult?.applied) && toolResult.applied.length) {
            out.applied = toolResult.applied;
        }
        if (Array.isArray(toolResult?.warnings) && toolResult.warnings.length) {
            out.warnings = toolResult.warnings;
        }
        return JSON.stringify(out);
    }
    const raw = JSON.stringify(toolResult);
    return raw.length <= MAX_TOOL_RESULT_CHARS
        ? raw
        : raw.substring(0, MAX_TOOL_RESULT_CHARS) + " [truncated]";
}

/** Metamodel: patch applied without hard failure (warnings are ok). */
function metamodelPatchSucceededInRound(toolResults: { content: string }[]): boolean {
    for (const tr of toolResults) {
        try {
            const data = JSON.parse(tr.content);
            if (data && data.ok === true) return true;
        } catch {
            /* ignore */
        }
    }
    return false;
}

function toolRoundMadeProgress(toolResults: { content: string }[]): boolean {
    for (const tr of toolResults) {
        try {
            const data = JSON.parse(tr.content);
            if (data && data.ok === true) {
                return true;
            }
        } catch {
            /* ignore */
        }
    }
    return false;
}

function parseToolCallArguments(call: any): Record<string, any> {
    const rawArgs = call?.function?.arguments;
    let args: Record<string, any> = {};
    if (typeof rawArgs === "string") {
        try {
            args = JSON.parse(rawArgs);
        } catch {
            args = {};
        }
    } else if (rawArgs && typeof rawArgs === "object") {
        args = rawArgs;
    }
    return args;
}

/**
 * If the model emitted several patchMetaDescriptor calls in one assistant message, merge
 * all `patch` arrays (order preserved) and apply once so the project gets one commit.
 */
function mergePatchMetaDescriptorToolCalls(
    toolCalls: any[]
): { mergedArgs: { patch: any[] }; callCount: number } | null {
    if (!Array.isArray(toolCalls) || toolCalls.length <= 1) return null;
    const allPatch = toolCalls.every((c: any) => c?.function?.name === "patchMetaDescriptor");
    if (!allPatch) return null;
    const patch: any[] = [];
    for (const call of toolCalls) {
        const args = parseToolCallArguments(call);
        if (Array.isArray(args.patch)) {
            patch.push(...args.patch);
        }
    }
    return { mergedArgs: { patch }, callCount: toolCalls.length };
}

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

/** Max chars for tool_call / tool_response bodies at info level (server log). */
const MAX_TOOL_LOG_CHARS = 48000;

/** Final /chat JSON body: status tells the client when empty reply is OK vs an error. */
function buildChatResponse(opts: {
    content: unknown;
    toolsUsed?: boolean;
    commands?: ClientCommand[];
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
}): Record<string, unknown> {
    const reply = opts.content != null ? String(opts.content) : "";
    const trimmed = reply.trim();
    const hadTools = !!opts.toolsUsed;
    const hadCommands = !!(opts.commands && opts.commands.length > 0);

    const base: Record<string, unknown> = {};
    if (opts.commands && opts.commands.length > 0) {
        base.commands = opts.commands;
    }
    if (opts.usage) {
        base.usage = opts.usage;
    }
    if (hadTools) {
        base.toolsUsed = true;
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

function logChatRequest(log: any, userId: string, context: any, messageLen: number): void {
    const ctx = context && typeof context === "object" ? context : {};
    const parts = ["userId=" + userId, "messageLen=" + messageLen];
    if (ctx.projectId) parts.push("projectId=" + ctx.projectId);
    if (ctx.activeNodeId) parts.push("activeNodeId=" + ctx.activeNodeId);
    if (ctx.modelingMode === "metamodel" || ctx.modelingMode === "domain") {
        parts.push("modelingMode=" + ctx.modelingMode);
    }
    log.info("chat_request " + parts.join(" "));
}

function logChatRequestDebug(log: any, body: any): void {
    log.debug("chat_request payload: " + JSON.stringify(body));
}

function logLlmRequest(log: any, round: number): void {
    log.info("llm_request round=" + round);
}

function logLlmRequestDebug(log: any, round: number, historyLength: number): void {
    log.debug("llm_request round=" + round + " historyMessages=" + historyLength);
}

function logLlmResponse(log: any, round: number, msg: any): void {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        const names = msg.tool_calls.map((c: any) => c.function?.name || "?").join(",");
        log.info("llm_response round=" + round + " tool_calls=" + msg.tool_calls.length + " " + names);
        for (const c of msg.tool_calls) {
            const raw = {
                id: c.id,
                name: c.function?.name,
                arguments: c.function?.arguments,
            };
            const line = JSON.stringify(raw);
            log.info(
                "llm_tool_call round=" +
                    round +
                    " " +
                    (line.length > MAX_TOOL_LOG_CHARS
                        ? line.slice(0, MAX_TOOL_LOG_CHARS) + "…"
                        : line)
            );
        }
    } else {
        const len = typeof msg.content === "string" ? msg.content.length : 0;
        log.info("llm_response round=" + round + " contentLen=" + len);
    }
}

function logLlmResponseDebug(log: any, round: number, msg: any): void {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        const summary = msg.tool_calls.map((c: any) => ({
            name: c.function?.name,
            args: c.function?.arguments != null ? String(c.function.arguments).slice(0, 200) : "",
        }));
        log.debug("llm_response round=" + round + " tool_calls: " + JSON.stringify(summary));
    } else {
        log.debug("llm_response round=" + round + " content: " + (msg.content || "").slice(0, 500));
    }
}

function logToolCall(
    log: any,
    name: string,
    args: Record<string, any>,
    meta?: { toolCallId?: string }
): void {
    const payload: Record<string, unknown> = { tool: name, arguments: args };
    if (meta?.toolCallId) payload.id = meta.toolCallId;
    const line = JSON.stringify(payload);
    log.info(
        "tool_call " +
            (line.length > MAX_TOOL_LOG_CHARS ? line.slice(0, MAX_TOOL_LOG_CHARS) + "…" : line)
    );
}

function logToolCallDebug(log: any, name: string, args: Record<string, any>, ctx: ToolContext): void {
    log.debug(
        "tool_call " +
            name +
            " hasCoreSession=" +
            !!ctx.coreSession +
            " context=" +
            JSON.stringify(ctx.context)
    );
}

function logToolResponse(log: any, name: string, result: any, err?: Error): void {
    if (err) {
        log.info("tool_response " + name + " error " + (err.message || String(err)).slice(0, 120));
        return;
    }
    const error = result && result.error;
    if (error) {
        log.info("tool_response " + name + " error " + String(error).slice(0, 120));
        return;
    }
    const line = JSON.stringify({ tool: name, result });
    log.info(
        "tool_response " +
            (line.length > MAX_TOOL_LOG_CHARS ? line.slice(0, MAX_TOOL_LOG_CHARS) + "…" : line)
    );
}

function logToolResponseDebug(log: any, name: string, result: any): void {
    log.debug("tool_response " + name + " (duplicate of info log)");
}

function getSession(userId: string): ChatMessage[] {
    if (!sessions.has(userId)) {
        sessions.set(userId, [{ role: "system", content: SYSTEM_PROMPT_BASE }]);
    }
    return sessions.get(userId)!;
}

function refreshSystemMessage(history: ChatMessage[], toolCtx: ToolContext): void {
    const payload = buildSessionContextPayload(toolCtx);
    const blocks = formatContextBlocksForSystem(payload);
    const content = blocks ? SYSTEM_PROMPT_BASE + "\n\n" + blocks : SYSTEM_PROMPT_BASE;
    if (history.length > 0 && history[0].role === "system") {
        history[0].content = content;
    } else {
        history.unshift({ role: "system", content });
    }
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

    const { config: llmAdapterConfig, usedFallbackFromAnthropic } = resolveLlmFromEnv();

    const maxToolRounds = (() => {
        const raw = process.env.CBACK_MAX_TOOL_ROUNDS;
        if (raw === undefined || raw === "") return MAX_TOOL_ROUNDS;
        const n = parseInt(raw, 10);
        return Number.isInteger(n) && n >= 1 && n <= 50 ? n : MAX_TOOL_ROUNDS;
    })();

    const llmRequestTimeoutMs = (() => {
        const raw = process.env.CBACK_LLM_REQUEST_TIMEOUT_MS;
        if (raw === undefined || raw === "") return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
        const n = parseInt(raw, 10);
        return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    })();

    if (usedFallbackFromAnthropic) {
        logger.warn("LLM_BACKEND=anthropic but LLM_API_KEY not set; using openai backend at default local base URL");
    }
    if (llmAdapterConfig.backend === "anthropic") {
        logger.info("cback LLM: anthropic (model=" + llmAdapterConfig.model + ", apiBase=" + llmAdapterConfig.baseOrigin + ")");
    } else {
        logger.info("cback LLM: openai-compatible (baseUrl=" + llmAdapterConfig.baseUrl + ", model=" + llmAdapterConfig.model + ")");
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
        const llm: Record<string, unknown> =
            llmAdapterConfig.backend === "anthropic"
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

    router.post("/chat", express.json(), async function (req: Request, res: Response) {
        const userId = getUserId(req);
        const userMessage: string = req.body?.message;
        /** Context is provided by the client only (active node, project, branch). Server never gathers or stores it. */
        const context = req.body?.context;

        logChatRequest(logger, userId, context, typeof userMessage === "string" ? userMessage.length : 0);
        logChatRequestDebug(logger, { message: userMessage, context });

        if (!userMessage || typeof userMessage !== "string") {
            res.status(400).json({ error: "Missing 'message' in request body" });
            return;
        }

        const isContinuation = req.body?.continuation === true;

        const history = getSession(userId);
        const toolCtxEarly: ToolContext = {
            userId,
            logger: logger.fork("tools"),
            gmeConfig: middlewareOpts.gmeConfig,
            safeStorage: middlewareOpts.safeStorage,
            gmeAuth: middlewareOpts.gmeAuth,
            context: context && typeof context === "object" ? context : undefined,
        };

        if (context && typeof context === "object" && context.projectId) {
            const sessionEarly = await createCoreSession(
                middlewareOpts.safeStorage,
                middlewareOpts.gmeConfig,
                userId,
                context.projectId,
                context.branchName || "master",
                logger
            );
            if (sessionEarly) {
                toolCtxEarly.coreSession = sessionEarly;
            }
        }

        refreshSystemMessage(history, toolCtxEarly);

        const turnCtx = formatTurnContextLine(toolCtxEarly);
        const mode = resolveModelingMode(toolCtxEarly.context);
        const userContent = turnCtx
            ? userMessage + "\n[Turn context: " + turnCtx + ", modelingMode=" + mode + "]"
            : userMessage + "\n[Turn context: modelingMode=" + mode + "]";
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

        const toolCtx = toolCtxEarly;

        /** Tool definitions for this request: metamodel → patchMetaDescriptor only; domain → none. */
        const toolDefs = getToolDefinitionsForLLM(middlewareOpts.gmeConfig, toolCtx.context);

        try {

            trimHistory(history, MAX_HISTORY_MESSAGES);

            let rounds = 0;
            let lastRoundFingerprint: string | null = null;
            let identicalToolRoundStreak = 0;
            const commands: ClientCommand[] = [];
            let toolsUsedThisChat = false;

            while (rounds < maxToolRounds) {
                rounds++;

                logLlmRequest(logger, rounds);
                logLlmRequestDebug(logger, rounds, history.length);
                const completionPromise = chatCompletion(
                    history,
                    toolDefs,
                    llmAdapterConfig,
                    mode === "metamodel" ? { parallelToolCalls: false } : undefined
                );
                const timeoutMessage = "LLM request timed out after " + (llmRequestTimeoutMs / 1000) + "s.";
                const result = await withTimeout(completionPromise, llmRequestTimeoutMs, timeoutMessage);
                const msg = result.message;

                if (result.finishReason === "tool_calls" && (!msg.tool_calls || msg.tool_calls.length === 0)) {
                    logger.warn(
                        "chat LLM finish_reason=tool_calls but message.tool_calls is missing; " +
                        "vLLM did not expose structured tool calls — check --tool-call-parser and, for reasoning models, --reasoning-parser."
                    );
                }
                if (
                    (!msg.tool_calls || msg.tool_calls.length === 0) &&
                    typeof msg.content === "string" &&
                    msg.content.indexOf("<tool_call") !== -1
                ) {
                    logger.warn(
                        "chat assistant text contains <tool_call> but no API tool_calls; tools will not run until the " +
                        "inference server parses tool output into message.tool_calls (see vLLM tool calling docs)."
                    );
                }

                if (result.usage) {
                    logger.info(
                        "llm_usage round=" + rounds + " prompt_tokens=" + result.usage.prompt_tokens +
                        " completion_tokens=" + result.usage.completion_tokens +
                        (result.usage.total_tokens != null ? " total=" + result.usage.total_tokens : "")
                    );
                }

                history.push(msg);

                if (!msg.tool_calls || msg.tool_calls.length === 0) {
                    logLlmResponse(logger, rounds, msg);
                    logLlmResponseDebug(logger, rounds, msg);
                    res.json(
                        buildChatResponse({
                            content: msg.content,
                            toolsUsed: toolsUsedThisChat,
                            commands,
                            usage: result.usage,
                        })
                    );
                    return;
                }

                const roundFingerprint = getToolCallsFingerprint(msg.tool_calls);
                if (roundFingerprint && roundFingerprint === lastRoundFingerprint) {
                    identicalToolRoundStreak++;
                } else {
                    identicalToolRoundStreak = 0;
                }
                lastRoundFingerprint = roundFingerprint;

                if (identicalToolRoundStreak >= 2) {
                    history.pop();
                    logger.warn(
                        "chat loop_guard userId=" +
                            userId +
                            " round=" +
                            rounds +
                            " streak=" +
                            identicalToolRoundStreak +
                            " fingerprint=" +
                            roundFingerprint.slice(0, 120)
                    );
                    res.json({
                        status: "error",
                        reply:
                            "Stopped: the model repeated the same tool calls several times without progress. The metamodel may already be updated — try asking a follow-up question.",
                        loopGuard: true,
                        toolsUsed: toolsUsedThisChat,
                    });
                    return;
                }

                const toolResultsThisRound: { content: string; tool_call_id: string }[] = [];
                let needClientDataKey: string | null = null;

                const patchBatch = mergePatchMetaDescriptorToolCalls(msg.tool_calls);
                let batchedPatchResult: { data: any; commands?: ClientCommand[] } | null = null;
                if (patchBatch && isToolEnabled("patchMetaDescriptor", toolCtx.context)) {
                    const batchHandler = toolMap.get("patchMetaDescriptor");
                    if (batchHandler) {
                        logger.info(
                            "patchMetaDescriptor batch: merging " +
                                patchBatch.callCount +
                                " tool calls into one apply (" +
                                patchBatch.mergedArgs.patch.length +
                                " ops)"
                        );
                        logToolCall(
                            logger,
                            "patchMetaDescriptor",
                            { ...patchBatch.mergedArgs, _batchedFrom: patchBatch.callCount },
                            { toolCallId: "batched" }
                        );
                        logToolCallDebug(logger, "patchMetaDescriptor", patchBatch.mergedArgs, toolCtx);
                        try {
                            batchedPatchResult = await batchHandler(patchBatch.mergedArgs, toolCtx);
                            toolsUsedThisChat = true;
                            if (batchedPatchResult.commands) {
                                commands.push(...batchedPatchResult.commands);
                            }
                            const tr = batchedPatchResult.data;
                            if (tr && typeof tr.needClientData === "string" &&
                                tr.needClientData === NEED_CLIENT_DATA_KEYS.diagramLayout) {
                                needClientDataKey = tr.needClientData;
                            }
                            logToolResponse(logger, "patchMetaDescriptor", tr);
                            logToolResponseDebug(logger, "patchMetaDescriptor", tr);
                        } catch (err: any) {
                            logToolResponse(logger, "patchMetaDescriptor", {}, err);
                            logger.debug("tool_response patchMetaDescriptor error stack: " + (err.stack || ""));
                            batchedPatchResult = { data: { error: err.message } };
                        }
                    } else {
                        batchedPatchResult = {
                            data: { error: "patchMetaDescriptor handler not registered (internal error)." },
                        };
                    }
                }

                for (const call of msg.tool_calls) {
                    const args = parseToolCallArguments(call);

                    if (patchBatch && call.function.name === "patchMetaDescriptor" && batchedPatchResult) {
                        const toolResult = {
                            ...batchedPatchResult.data,
                            batchedToolCalls: patchBatch.callCount,
                        };
                        toolResultsThisRound.push({
                            content: toolResultContentForHistory(call.function.name, toolResult),
                            tool_call_id: call.id,
                        });
                        continue;
                    }

                    logToolCall(logger, call.function.name, args, { toolCallId: call.id });
                    logToolCallDebug(logger, call.function.name, args, toolCtx);

                    const handler = toolMap.get(call.function.name);
                    let toolResult: any;

                    if (!isToolEnabled(call.function.name, toolCtx.context)) {
                        const modeNow = resolveModelingMode(toolCtx.context);
                        toolResult = {
                            error:
                                "Tool '" +
                                call.function.name +
                                "' is not available in " +
                                modeNow +
                                " mode. Use patchMetaDescriptor in metamodel mode.",
                        };
                        logToolResponse(logger, call.function.name, toolResult);
                    } else if (handler) {
                        try {
                            const handlerResult = await handler(args, toolCtx);
                            toolResult = handlerResult.data;
                            toolsUsedThisChat = true;
                            if (handlerResult.commands) {
                                commands.push(...handlerResult.commands);
                            }
                            if (toolResult && typeof toolResult.needClientData === "string" &&
                                toolResult.needClientData === NEED_CLIENT_DATA_KEYS.diagramLayout) {
                                needClientDataKey = toolResult.needClientData;
                            }
                            logToolResponse(logger, call.function.name, toolResult);
                            logToolResponseDebug(logger, call.function.name, toolResult);
                        } catch (err: any) {
                            logToolResponse(logger, call.function.name, {}, err);
                            logger.debug("tool_response " + call.function.name + " error stack: " + (err.stack || ""));
                            toolResult = { error: err.message };
                        }
                    } else {
                        logger.warn("tool_call " + call.function.name + " unknown tool");
                        logToolResponse(logger, call.function.name, { error: "Unknown tool" });
                        toolResult = { error: `Unknown tool: ${call.function.name}` };
                    }

                    toolResultsThisRound.push({
                        content: toolResultContentForHistory(call.function.name, toolResult),
                        tool_call_id: call.id,
                    });
                }

                if (needClientDataKey) {
                    history.pop();
                    res.json({
                        status: "continuation",
                        reply: "",
                        continuation: true,
                        requestClientData: { key: needClientDataKey },
                        toolsUsed: toolsUsedThisChat,
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

                if (toolRoundMadeProgress(toolResultsThisRound)) {
                    identicalToolRoundStreak = 0;
                    lastRoundFingerprint = null;
                }
                refreshSystemMessage(history, toolCtx);

                if (mode === "metamodel" && metamodelPatchSucceededInRound(toolResultsThisRound)) {
                    logger.info("llm_request metamodel_final_reply after successful patch");
                    const finalResult = await withTimeout(
                        chatCompletion(history, [], llmAdapterConfig, undefined),
                        llmRequestTimeoutMs,
                        "LLM request timed out after " + (llmRequestTimeoutMs / 1000) + "s."
                    );
                    const finalMsg = finalResult.message;
                    history.push(finalMsg);
                    logLlmResponse(logger, rounds, finalMsg);
                    logLlmResponseDebug(logger, rounds, finalMsg);
                    res.json(
                        buildChatResponse({
                            content: finalMsg.content,
                            toolsUsed: toolsUsedThisChat,
                            commands,
                            usage: finalResult.usage,
                        })
                    );
                    return;
                }
            }

            logger.warn("chat max_rounds userId=" + userId + " rounds=" + maxToolRounds);
            res.json({
                status: "error",
                reply: "Reached maximum tool call rounds without a final answer.",
                toolsUsed: toolsUsedThisChat,
            });
        } catch (err: any) {
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
                logger.warn("test run_tool error tool=" + toolName + " " + (err && err.message));
                logger.debug("test run_tool args: " + JSON.stringify(args));
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
