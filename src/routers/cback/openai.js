"use strict";
/**
 * OpenAI-compatible API adapter (Groq, OpenAI, etc.).
 * Same interface as ollama.chatCompletion so cback can switch providers.
 * Use with Groq (free tier): LLM_PROVIDER=groq, GROQ_API_KEY=..., baseUrl https://api.groq.com/openai/v1
 * Use with OpenAI: LLM_PROVIDER=openai, OPENAI_API_KEY=..., baseUrl https://api.openai.com/v1
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPENAI_BASE_URL = exports.GROQ_BASE_URL = exports.DEFAULT_OPENAI_MODEL = exports.DEFAULT_GROQ_MODEL = void 0;
exports.chatCompletion = chatCompletion;
const https_1 = __importDefault(require("https"));
/** Groq default (free tier); also works for OpenAI if you set baseUrl to OpenAI. */
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
exports.GROQ_BASE_URL = GROQ_BASE_URL;
const OPENAI_BASE_URL = "https://api.openai.com/v1";
exports.OPENAI_BASE_URL = OPENAI_BASE_URL;
/** Default model for Groq free tier (fast, tool use). */
exports.DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";
/** Default model for OpenAI (cheaper, good tool use). */
exports.DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
/** Convert our ChatMessage[] to OpenAI API messages. OpenAI expects tool_calls[].function.arguments as string. */
function messagesToOpenAI(messages) {
    return messages.map((m) => {
        var _a;
        const msg = {
            role: m.role,
            content: typeof m.content === "string" ? m.content : String((_a = m.content) !== null && _a !== void 0 ? _a : ""),
        };
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
            msg.tool_calls = m.tool_calls.map((tc) => {
                var _a;
                return ({
                    id: tc.id,
                    type: tc.type,
                    function: {
                        name: tc.function.name,
                        arguments: typeof tc.function.arguments === "string"
                            ? tc.function.arguments
                            : JSON.stringify((_a = tc.function.arguments) !== null && _a !== void 0 ? _a : {}),
                    },
                });
            });
        }
        if (m.role === "tool" && m.tool_call_id !== undefined) {
            msg.tool_call_id = m.tool_call_id;
        }
        return msg;
    });
}
/** Sanitize tools to OpenAI shape (type, function.name, function.description, function.parameters). */
function toolsToOpenAI(tools) {
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
/** Parse OpenAI/Groq response into our ChatMessage. */
function openAIResponseToMessage(choice) {
    const m = choice === null || choice === void 0 ? void 0 : choice.message;
    if (!m) {
        return { role: "assistant", content: "" };
    }
    const content = m.content != null ? String(m.content) : "";
    const rawToolCalls = m.tool_calls;
    if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
        return { role: "assistant", content };
    }
    const toolCalls = rawToolCalls.map((tc) => {
        var _a, _b, _c, _d, _e;
        return ({
            id: (_a = tc.id) !== null && _a !== void 0 ? _a : "",
            type: "function",
            function: {
                name: (_c = (_b = tc.function) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : "",
                arguments: (_e = (_d = tc.function) === null || _d === void 0 ? void 0 : _d.arguments) !== null && _e !== void 0 ? _e : "{}",
            },
        });
    });
    return { role: "assistant", content, tool_calls: toolCalls };
}
function parseBaseUrl(baseUrl) {
    const u = new URL(baseUrl);
    return {
        hostname: u.hostname,
        port: u.port ? parseInt(u.port, 10) : 443,
        pathPrefix: u.pathname.replace(/\/$/, "") || "",
    };
}
function chatCompletion(messages, tools, config) {
    return new Promise((resolve, reject) => {
        var _a;
        const baseUrl = (_a = config.baseUrl) !== null && _a !== void 0 ? _a : GROQ_BASE_URL;
        const { hostname, port, pathPrefix } = parseBaseUrl(baseUrl);
        const path = pathPrefix + "/chat/completions";
        const apiMessages = messagesToOpenAI(messages);
        const body = {
            model: config.model,
            messages: apiMessages,
            stream: false,
        };
        if (tools.length > 0) {
            body.tools = toolsToOpenAI(tools);
        }
        const bodyStr = JSON.stringify(body);
        const req = https_1.default.request({
            hostname,
            port,
            path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bodyStr, "utf8"),
                "Authorization": "Bearer " + config.apiKey,
            },
        }, (res) => {
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
                }
                catch (e) {
                    reject(new Error("API response invalid: " + ((e === null || e === void 0 ? void 0 : e.message) || String(e))));
                }
            });
        });
        req.on("error", (err) => reject(new Error("Request failed: " + err.message)));
        req.write(bodyStr);
        req.end();
    });
}
