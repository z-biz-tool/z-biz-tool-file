"use strict";
// Opencode wrapper: HTTP against the local opencode server (127.0.0.1:8643).
// The server is session-based: we POST /session once per proxy session, cache
// the opencode session id, and reuse it on subsequent turns. Replies come back
// as one full message body; we slice the text by newline and stream each line
// as an SSE delta so the client still sees line-level progress.
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpencodeProcessWrapper = void 0;
const logger_1 = require("../logger");
const config_1 = require("../config");
const utils_1 = require("../utils");
const sse_1 = require("../sse");
const opencodeSessions = new Map();
class OpencodeProcessWrapper {
    supports(type) {
        return type === 'opencode';
    }
    async streamChat(cfg, req, sse) {
        const completionId = (0, sse_1.newCompletionId)();
        const created = Math.floor(Date.now() / 1000);
        const model = cfg.type;
        let full = '';
        let errored = false;
        try {
            const ocSessionId = await this.resolveOrCreateSession(req.sessionId);
            const prompt = (0, utils_1.buildPrompt)(req.messages);
            const responseBody = await this.sendMessage(ocSessionId, prompt);
            const parts = extractTextParts(responseBody);
            full = parts.join('');
            for (const text of parts) {
                if (text == null || text.length === 0)
                    continue;
                for (const line of text.split('\n')) {
                    sse.write((0, sse_1.sseChunk)(completionId, model, created, line + '\n'));
                }
            }
        }
        catch (e) {
            errored = true;
            logger_1.logger.warn('opencode server error:', e?.message);
            if (full.length === 0) {
                sse.write((0, sse_1.sseError)('opencode server error: ' + (e?.message || String(e))));
            }
        }
        if (!errored)
            sse.write((0, sse_1.sseDone)());
        return full;
    }
    async syncChat(cfg, req) {
        const ocSessionId = await this.resolveOrCreateSession(req.sessionId);
        const prompt = (0, utils_1.buildPrompt)(req.messages);
        const responseBody = await this.sendMessage(ocSessionId, prompt);
        return extractTextParts(responseBody).join('');
    }
    // ──────────── internals ────────────
    async resolveOrCreateSession(proxySessionId) {
        if (proxySessionId) {
            const existing = opencodeSessions.get(proxySessionId);
            if (existing) {
                logger_1.logger.info(`Reusing opencode session: ${existing} for proxy session ${proxySessionId}`);
                return existing;
            }
        }
        const id = await createOpencodeSession();
        if (proxySessionId)
            opencodeSessions.set(proxySessionId, id);
        return id;
    }
    async sendMessage(sessionId, prompt) {
        const body = `{"parts":[{"type":"text","text":"${(0, utils_1.escapeJson)(prompt)}"}]}`;
        const url = `${config_1.config.opencodeServerUrl}/session/${encodeURIComponent(sessionId)}/message`;
        // The Java version uses a single POST and parses the response body directly.
        // The /message endpoint returns the full reply, so we do the same here.
        return postRaw(url, body);
    }
}
exports.OpencodeProcessWrapper = OpencodeProcessWrapper;
// ──────────── free helpers (kept outside the class for testability) ────────────
async function createOpencodeSession() {
    const url = `${config_1.config.opencodeServerUrl}/session`;
    const body = await postRaw(url, '{}');
    let json = null;
    try {
        json = JSON.parse(body);
    }
    catch {
        throw new Error(`opencode createSession: non-JSON response: ${body.slice(0, 200)}`);
    }
    const id = typeof json?.id === 'string' ? json.id : null;
    if (!id)
        throw new Error('opencode createSession: no session id in response');
    logger_1.logger.info(`opencode session created: ${id}`);
    return id;
}
function postRaw(urlStr, body) {
    return new Promise((resolve, reject) => {
        const http = require('http');
        const url = new URL(urlStr);
        const req = http.request({
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            const code = res.statusCode || 0;
            if (code < 200 || code >= 300) {
                (0, utils_1.readAllText)(res).then((txt) => reject(new Error(`HTTP ${code} from ${urlStr}: ${txt}`)));
                return;
            }
            (0, utils_1.readAllText)(res).then((txt) => resolve(txt));
        });
        req.on('error', (e) => reject(e));
        req.write(body);
        req.end();
    });
}
function extractTextParts(body) {
    try {
        const json = JSON.parse(body);
        const parts = Array.isArray(json?.parts) ? json.parts : null;
        if (!parts)
            return [];
        const texts = [];
        for (const p of parts) {
            if (p && p.type === 'text' && typeof p.text === 'string')
                texts.push(p.text);
        }
        return texts;
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=opencode.js.map