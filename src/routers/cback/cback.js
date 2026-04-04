"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const llmAdapter_1 = require("./llmAdapter");
const tools_1 = require("./tools");
const router = express_1.default.Router();
const SYSTEM_PROMPT = "You are GMEBot, an assistant embedded in a WebGME modeling environment. " +
    "You help users manage their projects and metamodels. " +
    "You have tools available — always call them instead of guessing. " +
    "Use the API tool-calling mechanism: each action must be a tool invocation by **tool name** (e.g. createMetaNode), not free-form JSON. " +
    "For createMetaNode, the **parameters** include `name` (the new concept's name)—do not confuse that with the tool name. " +
    "A single user message often asks for multiple things (e.g. 'create concept X and add a pointer to Y', or 'new concept with three pointers'). You MUST fulfill every part of the request: use as many tool calls as needed, or use createMetaNode with its optional 'contains', 'pointers', and 'sets' arrays to do concept + relations in one call. Do not stop after one tool call and reply until all requested actions are done. For connection, link, or edge concepts prefer pointer names 'src' and 'dst' so WebGME shows them as connections; you can use any order. The backend maps source/from/origin to src and destination/to/sink to dst if you use those words. Example: pointers: [{ pointerName: 'src', targetPath: 'X' }, { pointerName: 'dst', targetPath: 'Y' }]. " +
    "For example, call listProjects to see projects, listSeeds to see seeds, " +
    "createProject to create one, and switchProject to navigate to one. " +
    "Each tool returns JSON data. Present the results clearly to the user. " +
    "When referring to nodes in your replies to the user, use a consistent format: Name (path), e.g. 'StateMachine (/1/2)' or 'FCO (/1)'. The name is human-readable; the path in parentheses is the operational identifier. Use this format when summarizing tool results (moveNode, createNode, findNodesByName, etc.) so the user sees the friendly name while the path remains available for disambiguation. For tool parameters, always pass the path. " +
    "Assume the user's request applies to the **current context** (open project, active visualizer, selection) unless they explicitly scope it differently. " +
    "Three scopes for 'what exists' and bulk work: (1) **Diagram** — single level, what is on the **current canvas**; use getDiagramLayout (paths on that diagram). (2) **Model / subtree** — multiple levels of hierarchy under some container the user cares about (e.g. active selection, a named model fragment); use listNodes with that container path or name—not necessarily the whole project. (3) **Project** — entire tree; use listNodes from '/' or omit container. Do not claim there are no nodes without getDiagramLayout and/or listNodes/findNodesByName when a project is open. " +
    "When findNodesByName returns exactly one nodePaths entry, use that path directly (no extra confirmation). " +
    "If a tool returns an error or 'not implemented', tell the user. " +
    "When the client sends current context (projectId, branchName, activeNodeId), that is the user's open project and selection. " +
    "Use that as the default when the user does not specify a project or node — do not ask them to choose a project unless they explicitly want to switch or create one. " +
    "For tool calls, omit optional parameters when the user did not specify them; the backend will use default values. " +
    "If the user asks to 'create a node' or 'add a node' without giving type or parent, call createNode with no arguments (empty object) and do not ask them for type or parent. " +
    "In WebGME, FCO means First Class Object (not Foundation Class Object). " +
    "For property access: use getProperty to list or read a property, setProperty to set. The backend resolves attributes vs registry (attributes have priority). When the user says 'set', 'change', 'rename', 'modify' (e.g. 'rename X to Y', 'set position to 400 400'), call getProperty with no name first to see available properties and value formats, then setProperty. " +
    "When the user refers to a node by name (e.g. 'the node named X', 'set position of MyNode'), call findNodesByName first. Pass one of the returned nodePaths as nodeId in getProperty and setProperty. This applies to META concept nodes too: use findNodesByName, then getProperty and setProperty to change values. " +
    "Usual flow: get paths first (getDiagramLayout for diagram scope, listNodes for a chosen subtree or project scope, findNodesByName), then manipulate. For moveNode: get paths for node and container, then moveNode. For deleteNode, getProperty, setProperty: obtain paths from findNodesByName when the user refers by name. " +
    "Bulk delete except FCO: **diagram** scope — getDiagramLayout, then deleteNode other paths from the layout (never '/'). **Subtree** scope — listNodes(container) for the relevant parent, then deleteNode as needed. **Project** scope — listNodes from '/', then delete (never '/'). Resolve FCO with findNodesByName('FCO') when matching by name. deleteNode removes descendants, so deleting a parent can replace deleting its children. " +
    "When the user says 'change', 'set', 'modify', or 'rename' an attribute of a concept (e.g. 'rename Folder to MyFolder'), use node tools: findNodesByName, getProperty, setProperty. Do NOT use setMetaAttribute for that. Use setMetaAttribute only when defining the attribute rule (e.g. 'define the type of attribute name'). " +
    "When setting a property, use the format from getProperty (attributeValues/registryValues or valueFormats). " +
    "When the user wants to select a node, go to a node, or switch the visualizer (e.g. 'select node X', 'go to the root', 'switch to the diagram'), use setClientState with activeNodeId and/or visualizerId. " +
    "Always get the path from a tool first: for 'switch to FCO' or 'go to FCO context', call findNodesByName with name 'FCO', then setClientState with one of the returned nodePaths as activeNodeId. For other nodes by name, call findNodesByName first. For root use '/'. Do not guess paths — use only paths from tool responses. " +
    "Path vs name: parameters that accept path or name (conceptPath, sourcePath, targetPath, basePath, nodePath, etc.): treat a value as a path ONLY if it begins with '/' or if it cannot be found when used as a name. Otherwise pass it as a name—the backend resolves names. Example: 'Folder' and 'FCO' are concept names, not paths; use them as-is (no leading slash). Paths are project-specific (e.g. /1, /1/2) and come from getMetaInfo or findNodesByName. " +
    "For META containment (setMetaContainment): each call defines exactly one containment edge (one source concept, one target concept). The source must be the concept that is the container in the user's description (e.g. for 'SM contains S and T', source is SM, not FCO). Do not use FCO as source unless the user explicitly says FCO is the container; FCO is the root base type. If one container concept should contain multiple types, call setMetaContainment separately for each pair: e.g. (sourcePath=/SM, targetPath=/S) then (sourcePath=/SM, targetPath=/T). When the user says 'any' cardinality or does not specify cardinality, do not send min or max—omit both parameters. For pointers use setMetaPointer (cardinality 0..1 is fixed; no min/max arguments). For sets (multiple targets) use setMetaSet; for mixins use setMetaMixin. For all META relationship tools, path parameters accept either absolute paths (e.g. /FCO, /MyConcept) or concept names: when the user refers to concepts by name (no leading slash), pass the name as-is—the backend resolves names to paths. " +
    "META concepts already in the project: before createMetaNode with a given name, call getMetaInfo and check concepts[].name. If that name already exists, do not create a second concept—use setMetaPointer, setMetaContainment, setMetaSet, delMetaPointer, etc. on the existing concepts[].path. For follow-ups like 'add src/dst', 'make X a connection', or 'change pointers on Transition', use setMetaPointer (and delMetaPointer if replacing old pointers) on the existing concept—never createMetaNode again with the same concept name. " +
    "**Instance model vs metamodel:** If context.activeVisualizerId is the **model/instance editor** (not METAAspect), the user is editing **instances**. Words like **instance**, **instances**, **behavior**, **capture**, **state machine instance**, **model** (as in runtime model), **turnstile** → use **createNode** (with **baseType** paths from **getMetaInfo** concepts for State, Transition, etc.), **moveNode**, **setProperty**—not createMetaNode. **createMetaNode** is only for defining **new concept types** in the **metamodel** when in the META editor or when the user explicitly asks to add/change **META types** / **metamodel**. Do not create META concepts when the user asked for **instances** of existing types. " +
    "When the user asks to create a **new META concept type** (metamodel element, new type in the type system—not an instance), use createMetaNode, not createNode. createNode creates instance nodes in the model; createMetaNode defines new concepts in the metamodel. For a meta concept that should contain other types (e.g. 'Folder that can contain FCO'), or have pointers or sets, use createMetaNode with the optional 'contains', 'pointers', and 'sets' arrays so creation and all relations are done in one call. For createMetaNode basePath: pass the base concept's **name** (e.g. FCO) or omit to use FCO. Do NOT pass /FCO as a path—in WebGME the path of the FCO concept is project-specific (e.g. /1). The backend accepts either a concept name or a path from getMetaInfo (concepts[].path); it resolves names to the correct path. For connection, link, or edge concepts (that connect two nodes), prefer pointer names 'src' and 'dst' so WebGME visualizes them as connections; keep whatever order is meaningful (e.g. src=source end, dst=target end). The backend maps source/from/destination/to to src/dst when you use those words. When the user asks for such a concept, create it with pointers 'src' and 'dst' (or use the synonym words; order is preserved). After any meta modification (createMetaNode, setMetaContainment, setMetaPointer, setMetaSet, setMetaMixin, or their del* tools), run checkMetaConsistency as a safety check and report the result (ok or violations) to the user. To check that the instance model obeys the meta rules (e.g. containment, pointers), run checkModelConsistency on the project or a sub-tree and report any violations. After any model changes (createNode, moveNode, deleteNode, setProperty, setPointer, etc.), run checkModelConsistency for the current scope: pass the active node path (context.activeNodeId from the client) as nodePath with includeChildren true, so the subtree under the user's selection is validated; if no activeNodeId is available, run it on the whole project (omit nodePath or use '/').";
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
    return parts.length ? parts.join(" ") : "(no args)";
}
function logChatRequest(log, userId, context, messageLen) {
    const ctx = context && typeof context === "object" ? context : {};
    const parts = ["userId=" + userId, "messageLen=" + messageLen];
    if (ctx.projectId)
        parts.push("projectId=" + ctx.projectId);
    if (ctx.activeNodeId)
        parts.push("activeNodeId=" + ctx.activeNodeId);
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
        sessions.set(userId, [{ role: "system", content: SYSTEM_PROMPT }]);
    }
    return sessions.get(userId);
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
        const ctxParts = [];
        if (context && typeof context === "object") {
            if (context.projectId)
                ctxParts.push("projectId=" + context.projectId);
            if (context.branchName)
                ctxParts.push("branchName=" + context.branchName);
            if (context.activeNodeId)
                ctxParts.push("activeNodeId=" + context.activeNodeId);
            if (context.activeVisualizerId) {
                const vid = String(context.activeVisualizerId).trim();
                const layerHint = (0, tools_1.isMetaVisualizer)(vid)
                    ? "metamodel/META editor — define types with createMetaNode"
                    : "instance/model editor — build instances with createNode/moveNode/setProperty; do not use createMetaNode unless the user explicitly asks to change metatypes";
                ctxParts.push("activeVisualizerId=" + vid + " (" + layerHint + ")");
            }
            if (typeof context.activeTabId === "number")
                ctxParts.push("activeTabId=" + context.activeTabId);
        }
        const userContent = ctxParts.length > 0
            ? userMessage + "\n[Current context: " + ctxParts.join(", ") + ". Use these when the user does not specify otherwise.]"
            : userMessage;
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
        const toolCtx = {
            userId,
            logger: logger.fork("tools"),
            gmeConfig: middlewareOpts.gmeConfig,
            safeStorage: middlewareOpts.safeStorage,
            gmeAuth: middlewareOpts.gmeAuth,
            context: context && typeof context === "object" ? context : undefined,
        };
        if (context && typeof context === "object" && context.projectId) {
            const session = await createCoreSession(middlewareOpts.safeStorage, middlewareOpts.gmeConfig, userId, context.projectId, context.branchName || "master", logger);
            if (session) {
                toolCtx.coreSession = session;
            }
        }
        /** Tool definitions for this request: filtered by activeVisualizerId etc. */
        const toolDefs = (0, tools_1.getToolDefinitionsForLLM)(middlewareOpts.gmeConfig, toolCtx.context);
        try {
            const listProjectsHandler = toolMap.get("listProjects");
            if (listProjectsHandler) {
                await ensureProjectListInContext(history, listProjectsHandler, toolCtx);
            }
            trimHistory(history, MAX_HISTORY_MESSAGES);
            let rounds = 0;
            let lastRoundFingerprint = null;
            const commands = [];
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
                    const response = { reply: msg.content };
                    if (commands.length > 0) {
                        response.commands = commands;
                    }
                    if (result.usage) {
                        response.usage = result.usage;
                    }
                    res.json(response);
                    return;
                }
                const roundFingerprint = getToolCallsFingerprint(msg.tool_calls);
                if (roundFingerprint && roundFingerprint === lastRoundFingerprint) {
                    history.pop();
                    logger.warn("chat loop_guard userId=" + userId + " round=" + rounds + " repeated tool calls");
                    res.json({
                        reply: "Stopped: the same tool calls were repeated without progress. Please try rephrasing your request or a different approach.",
                        loopGuard: true,
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
                    const handler = toolMap.get(call.function.name);
                    let toolResult;
                    if (handler) {
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
            logger.warn("chat max_rounds userId=" + userId + " rounds=" + maxToolRounds);
            res.json({ reply: "Reached maximum tool call rounds without a final answer." });
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
