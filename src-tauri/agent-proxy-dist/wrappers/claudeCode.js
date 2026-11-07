"use strict";
// Claude Code wrapper: spawn `claude` per request with stream-json output, then
// read & parse stdout line-by-line into SSE deltas. Injects the minimax
// anthropic-compatible base URL + api key from ~/.hermes/config.yaml so the
// child process doesn't need its own /login.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaudeCodeWrapper = void 0;
const child_process_1 = require("child_process");
const logger_1 = require("../logger");
const config_1 = require("../config");
const utils_1 = require("../utils");
const hermesConfig_1 = require("../hermesConfig");
const streamParser_1 = require("../streamParser");
const sse_1 = require("../sse");
/** Map of session IDs that have already been started; used to switch between
 *  --session-id (first request) and --resume (subsequent). */
const activeSessions = new Set();
class ClaudeCodeWrapper {
    supports(type) {
        return type === 'claude-code';
    }
    async streamChat(cfg, req, sse) {
        const prompt = (0, utils_1.buildPrompt)(req.messages);
        const completionId = (0, sse_1.newCompletionId)();
        const created = Math.floor(Date.now() / 1000);
        const model = cfg.type;
        let full = '';
        const proc = this.spawnProcess(cfg, prompt, req.sessionId);
        const onData = (chunk) => {
            const text = chunk.toString('utf-8');
            for (const line of text.split(/\r?\n/)) {
                const delta = (0, streamParser_1.extractDelta)(line);
                if (delta != null && delta.length > 0) {
                    full += delta;
                    sse.write((0, sse_1.sseChunk)(completionId, model, created, delta));
                }
            }
        };
        proc.stdout.on('data', onData);
        let stderr = '';
        proc.stderr.on('data', (b) => (stderr += b.toString()));
        const exitCode = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                logger_1.logger.warn(`Claude Code timeout after ${config_1.config.processTimeoutMs}ms, killing`);
                proc.kill('SIGKILL');
                resolve(-1);
            }, config_1.config.processTimeoutMs);
            proc.on('close', (code) => {
                clearTimeout(timer);
                resolve(code);
            });
            proc.on('error', (err) => {
                clearTimeout(timer);
                logger_1.logger.warn('Claude Code process error:', err);
                resolve(1);
            });
        });
        if (exitCode !== 0 && exitCode !== -1) {
            logger_1.logger.warn(`Claude Code exited with code ${exitCode}: ${stderr.trim()}`);
            if (full.length === 0) {
                sse.write((0, sse_1.sseError)(`Claude Code exited with code ${exitCode}: ${stderr.trim()}`));
            }
        }
        else if (exitCode === -1) {
            sse.write((0, sse_1.sseError)('Claude Code process timeout'));
        }
        sse.write((0, sse_1.sseDone)());
        return full;
    }
    async syncChat(cfg, req) {
        const prompt = (0, utils_1.buildPrompt)(req.messages);
        const proc = this.spawnProcess(cfg, prompt, req.sessionId);
        let full = '';
        let stderr = '';
        proc.stdout.on('data', (b) => {
            for (const line of b.toString('utf-8').split(/\r?\n/)) {
                const delta = (0, streamParser_1.extractDelta)(line);
                if (delta)
                    full += delta;
            }
        });
        proc.stderr.on('data', (b) => (stderr += b.toString()));
        const exitCode = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                proc.kill('SIGKILL');
                resolve(-1);
            }, config_1.config.processTimeoutMs);
            proc.on('close', (code) => {
                clearTimeout(timer);
                resolve(code);
            });
            proc.on('error', () => {
                clearTimeout(timer);
                resolve(1);
            });
        });
        if (exitCode !== 0 && full.length === 0) {
            throw new Error(`Claude Code exited with code ${exitCode}: ${stderr.trim()}`);
        }
        if (exitCode === -1)
            throw new Error('Claude Code process timeout');
        return full;
    }
    // ──────────── internals ────────────
    spawnProcess(cfg, prompt, sessionId) {
        const resolved = (0, utils_1.resolveCommand)(cfg.command) || cfg.command;
        const baseArgs = this.resolveArgs(cfg, prompt);
        // Track which flags the user already supplied so we don't double-add.
        let hasModel = false;
        let hasIncludePartial = false;
        for (const a of baseArgs) {
            if (a === '--model')
                hasModel = true;
            if (a === '--include-partial-messages')
                hasIncludePartial = true;
        }
        const args = [...baseArgs];
        if (!hasModel) {
            args.push('--model', (0, hermesConfig_1.getDefaultClaudeModel)());
        }
        if (!hasIncludePartial) {
            // Real streaming requires this flag; without it, claude prints one
            // complete assistant message and we lose delta-level granularity.
            args.push('--include-partial-messages');
        }
        if (sessionId) {
            if (activeSessions.has(sessionId)) {
                args.push('--resume', sessionId);
                logger_1.logger.info(`Injected --resume=${sessionId} (resuming session)`);
            }
            else {
                activeSessions.add(sessionId);
                args.push('--session-id', sessionId);
                logger_1.logger.info(`Injected --session-id=${sessionId} (new session)`);
            }
        }
        const env = (0, utils_1.childProcessEnv)();
        const apiKey = (0, hermesConfig_1.loadMinimaxApiKey)();
        if (apiKey) {
            env.ANTHROPIC_BASE_URL = (0, hermesConfig_1.getAnthropicBaseUrl)();
            env.ANTHROPIC_API_KEY = apiKey;
            logger_1.logger.info(`Injected ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL} ANTHROPIC_API_KEY=${apiKey.slice(0, 15)}...`);
        }
        else {
            logger_1.logger.warn('minimax api key not found in ~/.hermes/config.yaml; claude code may fail without /login');
        }
        logger_1.logger.info(`Spawning Claude Code: command=${resolved} args=${JSON.stringify(args)}`);
        const cwd = cfg.workingDir ? (0, utils_1.expandHome)(cfg.workingDir) : undefined;
        return (0, child_process_1.spawn)(resolved, args, {
            env,
            cwd: cwd || process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    resolveArgs(cfg, prompt) {
        return (cfg.args || []).map((a) => a.replace(/\{prompt\}/g, prompt));
    }
}
exports.ClaudeCodeWrapper = ClaudeCodeWrapper;
//# sourceMappingURL=claudeCode.js.map