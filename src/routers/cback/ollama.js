"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = void 0;
exports.chatCompletion = chatCompletion;
const http_1 = __importDefault(require("http"));
exports.DEFAULT_CONFIG = {
    host: "127.0.0.1",
    port: 11434,
    model: "qwen3:8b",
};
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
function sanitizeMessagesForOllama(messages) {
    const toolIdToName = {};
    for (const m of messages) {
        if (m.role === "assistant" && m.tool_calls) {
            for (const tc of m.tool_calls) {
                toolIdToName[tc.id] = tc.function.name;
            }
        }
    }
    return messages.map((m) => {
        const msg = {
            role: m.role,
            content: typeof m.content === "string" ? m.content : (m.content != null ? String(m.content) : ""),
        };
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
            msg.tool_calls = m.tool_calls.map((tc, i) => {
                let args;
                if (typeof tc.function.arguments === "string") {
                    try {
                        args = JSON.parse(tc.function.arguments);
                    }
                    catch {
                        args = {};
                    }
                }
                else if (tc.function.arguments && typeof tc.function.arguments === "object") {
                    args = tc.function.arguments;
                }
                else {
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
function sanitizeToolsForOllama(tools) {
    return tools.map((t) => {
        const f = t === null || t === void 0 ? void 0 : t.function;
        if (!f || typeof f.name !== "string")
            return t;
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
function chatCompletion(messages, tools, config = exports.DEFAULT_CONFIG) {
    return new Promise((resolve, reject) => {
        const sanitized = sanitizeMessagesForOllama(messages);
        const payload = {
            model: config.model,
            messages: sanitized,
            ...(tools.length > 0 ? { tools: sanitizeToolsForOllama(tools) } : {}),
            stream: false,
            think: false,
        };
        let body;
        try {
            body = JSON.stringify(payload);
        }
        catch (e) {
            reject(new Error("Failed to serialize request: " + ((e === null || e === void 0 ? void 0 : e.message) || String(e))));
            return;
        }
        try {
            JSON.parse(body);
        }
        catch (e) {
            reject(new Error("Serialized request was invalid JSON: " + ((e === null || e === void 0 ? void 0 : e.message) || String(e))));
            return;
        }
        const req = http_1.default.request({
            hostname: config.host,
            port: config.port,
            path: "/api/chat",
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": Buffer.byteLength(body, "utf8"),
            },
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                var _a;
                try {
                    if (!data || typeof data !== "string") {
                        reject(new Error("Ollama returned empty response"));
                        return;
                    }
                    const trimmed = data.trim();
                    if (trimmed.length > 0 && trimmed.startsWith("{") && !trimmed.endsWith("}")) {
                        reject(new Error(`Ollama response truncated (starts with { but missing closing }); received ${data.length} bytes`));
                        return;
                    }
                    const json = JSON.parse(data);
                    if (res.statusCode !== 200) {
                        reject(new Error(json.error ||
                            `Ollama returned status ${res.statusCode}`));
                        return;
                    }
                    resolve({
                        message: json.message,
                        done: (_a = json.done) !== null && _a !== void 0 ? _a : true,
                    });
                }
                catch (e) {
                    const detail = e instanceof SyntaxError
                        ? `Parse error: ${e.message}; response length=${data.length}`
                        : ((e === null || e === void 0 ? void 0 : e.message) || "Unknown error");
                    reject(new Error("Ollama response invalid: " + detail));
                }
            });
        });
        req.on("error", (err) => reject(new Error(`Cannot reach Ollama at ${config.host}:${config.port}: ${err.message}`)));
        req.write(body);
        req.end();
    });
}
