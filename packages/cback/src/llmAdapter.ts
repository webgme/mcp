/**
 * LLM HTTP adapter for cback: reads LLM_* env, sends chat-completions requests, returns OpenAI-shaped messages.
 *
 * - **OpenAI-shaped** `ChatMessage[]` for the rest of the router (roles + tool_calls).
 * - **backend openai:** POST `{baseUrl}/chat/completions` (Ollama /v1, vLLM, Groq, OpenAI, …).
 * - **backend anthropic:** translate at the wire only, POST `{baseOrigin}/v1/messages`.
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

export function chatCompletion(
    messages: ChatMessage[],
    tools: object[],
    config: LlmAdapterConfig
): Promise<ChatCompletionResult> {
    if (config.backend === "anthropic") {
        return anthropicChatCompletion(messages, tools, config);
    }
    return openAICompatChatCompletion(messages, tools, config);
}

/* ---------- OpenAI-compatible ---------- */

function messagesToOpenAI(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.map((m) => {
        const msg: Record<string, unknown> = {
            role: m.role,
            content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
        };
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
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

function openAIResponseToMessage(choice: { message?: { content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }): ChatMessage {
    const m = choice?.message;
    if (!m) {
        return { role: "assistant", content: "" };
    }
    const content = m.content != null ? String(m.content) : "";
    const rawToolCalls = m.tool_calls;
    if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
        return { role: "assistant", content };
    }
    const toolCalls = rawToolCalls.map((tc) => ({
        id: tc.id ?? "",
        type: "function" as const,
        function: {
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "{}",
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
    config: { backend: "openai"; baseUrl: string; apiKey?: string; model: string }
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

        const bodyStr = JSON.stringify(body);

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
                            reject(new Error("OpenAI-compatible API returned empty response"));
                            return;
                        }
                        const json = JSON.parse(data);
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
                        const message = openAIResponseToMessage(choices[0]);
                        const finishReason = choices[0].finish_reason;
                        const usage = json.usage;
                        resolve({
                            message,
                            done: finishReason === "stop" || finishReason === "end_turn",
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
                            reject(new Error("Anthropic returned empty response"));
                            return;
                        }
                        const json = JSON.parse(data);
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
                        resolve({
                            message,
                            done: json.stop_reason === "end_turn" || json.stop_reason === "stop_sequence",
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
