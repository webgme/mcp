/**
 * LLM HTTP adapter for cback: reads LLM_* env, sends chat-completions requests, returns OpenAI-shaped messages.
 *
 * - **OpenAI-shaped** `ChatMessage[]` for the rest of the router (roles + tool_calls).
 * - **backend openai:** POST `{baseUrl}/chat/completions` (Ollama /v1, vLLM, Groq, OpenAI, …).
 * - **backend anthropic:** translate at the wire only, POST `{baseOrigin}/v1/messages`.
 * - **Debug:** `LLM_HTTP_DEBUG=1` (or `true` / `yes`) logs request URL, sizes, and response bodies to stderr (`[cback:llm:http]`).
 */

import http from "http";
import https from "https";

/* ---------- shared types ---------- */

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string | Record<string, any>;
    };
}

export interface ChatCompletionResult {
    message: ChatMessage;
    done: boolean;
    /** OpenAI `choices[0].finish_reason` when present (e.g. `tool_calls`, `stop`). */
    finishReason?: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
}

export type LlmAdapterConfig =
    | { backend: "openai"; baseUrl: string; apiKey?: string; model: string }
    | { backend: "anthropic"; baseOrigin: string; apiKey: string; model: string; anthropicVersion?: string };

/* ---------- env → config (kept inline; small and stable) ---------- */

const DEFAULT_OPENAI_BASE = "http://127.0.0.1:11434/v1";
const DEFAULT_OPENAI_MODEL = "qwen3:8b";
const DEFAULT_ANTHROPIC_ORIGIN = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";

function trimEnv(s: string | undefined): string | undefined {
    if (s === undefined || s === null) return undefined;
    const t = String(s).trim();
    return t === "" ? undefined : t;
}

function llmHttpDebugEnabled(): boolean {
    const v = trimEnv(process.env.LLM_HTTP_DEBUG);
    if (!v) return false;
    const x = v.toLowerCase();
    return x === "1" || x === "true" || x === "yes";
}

/** Logs to stderr; enable with LLM_HTTP_DEBUG=1 */
function llmHttpDebug(label: string, detail: Record<string, unknown>): void {
    if (!llmHttpDebugEnabled()) return;
    console.error("[cback:llm:http] " + label + " " + JSON.stringify(detail));
}

export type ResolvedLlmAdapter = {
    config: LlmAdapterConfig;
    usedFallbackFromAnthropic: boolean;
};

export function resolveLlmFromEnv(): ResolvedLlmAdapter {
    const raw = (trimEnv(process.env.LLM_BACKEND) || "openai").toLowerCase();
    const backend = raw === "anthropic" ? "anthropic" : "openai";
    const base = trimEnv(process.env.LLM_BASE_URL);
    const key = trimEnv(process.env.LLM_API_KEY);
    const model = trimEnv(process.env.LLM_MODEL);
    const anthropicVersion = trimEnv(process.env.LLM_ANTHROPIC_VERSION);

    if (backend === "anthropic") {
        if (!key) {
            return {
                config: {
                    backend: "openai",
                    baseUrl: DEFAULT_OPENAI_BASE,
                    apiKey: undefined,
                    model: model || DEFAULT_OPENAI_MODEL,
                },
                usedFallbackFromAnthropic: true,
            };
        }
        let origin = DEFAULT_ANTHROPIC_ORIGIN;
        if (base) {
            try {
                origin = new URL(base).origin;
            } catch {
                /* keep default */
            }
        }
        return {
            config: {
                backend: "anthropic",
                baseOrigin: origin,
                apiKey: key,
                model: model || DEFAULT_ANTHROPIC_MODEL,
                ...(anthropicVersion ? { anthropicVersion } : {}),
            },
            usedFallbackFromAnthropic: false,
        };
    }

    return {
        config: {
            backend: "openai",
            baseUrl: base || DEFAULT_OPENAI_BASE,
            apiKey: key,
            model: model || DEFAULT_OPENAI_MODEL,
        },
        usedFallbackFromAnthropic: false,
    };
}

/* ---------- public API ---------- */

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/** Optional flags for the HTTP request (OpenAI-compatible servers may ignore unknown fields). */
export type ChatCompletionRequestOptions = {
    /** When false, request at most one tool call per assistant message (OpenAI `parallel_tool_calls: false`). */
    parallelToolCalls?: boolean;
};

export function chatCompletion(
    messages: ChatMessage[],
    tools: object[],
    config: LlmAdapterConfig,
    requestOptions?: ChatCompletionRequestOptions
): Promise<ChatCompletionResult> {
    if (config.backend === "anthropic") {
        return anthropicChatCompletion(messages, tools, config);
    }
    return openAICompatChatCompletion(messages, tools, config, requestOptions);
}

/* ---------- OpenAI-compatible ---------- */

function messagesToOpenAI(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role };
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
            const text = typeof m.content === "string" ? m.content : String(m.content ?? "");
            // OpenAI-style APIs expect null (not "") when the assistant turn is tool-only.
            msg.content = text === "" ? null : text;
            msg.tool_calls = m.tool_calls.map((tc) => ({
                id: tc.id,
                type: tc.type,
                function: {
                    name: tc.function.name,
                    arguments: typeof tc.function.arguments === "string"
                        ? tc.function.arguments
                        : JSON.stringify(tc.function.arguments ?? {}),
                },
            }));
        } else {
            msg.content = typeof m.content === "string" ? m.content : String(m.content ?? "");
        }
        if (m.role === "tool" && m.tool_call_id !== undefined) {
            msg.tool_call_id = m.tool_call_id;
        }
        return msg;
    });
}

function toolsToOpenAI(tools: object[]): object[] {
    return tools.map((t: any) => {
        const f = t?.function;
        if (!f || typeof f.name !== "string") return t;
        return {
            type: "function",
            function: {
                name: f.name,
                description: typeof f.description === "string" ? f.description : "",
                parameters: f.parameters && typeof f.parameters === "object" ? f.parameters : { type: "object", properties: {}, required: [] },
            },
        };
    });
}

function normalizeOpenAiFunctionArguments(raw: unknown): string {
    if (typeof raw === "string") return raw;
    if (raw && typeof raw === "object") {
        try {
            return JSON.stringify(raw);
        } catch {
            return "{}";
        }
    }
    return "{}";
}

/** Strip ```json ... ``` if present (whole-string or first fenced block in text). */
function stripMarkdownJsonFence(s: string): string {
    let t = s.trim();
    const full = /^```(?:json)?\s*\n?([\s\S]*?)```$/m.exec(t);
    if (full) return full[1].trim();
    const any = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(t);
    if (any) return any[1].trim();
    return t;
}

/** Keys allowed on createMetaNode tool arguments (concept name is `name`, not the tool id). */
const CREATE_META_ARG_KEYS = new Set(["name", "basePath", "contains", "pointers", "sets"]);

/**
 * Object is likely createMetaNode *arguments* (not an OpenAI tool call): `name` is the new concept name.
 * Reject when `name` equals a registered tool name (e.g. listProjects) to avoid mis-wrapping.
 */
function looksLikeCreateMetaNodeArgs(o: Record<string, unknown>, allowedToolNames: Set<string>): boolean {
    if (!allowedToolNames.has("createMetaNode")) return false;
    if (typeof o.name !== "string" || o.name.trim() === "") return false;
    if (allowedToolNames.has(o.name)) return false;
    const keys = Object.keys(o);
    if (keys.length === 0) return false;
    return keys.every((k) => CREATE_META_ARG_KEYS.has(k));
}

/** Parse every ```json``` block plus optional whole-string JSON (prose + many code blocks). */
function extractJsonValuesFromAssistantContent(content: string): unknown[] {
    const out: unknown[] = [];
    const re = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        try {
            out.push(JSON.parse(m[1].trim()));
        } catch {
            /* skip */
        }
    }
    if (out.length === 0) {
        const tc = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i.exec(content);
        if (tc) {
            try {
                out.push(JSON.parse(stripMarkdownJsonFence(tc[1]).trim()));
            } catch {
                /* skip */
            }
        }
    }
    if (out.length === 0) {
        const t = stripMarkdownJsonFence(content).trim();
        if (t.startsWith("[") || t.startsWith("{")) {
            try {
                out.push(JSON.parse(t));
            } catch {
                /* skip */
            }
        }
    }
    return out;
}

function tryNormalizeOpenAiToolCallsFlat(parsed: unknown, allowedToolNames: Set<string>): ToolCall[] | null {
    const flat = normalizeToolCallPayloadToFlat(parsed);
    if (!flat || flat.length === 0) return null;
    for (const c of flat) {
        if (!allowedToolNames.has(c.name)) return null;
    }
    return flat.map((c, i) => ({
        id: "call_content_" + i,
        type: "function" as const,
        function: {
            name: c.name,
            arguments: normalizeOpenAiFunctionArguments(c.arguments),
        },
    }));
}

/** Models often emit createMetaNode *parameters* only; `name` is the concept, not the tool function name. */
function tryBareCreateMetaNodeCalls(parsed: unknown, allowedToolNames: Set<string>): ToolCall[] | null {
    if (!allowedToolNames.has("createMetaNode")) return null;
    if (Array.isArray(parsed)) {
        const out: ToolCall[] = [];
        for (let i = 0; i < parsed.length; i++) {
            const item = parsed[i];
            if (!item || typeof item !== "object") return null;
            const o = item as Record<string, unknown>;
            if (!looksLikeCreateMetaNodeArgs(o, allowedToolNames)) return null;
            out.push({
                id: "call_content_meta_" + i,
                type: "function" as const,
                function: {
                    name: "createMetaNode",
                    arguments: normalizeOpenAiFunctionArguments(o),
                },
            });
        }
        return out.length ? out : null;
    }
    if (typeof parsed === "object" && parsed !== null) {
        const o = parsed as Record<string, unknown>;
        if (!looksLikeCreateMetaNodeArgs(o, allowedToolNames)) return null;
        return [
            {
                id: "call_content_meta_0",
                type: "function" as const,
                function: {
                    name: "createMetaNode",
                    arguments: normalizeOpenAiFunctionArguments(o),
                },
            },
        ];
    }
    return null;
}

function toolCallFingerprint(tc: ToolCall): string {
    const a =
        typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments ?? {});
    return tc.function.name + ":" + a;
}

/**
 * vLLM + some Qwen checkpoints leave tool calls as JSON text in `message.content` while `tool_calls` is empty.
 * Handles: OpenAI-shaped tool JSON, and bare createMetaNode parameter objects/blocks embedded in prose.
 */
function trySynthesizeToolCallsFromContent(content: string, allowedToolNames: Set<string>): ToolCall[] | null {
    if (!allowedToolNames.size || !content || typeof content !== "string") return null;

    const candidates = extractJsonValuesFromAssistantContent(content);
    if (candidates.length === 0) return null;

    const merged: ToolCall[] = [];
    const seen = new Set<string>();

    for (const parsed of candidates) {
        let batch: ToolCall[] | null = tryNormalizeOpenAiToolCallsFlat(parsed, allowedToolNames);
        if (!batch) batch = tryBareCreateMetaNodeCalls(parsed, allowedToolNames);
        if (!batch) continue;
        for (const tc of batch) {
            const fp = toolCallFingerprint(tc);
            if (seen.has(fp)) continue;
            seen.add(fp);
            merged.push(tc);
        }
    }

    return merged.length > 0 ? merged : null;
}

function normalizeToolCallPayloadToFlat(parsed: unknown): Array<{ name: string; arguments: unknown }> | null {
    if (parsed == null) return null;
    if (Array.isArray(parsed)) {
        const out: Array<{ name: string; arguments: unknown }> = [];
        for (const item of parsed) {
            const one = oneToolCallShapeFromValue(item);
            if (!one) return null;
            out.push(one);
        }
        return out.length ? out : null;
    }
    if (typeof parsed === "object") {
        const o = parsed as Record<string, unknown>;
        if (Array.isArray(o.tool_calls)) {
            const out: Array<{ name: string; arguments: unknown }> = [];
            for (const item of o.tool_calls) {
                const one = oneToolCallShapeFromValue(item);
                if (!one) return null;
                out.push(one);
            }
            return out.length ? out : null;
        }
        const one = oneToolCallShapeFromValue(parsed);
        if (one) return [one];
    }
    return null;
}

function oneToolCallShapeFromValue(obj: unknown): { name: string; arguments: unknown } | null {
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    if (o.type === "function" && o.function && typeof o.function === "object") {
        const fn = o.function as Record<string, unknown>;
        if (typeof fn.name !== "string" || fn.name.trim() === "") return null;
        return { name: fn.name.trim(), arguments: fn.arguments ?? {} };
    }
    if (typeof o.name === "string" && o.name.trim() !== "") {
        const args = o.arguments ?? o.parameters ?? o.args ?? {};
        return { name: o.name.trim(), arguments: args };
    }
    return null;
}

function oneLineBodySnippet(body: string, maxLen: number): string {
    const trimmed = body.trim();
    const t = trimmed.slice(0, maxLen).replace(/\s+/g, " ");
    return trimmed.length > maxLen ? t + "…" : t;
}

/**
 * Proxy errors, wrong URL, or auth redirects often return HTML; JSON.parse then throws
 * `Unexpected token '<'`. Surface status + snippet + hints for operators.
 */
function llmNonJsonResponseError(kind: "openai" | "anthropic", statusCode: number | undefined, body: string): Error {
    const snip = oneLineBodySnippet(body, 200);
    const st = statusCode != null ? String(statusCode) : "?";
    const isHtml = /^\s*</.test(body);
    let hint = "";
    if (kind === "openai") {
        if (isHtml) {
            hint =
                "Response looks like HTML, not JSON — check LLM_BASE_URL ends with /v1 (request is POST {base}/chat/completions). " +
                "A reverse proxy, login page, or error page usually means wrong URL, missing /v1, or TLS/host routing.";
        } else if (statusCode === 404) {
            hint = "404 often means base path wrong; use e.g. https://host:port/v1 not https://host/chat.";
        } else if (statusCode === 401 || statusCode === 403) {
            hint = "Set LLM_API_KEY if the gateway requires a Bearer token.";
        } else if (statusCode != null && statusCode >= 502 && statusCode <= 504) {
            hint = "Gateway error — upstream LLM process may be down or timing out.";
        }
    } else if (isHtml) {
        hint =
            "Response looks like HTML. For anthropic backend, LLM_BASE_URL should be the API origin only (e.g. https://api.anthropic.com); cback POSTs /v1/messages.";
    }
    const prefix = kind === "openai" ? "OpenAI-compatible LLM" : "Anthropic";
    return new Error(`${prefix} returned non-JSON (HTTP ${st}): ${snip}${hint ? " " + hint : ""}`);
}

function openAIResponseToMessage(
    choice: {
        message?: {
            content?: string | null;
            tool_calls?: Array<{
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string | Record<string, unknown> };
            }>;
            /** Deprecated OpenAI shape; some OpenAI-compat servers still return this. */
            function_call?: { name?: string; arguments?: string | Record<string, unknown> };
        };
    },
    allowedToolNames?: Set<string>
): ChatMessage {
    const m = choice?.message;
    if (!m) {
        return { role: "assistant", content: "" };
    }
    let content = m.content != null ? String(m.content) : "";
    let rawToolCalls = m.tool_calls;
    if ((!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) && m.function_call && typeof m.function_call === "object") {
        const fc = m.function_call;
        const name = typeof fc.name === "string" ? fc.name : "";
        const args = normalizeOpenAiFunctionArguments(fc.arguments);
        rawToolCalls = [
            {
                id: "call_legacy_0",
                type: "function",
                function: { name, arguments: args },
            },
        ];
    }
    if (
        (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) &&
        allowedToolNames &&
        allowedToolNames.size > 0
    ) {
        const synthesized = trySynthesizeToolCallsFromContent(content, allowedToolNames);
        if (synthesized && synthesized.length > 0) {
            rawToolCalls = synthesized;
            content = "";
        }
    }
    if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
        return { role: "assistant", content };
    }
    const toolCalls = rawToolCalls.map((tc, i) => ({
        id: tc.id && String(tc.id).trim() !== "" ? String(tc.id) : "call_auto_" + i,
        type: "function" as const,
        function: {
            name: tc.function?.name ?? "",
            arguments: normalizeOpenAiFunctionArguments(tc.function?.arguments),
        },
    }));
    return { role: "assistant", content, tool_calls: toolCalls };
}

function parseBaseUrl(baseUrl: string): { hostname: string; port: number; pathPrefix: string; useHttps: boolean } {
    const u = new URL(baseUrl);
    const defaultPort = u.protocol === "https:" ? 443 : 80;
    return {
        hostname: u.hostname,
        port: u.port ? parseInt(u.port, 10) : defaultPort,
        pathPrefix: u.pathname.replace(/\/$/, "") || "",
        useHttps: u.protocol === "https:",
    };
}

function openAICompatChatCompletion(
    messages: ChatMessage[],
    tools: object[],
    config: { backend: "openai"; baseUrl: string; apiKey?: string; model: string },
    requestOptions?: ChatCompletionRequestOptions
): Promise<ChatCompletionResult> {
    return new Promise((resolve, reject) => {
        const { hostname, port, pathPrefix, useHttps } = parseBaseUrl(config.baseUrl);
        const path = pathPrefix + "/chat/completions";

        const apiMessages = messagesToOpenAI(messages);
        const body: Record<string, unknown> = {
            model: config.model,
            messages: apiMessages,
            stream: false,
        };
        if (tools.length > 0) {
            body.tools = toolsToOpenAI(tools);
        }
        if (requestOptions?.parallelToolCalls === false) {
            body.parallel_tool_calls = false;
        }

        const bodyStr = JSON.stringify(body);
        const openaiUrl = (useHttps ? "https://" : "http://") + hostname + (port ? `:${port}` : "") + path;
        const toolNames = Array.isArray(body.tools)
            ? (body.tools as { function?: { name?: string } }[])
                  .map((t) => t?.function?.name)
                  .filter((n): n is string => typeof n === "string")
            : [];
        llmHttpDebug("openai_request", {
            method: "POST",
            url: openaiUrl,
            modelInBody: body.model,
            configModel: config.model,
            messageCount: apiMessages.length,
            toolCount: toolNames.length,
            toolNamesSample: toolNames.slice(0, 20),
            hasToolChoiceInBody: Object.prototype.hasOwnProperty.call(body, "tool_choice"),
            bodyBytes: Buffer.byteLength(bodyStr, "utf8"),
        });

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(bodyStr, "utf8")),
        };
        const key = config.apiKey;
        if (key !== undefined && key !== "") {
            headers["Authorization"] = "Bearer " + key;
        }

        const requestImpl = useHttps ? https.request : http.request;
        const req = requestImpl(
            {
                hostname,
                port,
                path,
                method: "POST",
                headers,
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        if (!data || typeof data !== "string") {
                            llmHttpDebug("openai_response", { statusCode: res.statusCode, error: "empty_body" });
                            reject(new Error("OpenAI-compatible API returned empty response"));
                            return;
                        }
                        if (llmHttpDebugEnabled()) {
                            const max = res.statusCode === 200 ? 2500 : 16000;
                            const truncated = data.length > max;
                            llmHttpDebug("openai_response", {
                                statusCode: res.statusCode,
                                bodyChars: data.length,
                                bodyTruncated: truncated,
                                body: truncated ? data.slice(0, max) : data,
                            });
                        }
                        let json: any;
                        try {
                            json = JSON.parse(data);
                        } catch {
                            reject(llmNonJsonResponseError("openai", res.statusCode ?? undefined, data));
                            return;
                        }
                        if (res.statusCode !== 200) {
                            const errMsg = (json.error && (json.error.message || json.error.code)) || json.message || `API returned ${res.statusCode}`;
                            reject(new Error(errMsg));
                            return;
                        }
                        const choices = json.choices;
                        if (!Array.isArray(choices) || choices.length === 0) {
                            reject(new Error("API response missing choices"));
                            return;
                        }
                        const message = openAIResponseToMessage(choices[0], new Set(toolNames));
                        const finishReason = choices[0].finish_reason;
                        const usage = json.usage;
                        const fr = finishReason != null ? String(finishReason) : undefined;
                        resolve({
                            message,
                            done: fr === "stop" || fr === "end_turn",
                            ...(fr ? { finishReason: fr } : {}),
                            ...(usage && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number"
                                ? {
                                    usage: {
                                        prompt_tokens: usage.prompt_tokens,
                                        completion_tokens: usage.completion_tokens,
                                        total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
                                    },
                                }
                                : {}),
                        });
                    } catch (e: any) {
                        reject(new Error("API response invalid: " + (e?.message || String(e))));
                    }
                });
            }
        );

        req.on("error", (err) => reject(new Error("Request failed: " + err.message)));
        req.write(bodyStr);
        req.end();
    });
}

/* ---------- Anthropic ---------- */

function toolsToAnthropic(tools: object[]): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return tools.map((t: any) => {
        const f = t?.function;
        if (!f || typeof f.name !== "string") return null;
        const params = f.parameters && typeof f.parameters === "object" ? f.parameters : { type: "object", properties: {}, required: [] };
        return {
            name: f.name,
            description: typeof f.description === "string" ? f.description : "",
            input_schema: params as Record<string, unknown>,
        };
    }).filter(Boolean) as Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
}

function messagesToAnthropic(messages: ChatMessage[]): { system?: string; messages: Array<{ role: "user" | "assistant"; content: string | object[] }> } {
    const out: Array<{ role: "user" | "assistant"; content: string | object[] }> = [];
    let system: string | undefined;

    for (const m of messages) {
        if (m.role === "system") {
            system = typeof m.content === "string" ? m.content : String(m.content ?? "");
            continue;
        }
        if (m.role === "user") {
            out.push({ role: "user", content: typeof m.content === "string" ? m.content : String(m.content ?? "") });
            continue;
        }
        if (m.role === "assistant") {
            if (m.tool_calls && m.tool_calls.length > 0) {
                const blocks = m.tool_calls.map((tc) => {
                    let input: Record<string, unknown> = {};
                    const raw = tc.function.arguments;
                    if (typeof raw === "string") {
                        try {
                            input = JSON.parse(raw);
                        } catch {
                            input = {};
                        }
                    } else if (raw && typeof raw === "object") {
                        input = raw as Record<string, unknown>;
                    }
                    return {
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input,
                    };
                });
                out.push({ role: "assistant", content: blocks });
            } else {
                const text = typeof m.content === "string" ? m.content : String(m.content ?? "");
                out.push({ role: "assistant", content: text });
            }
            continue;
        }
        if (m.role === "tool") {
            out.push({
                role: "user",
                content: [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: typeof m.content === "string" ? m.content : String(m.content ?? "") }],
            });
        }
    }

    return { system, messages: out };
}

function anthropicContentToMessage(content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>): ChatMessage {
    const textParts: string[] = [];
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string | Record<string, unknown> } }> = [];

    for (const block of content) {
        if (block.type === "text" && block.text !== undefined) {
            textParts.push(block.text);
        } else if (block.type === "tool_use" && block.id && block.name !== undefined) {
            toolCalls.push({
                id: block.id,
                type: "function",
                function: {
                    name: block.name,
                    arguments: block.input ?? {},
                },
            });
        }
    }

    return {
        role: "assistant",
        content: textParts.join("").trim() || "",
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
}

function anthropicChatCompletion(
    messages: ChatMessage[],
    tools: object[],
    config: { backend: "anthropic"; baseOrigin: string; apiKey: string; model: string; anthropicVersion?: string }
): Promise<ChatCompletionResult> {
    return new Promise((resolve, reject) => {
        const { system, messages: anthropicMessages } = messagesToAnthropic(messages);
        const anthropicTools = toolsToAnthropic(tools);

        const body: Record<string, unknown> = {
            model: config.model,
            max_tokens: 8192,
            ...(system !== undefined && system !== "" ? { system } : {}),
            messages: anthropicMessages,
            ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        };

        const bodyStr = JSON.stringify(body);
        const version = config.anthropicVersion || DEFAULT_ANTHROPIC_VERSION;

        let hostname: string;
        let port: number;
        let useHttps: boolean;
        try {
            const u = new URL(config.baseOrigin);
            useHttps = u.protocol === "https:";
            hostname = u.hostname;
            const defaultPort = useHttps ? 443 : 80;
            port = u.port ? parseInt(u.port, 10) : defaultPort;
        } catch (e: any) {
            reject(new Error("Invalid LLM_BASE_URL for anthropic: " + (e?.message || String(e))));
            return;
        }

        const path = "/v1/messages";
        const anthropicUrl = (useHttps ? "https://" : "http://") + hostname + (port ? `:${port}` : "") + path;
        llmHttpDebug("anthropic_request", {
            method: "POST",
            url: anthropicUrl,
            model: config.model,
            messageBlockCount: anthropicMessages.length,
            toolCount: anthropicTools.length,
            bodyBytes: Buffer.byteLength(bodyStr, "utf8"),
        });

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(bodyStr, "utf8")),
            "x-api-key": config.apiKey,
            "anthropic-version": version,
        };

        const requestImpl = useHttps ? https.request : http.request;
        const req = requestImpl(
            {
                hostname,
                port,
                path,
                method: "POST",
                headers,
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        if (!data || typeof data !== "string") {
                            llmHttpDebug("anthropic_response", { statusCode: res.statusCode, error: "empty_body" });
                            reject(new Error("Anthropic returned empty response"));
                            return;
                        }
                        if (llmHttpDebugEnabled()) {
                            const max = res.statusCode === 200 ? 2500 : 16000;
                            const truncated = data.length > max;
                            llmHttpDebug("anthropic_response", {
                                statusCode: res.statusCode,
                                bodyChars: data.length,
                                bodyTruncated: truncated,
                                body: truncated ? data.slice(0, max) : data,
                            });
                        }
                        let json: any;
                        try {
                            json = JSON.parse(data);
                        } catch {
                            reject(llmNonJsonResponseError("anthropic", res.statusCode ?? undefined, data));
                            return;
                        }
                        if (res.statusCode !== 200) {
                            const errMsg = (json.error && (json.error.message || json.error.type)) || json.message || `Anthropic returned ${res.statusCode}`;
                            reject(new Error(errMsg));
                            return;
                        }
                        const content = json.content;
                        if (!Array.isArray(content)) {
                            reject(new Error("Anthropic response missing content array"));
                            return;
                        }
                        const message = anthropicContentToMessage(content);
                        const usage = json.usage;
                        const sr = json.stop_reason != null ? String(json.stop_reason) : undefined;
                        resolve({
                            message,
                            done: json.stop_reason === "end_turn" || json.stop_reason === "stop_sequence",
                            ...(sr ? { finishReason: sr } : {}),
                            ...(usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
                                ? {
                                    usage: {
                                        prompt_tokens: usage.input_tokens,
                                        completion_tokens: usage.output_tokens,
                                        total_tokens: usage.input_tokens + usage.output_tokens,
                                    },
                                }
                                : {}),
                        });
                    } catch (e: any) {
                        reject(new Error("Anthropic response invalid: " + (e?.message || String(e))));
                    }
                });
            }
        );

        req.on("error", (err) => reject(new Error("Anthropic request failed: " + err.message)));
        req.write(bodyStr);
        req.end();
    });
}
