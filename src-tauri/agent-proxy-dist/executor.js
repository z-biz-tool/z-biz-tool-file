"use strict";
// CliChatExecutor: dispatches to the right wrapper. Mirrors Java's executor
// (which prefers the registry over a fallback spawn path). We keep the fallback
// so a future unknown CLI type can still be spawned generically.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CliChatExecutor = void 0;
const child_process_1 = require("child_process");
const logger_1 = require("./logger");
const config_1 = require("./config");
const utils_1 = require("./utils");
const streamParser_1 = require("./streamParser");
const sse_1 = require("./sse");
class CliChatExecutor {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    async executeStream(cfg, req, sse) {
        const w = this.registry.get(cfg.type);
        if (w) {
            logger_1.logger.info(`Delegating stream to ${w.constructor.name} for type=${cfg.type}`);
            return w.streamChat(cfg, req, sse);
        }
        logger_1.logger.info(`No wrapper for type=${cfg.type}, fallback to spawn`);
        return this.fallbackStream(cfg, req, sse);
    }
    async executeSync(cfg, req) {
        const w = this.registry.get(cfg.type);
        if (w) {
            logger_1.logger.info(`Delegating sync to ${w.constructor.name} for type=${cfg.type}`);
            return w.syncChat(cfg, req);
        }
        logger_1.logger.info(`No wrapper for type=${cfg.type}, fallback to spawn`);
        return this.fallbackSync(cfg, req);
    }
    // ──────────── generic subprocess fallback (for unknown types) ────────────
    async fallbackStream(cfg, req, sse) {
        const prompt = (0, utils_1.buildPrompt)(req.messages);
        const completionId = (0, sse_1.newCompletionId)();
        const created = Math.floor(Date.now() / 1000);
        const model = cfg.type;
        const proc = this.spawnProcess(cfg, prompt);
        let full = '';
        proc.stdout.on('data', (b) => {
            for (const line of b.toString('utf-8').split(/\r?\n/)) {
                const delta = (0, streamParser_1.extractDelta)(line);
                if (delta) {
                    full += delta;
                    sse.write((0, sse_1.sseChunk)(completionId, model, created, delta));
                }
            }
        });
        let stderr = '';
        proc.stderr.on('data', (b) => (stderr += b.toString()));
        const code = await waitForExit(proc, config_1.config.processTimeoutMs);
        if (code === -1) {
            sse.write((0, sse_1.sseError)(`CLI process timeout after ${config_1.config.processTimeoutMs / 1000}s`));
        }
        else if (code !== 0 && full.length === 0) {
            sse.write((0, sse_1.sseError)(`CLI process exited with code ${code}: ${stderr.trim()}`));
        }
        sse.write((0, sse_1.sseDone)());
        return full;
    }
    async fallbackSync(cfg, req) {
        const prompt = (0, utils_1.buildPrompt)(req.messages);
        const proc = this.spawnProcess(cfg, prompt);
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
        const code = await waitForExit(proc, config_1.config.processTimeoutMs);
        if (code === -1)
            throw new Error('CLI process timeout');
        if (code !== 0 && full.length === 0) {
            throw new Error(`CLI process exited with code ${code}: ${stderr.trim()}`);
        }
        return full;
    }
    spawnProcess(cfg, prompt) {
        const resolved = (0, utils_1.resolveCommand)(cfg.command) || cfg.command;
        const args = (cfg.args || []).map((a) => a.replace(/\{prompt\}/g, prompt));
        const env = (0, utils_1.childProcessEnv)();
        const cwd = cfg.workingDir ? (0, utils_1.expandHome)(cfg.workingDir) : process.cwd();
        logger_1.logger.info(`Spawning CLI agent (fallback): command=${resolved} args=${JSON.stringify(args)} type=${cfg.type}`);
        return (0, child_process_1.spawn)(resolved, args, {
            env,
            cwd: cwd || process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
}
exports.CliChatExecutor = CliChatExecutor;
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
//# sourceMappingURL=executor.js.map