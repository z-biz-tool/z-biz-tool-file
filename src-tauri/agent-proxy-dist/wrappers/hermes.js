"use strict";
// Hermes wrapper. Two execution paths:
//
//   1. **Subprocess (default)** — `hermes chat -q "{prompt}" -Q`. The local
//      `hermes` CLI is itself a full LLM client; no external service needed.
//      `streamParser.extractDelta` already filters the `session_id: ...`
//      header line and treats the remainder as plain text.
//
//   2. **HTTP gateway (legacy)** — POST to the local hermes gateway at
//      127.0.0.1:8642 with `Authorization: Bearer <key>`. Used by the Java
//      proxy and assumed available in some internal deployments. We fall
//      back to this path when the subprocess is not available, OR when the
//      caller sets the legacy `AGENT_PROXY_HERMES_LEGACY=1` env var.
//
// Session reuse for the subprocess path: we spawn a fresh `hermes chat` per
// request, but if the caller passes a `sessionId` we feed it back via
// `--resume` using a previously-observed hermes session id. The first
// invocation of a given proxy session id captures hermes's `session_id: …`
// header for that purpose.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.HermesProcessWrapper = void 0;
const child_process_1 = require("child_process");
const http = __importStar(require("http"));
const logger_1 = require("../logger");
const config_1 = require("../config");
const utils_1 = require("../utils");
const streamParser_1 = require("../streamParser");
const sse_1 = require("../sse");
const sessionHistories = new Map();
/** proxySessionId -> last hermes session_id we saw (so we can --resume). */
const hermesSessionIds = new Map();
class HermesProcessWrapper {
    supports(type) {
        return type === 'hermes';
    }
    async streamChat(cfg, req, sse) {
        // Subprocess path by default; HTTP path only when explicitly requested
        // and the binary isn't available.
        const useHttp = process.env.AGENT_PROXY_HERMES_LEGACY === '1' &&
            !(0, utils_1.resolveCommand)('hermes');
        if (useHttp)
            return this.streamViaGateway(req, sse);
        const completionId = (0, sse_1.newCompletionId)();
        const created = Math.floor(Date.now() / 1000);
        const model = cfg.type;
        let full = '';
        let errored = false;
        try {
            const proc = this.spawnHermesChat(cfg, req);
            let buf = '';
            proc.stdout.on('data', (chunk) => {
                buf += chunk.toString('utf-8');
                let idx;
                while ((idx = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, idx);
                    buf = buf.slice(idx + 1);
                    const captured = captureSessionId(line, req.sessionId);
                    const delta = (0, streamParser_1.extractDelta)(line);
                    if (delta) {
                        full += delta;
                        sse.write((0, sse_1.sseChunk)(completionId, model, created, delta));
                    }
                    else if (captured) {
                        // session id line — already logged
                    }
                }
            });
            // Hermes (-Q mode) writes the `session_id: ...` header to stderr, not
            // stdout. Drain stderr so the OS pipe doesn't block, and run the same
            // captureSessionId against stderr lines.
            let stderr = '';
            let stderrBuf = '';
            proc.stderr.on('data', (b) => {
                stderr += b.toString();
                stderrBuf += b.toString();
                let idx;
                while ((idx = stderrBuf.indexOf('\n')) >= 0) {
                    const line = stderrBuf.slice(0, idx);
                    stderrBuf = stderrBuf.slice(idx + 1);
                    captureSessionId(line, req.sessionId);
                }
            });
            const code = await waitForExit(proc, config_1.config.processTimeoutMs);
            // flush any tail without trailing newline
            if (buf.length > 0) {
                const delta = (0, streamParser_1.extractDelta)(buf);
                if (delta) {
                    full += delta;
                    sse.write((0, sse_1.sseChunk)(completionId, model, created, delta));
                }
                buf = '';
            }
            if (code === -1) {
                sse.write((0, sse_1.sseError)('Hermes process timeout'));
                errored = true;
            }
            else if (code !== 0 && full.length === 0) {
                sse.write((0, sse_1.sseError)(`Hermes exited with code ${code}: ${stderr.trim()}`));
                errored = true;
            }
            else if (code !== 0) {
                logger_1.logger.warn(`Hermes exited with code ${code}: ${stderr.trim()}`);
            }
        }
        catch (e) {
            errored = true;
            logger_1.logger.warn('Hermes subprocess error:', e);
            if (full.length === 0)
                sse.write((0, sse_1.sseError)('Hermes error: ' + (e?.message || String(e))));
        }
        if (!errored)
            sse.write((0, sse_1.sseDone)());
        return full;
    }
    async syncChat(cfg, req) {
        const useHttp = process.env.AGENT_PROXY_HERMES_LEGACY === '1' &&
            !(0, utils_1.resolveCommand)('hermes');
        if (useHttp)
            return this.consumeGateway(req, false, () => undefined, (m) => { throw new Error(m); });
        const proc = this.spawnHermesChat(cfg, req);
        let full = '';
        let buf = '';
        let stderr = '';
        let stderrBuf = '';
        proc.stdout.on('data', (b) => {
            buf += b.toString('utf-8');
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                captureSessionId(line, req.sessionId);
                const delta = (0, streamParser_1.extractDelta)(line);
                if (delta)
                    full += delta;
            }
        });
        proc.stderr.on('data', (b) => {
            stderr += b.toString();
            stderrBuf += b.toString();
            let idx;
            while ((idx = stderrBuf.indexOf('\n')) >= 0) {
                const line = stderrBuf.slice(0, idx);
                stderrBuf = stderrBuf.slice(idx + 1);
                captureSessionId(line, req.sessionId);
            }
        });
        const code = await waitForExit(proc, config_1.config.processTimeoutMs);
        if (buf.length > 0) {
            const delta = (0, streamParser_1.extractDelta)(buf);
            if (delta)
                full += delta;
        }
        if (code === -1)
            throw new Error('Hermes process timeout');
        if (code !== 0 && full.length === 0) {
            throw new Error(`Hermes exited with code ${code}: ${stderr.trim()}`);
        }
        return full;
    }
    // ──────────── subprocess path ────────────
    spawnHermesChat(cfg, req) {
        const prompt = (0, utils_1.buildPrompt)(req.messages);
        const resolved = (0, utils_1.resolveCommand)(cfg.command) || cfg.command;
        // base args: 'chat -q "{prompt}" -Q' (quiet mode for programmatic use)
        const baseArgs = ['chat', '-q', prompt, '-Q'];
        // session reuse: if we have a stored hermes session id for this proxy
        // session, pass --resume so the model sees prior context.
        if (req.sessionId) {
            const hermesId = hermesSessionIds.get(req.sessionId);
            if (hermesId) {
                baseArgs.push('--resume', hermesId);
                logger_1.logger.info(`Resuming hermes session ${hermesId} for proxy session ${req.sessionId}`);
            }
        }
        const env = (0, utils_1.childProcessEnv)();
        const cwd = cfg.workingDir ? (0, utils_1.expandHome)(cfg.workingDir) : process.cwd();
        logger_1.logger.info(`Spawning hermes chat: command=${resolved} args=${JSON.stringify(baseArgs).slice(0, 200)}`);
        return (0, child_process_1.spawn)(resolved, baseArgs, {
            env,
            cwd: cwd || process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    // ──────────── HTTP gateway path (legacy fallback) ────────────
    async streamViaGateway(req, sse) {
        const completionId = (0, sse_1.newCompletionId)();
        const created = Math.floor(Date.now() / 1000);
        const model = 'hermes';
        const full = await this.consumeGateway(req, true, (delta) => sse.write((0, sse_1.sseChunk)(completionId, model, created, delta)), (errMsg) => sse.write((0, sse_1.sseError)(errMsg)));
        sse.write((0, sse_1.sseDone)());
        return full;
    }
    async consumeGateway(req, stream, onDelta, onError) {
        const messages = this.resolveSessionMessages(req);
        const apiKey = readApiKey();
        if (!apiKey) {
            onError('Hermes gateway API key not found at ' + config_1.config.hermesApiKeyFile);
            return '';
        }
        let full = '';
        try {
            await new Promise((resolve, reject) => {
                const url = new URL(config_1.config.hermesGatewayUrl);
                const body = buildGatewayBody(messages, stream);
                const req2 = http.request({
                    hostname: url.hostname,
                    port: url.port || 80,
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                        Authorization: 'Bearer ' + apiKey,
                    },
                }, (res) => {
                    const code = res.statusCode || 0;
                    if (code !== 200) {
                        readAllText(res).then((txt) => reject(new Error(`Hermes gateway returned HTTP ${code}: ${txt}`)));
                        return;
                    }
                    res.setEncoding('utf-8');
                    let buffer = '';
                    res.on('data', (chunk) => {
                        buffer += chunk;
                        let idx;
                        while ((idx = buffer.indexOf('\n')) >= 0) {
                            const line = buffer.slice(0, idx).trim();
                            buffer = buffer.slice(idx + 1);
                            if (!line.startsWith('data:'))
                                continue;
                            const payload = line.slice(5).trim();
                            if (payload === '[DONE]') {
                                res.destroy();
                                resolve();
                                return;
                            }
                            const delta = (0, streamParser_1.extractDelta)(payload);
                            if (delta) {
                                full += delta;
                                onDelta(delta);
                            }
                        }
                    });
                    res.on('end', () => resolve());
                    res.on('error', (e) => reject(e));
                });
                req2.on('error', (e) => reject(e));
                req2.write(body);
                req2.end();
            });
        }
        catch (e) {
            logger_1.logger.warn('Hermes gateway error:', e?.message);
            if (full.length === 0)
                onError('Gateway error: ' + (e?.message || String(e)));
        }
        return full;
    }
    resolveSessionMessages(req) {
        const sessionId = req.sessionId;
        if (!sessionId)
            return req.messages || [];
        const hist = sessionHistories.get(sessionId) || [];
        if (req.messages && req.messages.length > 0)
            hist.push(...req.messages);
        sessionHistories.set(sessionId, hist);
        return hist;
    }
}
exports.HermesProcessWrapper = HermesProcessWrapper;
// ──────────── helpers ────────────
/** If a line is "session_id: ...", record it under the proxy session so the
 *  next request can --resume. Returns true if captured. */
function captureSessionId(line, proxySessionId) {
    if (process.env.AGENT_PROXY_DEBUG === '1') {
        process.stderr.write(`[hermes-wrapper] saw line: ${JSON.stringify(line)} sessionId=${proxySessionId}\n`);
    }
    const m = line.match(/^session_id:\s*(\S+)/);
    if (!m || !proxySessionId)
        return false;
    hermesSessionIds.set(proxySessionId, m[1]);
    logger_1.logger.info(`Captured hermes session_id=${m[1]} for proxy session ${proxySessionId}`);
    if (process.env.AGENT_PROXY_DEBUG === '1') {
        process.stderr.write(`[hermes-wrapper] map now has ${hermesSessionIds.size} entries\n`);
    }
    return true;
}
function readApiKey() {
    const raw = (0, utils_1.readFileOrNull)(config_1.config.hermesApiKeyFile);
    if (!raw)
        return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function buildGatewayBody(messages, stream) {
    const parts = [];
    for (const m of messages || []) {
        const role = m.role || 'user';
        const content = m.content || '';
        // reuse escapeJson for safe embedding
        const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        parts.push(`{"role":"${esc(role)}","content":"${esc(content)}"}`);
    }
    return `{"messages":[${parts.join(',')}],"stream":${stream}}`;
}
function readAllText(stream) {
    return new Promise((resolve) => {
        let buf = '';
        stream.setEncoding('utf-8');
        stream.on('data', (c) => (buf += c));
        stream.on('end', () => resolve(buf));
        stream.on('error', () => resolve(buf));
    });
}
function waitForExit(proc, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            resolve(-1);
        }, timeoutMs);
        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve(code ?? 0);
        });
        proc.on('error', () => {
            clearTimeout(timer);
            resolve(1);
        });
    });
}
//# sourceMappingURL=hermes.js.map