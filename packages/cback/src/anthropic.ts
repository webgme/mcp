/**
 * Anthropic Messages API adapter.
 * Same interface as ollama.chatCompletion so cback can switch providers via config.
 * Requires ANTHROPIC_API_KEY. Use in dev by setting LLM_PROVIDER=anthropic.
 */

import https from "https";
import type { ChatMessage, ChatCompletionResult } from "./ollama";

export interface AnthropicConfig {
    apiKey: string;
    model: string;
    /** API version header, e.g. 2023-06-01 */
    version?: string;
}

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";

/** Convert our tool definitions (OpenAI-style) to Anthropic tools: name, description, input_schema */
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

/** Convert our ChatMessage[] history to Anthropic messages + system.
 * Anthropic: system is separate; messages are { role, content } where content is string or content blocks.
 * - user: content string
 * - assistant with tool_calls: content = [ { type: "tool_use", id, name, input }, ... ]
 * - tool results: we send a user message with content = [ { type: "tool_result", tool_use_id, content }, ... ]
 */
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

/** Parse Anthropic response content blocks into our ChatMessage (assistant with optional tool_calls and/or content) */
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

export function chatCompletion(
    messages: ChatMessage[],
    tools: object[],
    config: AnthropicConfig
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
        const version = config.version ?? DEFAULT_ANTHROPIC_VERSION;

        const req = https.request(
            {
                hostname: "api.anthropic.com",
                port: 443,
                path: "/v1/messages",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(bodyStr, "utf8"),
                    "x-api-key": config.apiKey,
                    "anthropic-version": version,
                },
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

export { DEFAULT_ANTHROPIC_MODEL, DEFAULT_ANTHROPIC_VERSION };
