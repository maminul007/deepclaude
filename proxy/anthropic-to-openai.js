/**
 * Anthropic ↔ Ollama native format translation.
 * Handles request translation, response translation (streaming + non-streaming),
 * and tool use mapping for Ollama Cloud's /api/chat endpoint.
 *
 * Ollama streaming: NDJSON lines (one JSON object per line, no SSE prefix)
 * Anthropic streaming: SSE events (event: type\ndata: json\n\n)
 */

import { Transform } from 'stream';

// Ollama API path (not OpenAI-compatible)
export const OLLAMA_CHAT_PATH = '/api/chat';

/**
 * Translate Anthropic /v1/messages request → Ollama /api/chat request
 */
export function translateRequest(body, modelOverride) {
    const messages = [];

    // System prompt → system message
    if (body.system) {
        if (typeof body.system === 'string') {
            messages.push({ role: 'system', content: body.system });
        } else if (Array.isArray(body.system)) {
            const text = body.system
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('\n');
            if (text) messages.push({ role: 'system', content: text });
        }
    }

    // Messages
    for (const msg of body.messages || []) {
        if (msg.role === 'user') {
            translateUserMessage(msg, messages);
        } else if (msg.role === 'assistant') {
            translateAssistantMessage(msg, messages);
        }
    }

    const result = {
        model: modelOverride || body.model,
        messages,
        stream: body.stream !== false,
    };

    // Ollama options (cap max_tokens to model limits)
    const MAX_OUTPUT_TOKENS = 65536;
    const options = {};
    if (body.max_tokens) options.num_predict = Math.min(body.max_tokens, MAX_OUTPUT_TOKENS);
    if (body.temperature !== undefined) options.temperature = body.temperature;
    if (body.top_p !== undefined) options.top_p = body.top_p;
    if (Object.keys(options).length > 0) result.options = options;

    // Tools (Ollama uses same format as OpenAI)
    if (body.tools && body.tools.length > 0) {
        result.tools = body.tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description || '',
                parameters: t.input_schema || { type: 'object', properties: {} },
            }
        }));
    }

    return result;
}

function translateUserMessage(msg, out) {
    if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
        return;
    }
    if (!Array.isArray(msg.content)) return;

    const textParts = [];
    const toolResults = [];

    for (const block of msg.content) {
        if (block.type === 'text') {
            textParts.push(block.text);
        } else if (block.type === 'tool_result') {
            let resultContent = '';
            if (typeof block.content === 'string') {
                resultContent = block.content;
            } else if (Array.isArray(block.content)) {
                resultContent = block.content
                    .filter(b => b.type === 'text')
                    .map(b => b.text)
                    .join('\n');
            }
            toolResults.push({
                role: 'tool',
                content: resultContent || '(empty)',
            });
        }
        // Skip thinking, image blocks
    }

    // Tool results go first (right after assistant tool_calls)
    for (const tr of toolResults) out.push(tr);
    if (textParts.length > 0) {
        out.push({ role: 'user', content: textParts.join('\n') });
    }
    if (toolResults.length === 0 && textParts.length === 0) {
        out.push({ role: 'user', content: '' });
    }
}

function translateAssistantMessage(msg, out) {
    if (typeof msg.content === 'string') {
        out.push({ role: 'assistant', content: msg.content });
        return;
    }
    if (!Array.isArray(msg.content)) return;

    let text = '';
    const toolCalls = [];

    for (const block of msg.content) {
        if (block.type === 'text') {
            text += block.text;
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                function: {
                    name: block.name,
                    arguments: block.input || {},
                },
            });
        }
        // Skip thinking blocks
    }

    const assistantMsg = { role: 'assistant', content: text || '' };
    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
    out.push(assistantMsg);
}

/**
 * Translate Ollama /api/chat response → Anthropic /v1/messages response (non-streaming)
 */
export function translateResponse(ollamaResp, requestModel) {
    const content = [];
    const msg = ollamaResp.message;

    if (msg?.content) {
        content.push({ type: 'text', text: msg.content });
    }

    if (msg?.tool_calls) {
        for (const tc of msg.tool_calls) {
            content.push({
                type: 'tool_use',
                id: tc.id || `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                name: tc.function.name,
                input: tc.function.arguments || {},
            });
        }
    }

    if (content.length === 0) {
        content.push({ type: 'text', text: '' });
    }

    const hasToolUse = msg?.tool_calls?.length > 0;

    return {
        type: 'message',
        id: `msg_${Date.now().toString(36)}`,
        role: 'assistant',
        content,
        model: requestModel || ollamaResp.model || 'unknown',
        stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
        usage: {
            input_tokens: ollamaResp.prompt_eval_count || 0,
            output_tokens: ollamaResp.eval_count || 0,
        },
    };
}

/**
 * Transform stream: Ollama NDJSON lines → Anthropic SSE events
 *
 * Ollama streams one JSON object per line:
 *   {"model":"...","message":{"role":"assistant","content":"Hi"},"done":false}
 *   {"model":"...","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":5}
 *
 * Tool calls come as a single chunk (not streamed incrementally).
 */
export class OllamaToAnthropicStream extends Transform {
    constructor(requestModel, onUsage) {
        super();
        this._model = requestModel;
        this._onUsage = onUsage;
        this._buf = '';
        this._started = false;
        this._contentIndex = 0;
        this._textBlockOpen = false;
        this._hasToolUse = false;
        this._inputTokens = 0;
        this._outputTokens = 0;
        this._msgId = `msg_${Date.now().toString(36)}`;
        this._finished = false;
    }

    _transform(chunk, _enc, cb) {
        this._buf += chunk.toString();
        const lines = this._buf.split('\n');
        this._buf = lines.pop(); // keep incomplete last line

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const data = JSON.parse(trimmed);
                this._handleChunk(data);
            } catch { /* skip non-JSON */ }
        }
        cb();
    }

    _flush(cb) {
        if (this._buf.trim()) {
            try {
                this._handleChunk(JSON.parse(this._buf.trim()));
            } catch {}
        }
        if (!this._finished) this._finishStream();
        if (this._onUsage) this._onUsage(this._inputTokens, this._outputTokens);
        cb();
    }

    _emit(eventType, data) {
        this.push(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    _ensureStarted() {
        if (this._started) return;
        this._started = true;
        this._emit('message_start', {
            type: 'message_start',
            message: {
                id: this._msgId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: this._model,
                usage: { input_tokens: this._inputTokens, output_tokens: 0 },
            },
        });
        this._emit('ping', { type: 'ping' });
    }

    _handleChunk(chunk) {
        this._ensureStarted();

        const msg = chunk.message;

        // Text content (streamed token by token)
        if (msg?.content) {
            if (!this._textBlockOpen) {
                this._emit('content_block_start', {
                    type: 'content_block_start',
                    index: this._contentIndex,
                    content_block: { type: 'text', text: '' },
                });
                this._textBlockOpen = true;
            }
            this._emit('content_block_delta', {
                type: 'content_block_delta',
                index: this._contentIndex,
                delta: { type: 'text_delta', text: msg.content },
            });
        }

        // Tool calls (arrive as complete objects in a single chunk)
        if (msg?.tool_calls && msg.tool_calls.length > 0) {
            this._hasToolUse = true;

            // Close text block first
            if (this._textBlockOpen) {
                this._emit('content_block_stop', {
                    type: 'content_block_stop',
                    index: this._contentIndex,
                });
                this._textBlockOpen = false;
                this._contentIndex++;
            }

            for (const tc of msg.tool_calls) {
                const toolId = tc.id || `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
                const input = tc.function.arguments || {};
                const inputJson = JSON.stringify(input);

                this._emit('content_block_start', {
                    type: 'content_block_start',
                    index: this._contentIndex,
                    content_block: {
                        type: 'tool_use',
                        id: toolId,
                        name: tc.function.name,
                        input: {},
                    },
                });

                // Emit the full input as a single delta
                this._emit('content_block_delta', {
                    type: 'content_block_delta',
                    index: this._contentIndex,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: inputJson,
                    },
                });

                this._emit('content_block_stop', {
                    type: 'content_block_stop',
                    index: this._contentIndex,
                });

                this._contentIndex++;
            }
        }

        // Final chunk (done: true) — collect usage and finish
        if (chunk.done) {
            this._inputTokens = chunk.prompt_eval_count || this._inputTokens;
            this._outputTokens = chunk.eval_count || this._outputTokens;
            this._finishStream();
        }
    }

    _finishStream() {
        if (this._finished) return;
        this._finished = true;

        this._ensureStarted();

        // Close any open text block
        if (this._textBlockOpen) {
            this._emit('content_block_stop', {
                type: 'content_block_stop',
                index: this._contentIndex,
            });
            this._textBlockOpen = false;
            this._contentIndex++;
        }

        this._emit('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: this._hasToolUse ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: this._outputTokens },
        });

        this._emit('message_stop', { type: 'message_stop' });
    }
}
