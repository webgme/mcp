"use strict";
/**
 * Anthropic Messages API adapter.
 * Same interface as ollama.chatCompletion so cback can switch providers via config.
 * Requires ANTHROPIC_API_KEY. Use in dev by setting LLM_PROVIDER=anthropic.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ANTHROPIC_VERSION = exports.DEFAULT_ANTHROPIC_MODEL = void 0;
exports.chatCompletion = chatCompletion;
const https_1 = __importDefault(require("https"));
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
exports.DEFAULT_ANTHROPIC_VERSION = DEFAULT_ANTHROPIC_VERSION;
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";
exports.DEFAULT_ANTHROPIC_MODEL = DEFAULT_ANTHROPIC_MODEL;
/** Convert our tool definitions (OpenAI-style) to Anthropic tools: name, description, input_schema */
function toolsToAnthropic(tools) {
    return tools.map((t) => {
        const f = t === null || t === void 0 ? void 0 : t.function;
        if (!f || typeof f.name !== "string")
            return null;
        const params = f.parameters && typeof f.parameters === "object" ? f.parameters : { type: "object", properties: {}, required: [] };
        return {
            name: f.name,
            description: typeof f.description === "string" ? f.description : "",
            input_schema: params,
        };
    }).filter(Boolean);
}
/** Convert our ChatMessage[] history to Anthropic messages + system.
 * Anthropic: system is separate; messages are { role, content } where content is string or content blocks.
 * - user: content string
 * - assistant with tool_calls: content = [ { type: "tool_use", id, name, input }, ... ]
 * - tool results: we send a user message with content = [ { type: "tool_result", tool_use_id, content }, ... ]
 */
function messagesToAnthropic(messages) {
    var _a, _b, _c, _d, _e;
    const out = [];
    let system;
    for (const m of messages) {
        if (m.role === "system") {
            system = typeof m.content === "string" ? m.content : String((_a = m.content) !== null && _a !== void 0 ? _a : "");
            continue;
        }
        if (m.role === "user") {
            out.push({ role: "user", content: typeof m.content === "string" ? m.content : String((_b = m.content) !== null && _b !== void 0 ? _b : "") });
            continue;
        }
        if (m.role === "assistant") {
            if (m.tool_calls && m.tool_calls.length > 0) {
                const blocks = m.tool_calls.map((tc) => {
                    let input = {};
                    const raw = tc.function.arguments;
                    if (typeof raw === "string") {
                        try {
                            input = JSON.parse(raw);
                        }
                        catch {
                            input = {};
                        }
                    }
                    else if (raw && typeof raw === "object") {
                        input = raw;
                    }
                    return {
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input,
                    };
                });
                out.push({ role: "assistant", content: blocks });
            }
            else {
                const text = typeof m.content === "string" ? m.content : String((_c = m.content) !== null && _c !== void 0 ? _c : "");
                out.push({ role: "assistant", content: text });
            }
            continue;
        }
        if (m.role === "tool") {
            out.push({
                role: "user",
                content: [{ type: "tool_result", tool_use_id: (_d = m.tool_call_id) !== null && _d !== void 0 ? _d : "", content: typeof m.content === "string" ? m.content : String((_e = m.content) !== null && _e !== void 0 ? _e : "") }],
            });
        }
    }
    return { system, messages: out };
}
/** Parse Anthropic response content blocks into our ChatMessage (assistant with optional tool_calls and/or content) */
function anthropicContentToMessage(content) {
    var _a;
    const textParts = [];
    const toolCalls = [];
    for (const block of content) {
        if (block.type === "text" && block.text !== undefined) {
            textParts.push(block.text);
        }
        else if (block.type === "tool_use" && block.id && block.name !== undefined) {
            toolCalls.push({
                id: block.id,
                type: "function",
                function: {
                    name: block.name,
                    arguments: (_a = block.input) !== null && _a !== void 0 ? _a : {},
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
function chatCompletion(messages, tools, config) {
    return new Promise((resolve, reject) => {
        var _a;
        const { system, messages: anthropicMessages } = messagesToAnthropic(messages);
        const anthropicTools = toolsToAnthropic(tools);
        const body = {
            model: config.model,
            max_tokens: 8192,
            ...(system !== undefined && system !== "" ? { system } : {}),
            messages: anthropicMessages,
            ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        };
        const bodyStr = JSON.stringify(body);
        const version = (_a = config.version) !== null && _a !== void 0 ? _a : DEFAULT_ANTHROPIC_VERSION;
        const req = https_1.default.request({
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
        }, (res) => {
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
                }
                catch (e) {
                    reject(new Error("Anthropic response invalid: " + ((e === null || e === void 0 ? void 0 : e.message) || String(e))));
                }
            });
        });
        req.on("error", (err) => reject(new Error("Anthropic request failed: " + err.message)));
        req.write(bodyStr);
        req.end();
    });
}
