import http from "http";

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

export interface OllamaConfig {
    host: string;
    port: number;
    model: string;
}

export const DEFAULT_CONFIG: OllamaConfig = {
    host: "127.0.0.1",
    port: 11434,
    model: "qwen3:8b",
};

export interface ChatCompletionResult {
    message: ChatMessage;
    done: boolean;
}

/**
 * Send a chat-completion request to the local Ollama server.
 * Uses the /api/chat endpoint with tool definitions so the model
 * can request tool calls.
 */
/**
 * Build a clean messages array for Ollama.
 * - tool_calls[].function.arguments must be an object (Ollama expects dict, not string).
 * - Tool messages use tool_name; we derive it from the previous assistant's tool_calls.
 * - Include index on tool_calls for multi-call turns.
 */
function sanitizeMessagesForOllama(messages: ChatMessage[]): object[] {
    const toolIdToName: Record<string, string> = {};
    for (const m of messages) {
        if (m.role === "assistant" && m.tool_calls) {
            for (const tc of m.tool_calls) {
                toolIdToName[tc.id] = tc.function.name;
            }
        }
    }
    return messages.map((m) => {
        const msg: Record<string, any> = {
            role: m.role,
            content: typeof m.content === "string" ? m.content : (m.content != null ? String(m.content) : ""),
        };
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
            msg.tool_calls = m.tool_calls.map((tc, i) => {
                let args: Record<string, any>;
                if (typeof tc.function.arguments === "string") {
                    try {
                        args = JSON.parse(tc.function.arguments);
                    } catch {
                        args = {};
                    }
                } else if (tc.function.arguments && typeof tc.function.arguments === "object") {
                    args = tc.function.arguments;
                } else {
                    args = {};
                }
                return {
                    id: tc.id,
                    type: tc.type,
                    function: {
                        index: i,
                        name: tc.function.name,
                        arguments: args,
                    },
                };
            });
        }
        if (m.role === "tool") {
            if (m.tool_call_id && toolIdToName[m.tool_call_id]) {
                msg.tool_name = toolIdToName[m.tool_call_id];
            }
            // Ollama docs show only role, tool_name, content for tool messages
        }
        return msg;
    });
}

/** Ensure tools array is plain JSON-serializable (no extra keys). */
function sanitizeToolsForOllama(tools: object[]): object[] {
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

export function chatCompletion(
    messages: ChatMessage[],
    tools: object[],
    config: OllamaConfig = DEFAULT_CONFIG
): Promise<ChatCompletionResult> {
    return new Promise((resolve, reject) => {
        const sanitized = sanitizeMessagesForOllama(messages);
        const payload = {
            model: config.model,
            messages: sanitized,
            ...(tools.length > 0 ? { tools: sanitizeToolsForOllama(tools) } : {}),
            stream: false,
            think: false,
        };
        let body: string;
        try {
            body = JSON.stringify(payload);
        } catch (e: any) {
            reject(new Error("Failed to serialize request: " + (e?.message || String(e))));
            return;
        }
        try {
            JSON.parse(body);
        } catch (e: any) {
            reject(new Error("Serialized request was invalid JSON: " + (e?.message || String(e))));
            return;
        }

        const req = http.request(
            {
                hostname: config.host,
                port: config.port,
                path: "/api/chat",
                method: "POST",
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Content-Length": Buffer.byteLength(body, "utf8"),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        if (!data || typeof data !== "string") {
                            reject(new Error("Ollama returned empty response"));
                            return;
                        }
                        const trimmed = data.trim();
                        if (trimmed.length > 0 && trimmed.startsWith("{") && !trimmed.endsWith("}")) {
                            reject(new Error(
                                `Ollama response truncated (starts with { but missing closing }); received ${data.length} bytes`
                            ));
                            return;
                        }
                        const json = JSON.parse(data);
                        if (res.statusCode !== 200) {
                            reject(
                                new Error(
                                    json.error ||
                                        `Ollama returned status ${res.statusCode}`
                                )
                            );
                            return;
                        }
                        resolve({
                            message: json.message,
                            done: json.done ?? true,
                        });
                    } catch (e: any) {
                        const detail = e instanceof SyntaxError
                            ? `Parse error: ${e.message}; response length=${data.length}`
                            : (e?.message || "Unknown error");
                        reject(new Error("Ollama response invalid: " + detail));
                    }
                });
            }
        );

        req.on("error", (err) =>
            reject(new Error(`Cannot reach Ollama at ${config.host}:${config.port}: ${err.message}`))
        );
        req.write(body);
        req.end();
    });
}
