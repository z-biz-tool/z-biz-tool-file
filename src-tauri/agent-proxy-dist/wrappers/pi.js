"use strict";
// Pi wrapper: runs the bundled Pi CLI in one-shot (`-p`) mode, with the agent's
// working directory rooted at the task's workspace folder.
//
// Pi (`@earendil-works/pi-coding-agent`) is a minimal terminal coding agent with
// read / write / edit / bash tools. It loads AGENTS.md / CLAUDE.md from the
// working directory as project context — which is exactly what "工作事项绑定一个
// 文件夹、AI 感知该文件夹上下文来写作" needs.
//
// We drive it in `-p` (single-prompt, non-interactive) mode so each proxy turn
// maps to one `pi -p "<prompt>"` invocation rooted at `cfg.workingDir` (the
// task's folder). The bundled Pi CLI never needs the user to have node/npm or
// to install anything — it runs on the bundled node under Resources/runtime.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PiWrapper = void 0;
const child_process_1 = require("child_process");
const logger_1 = require("../logger");
const utils_1 = require("../utils");
const sse_1 = require("../sse");

/** Resolve where the bundled Pi CLI lives (relative to this proxy's own file). */
function bundledPiCli() {
    // this file: runtime/agent-proxy/dist/wrappers/pi.js
    // Pi at:      runtime/lib/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
    const path = require("path");
    const here = __dirname; // .../runtime/agent-proxy/dist/wrappers
    const runtime = path.resolve(here, "..", "..", ".."); // .../runtime
    const cli = path.join(runtime, "lib", "pi", "node_modules",
        "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    return require("fs").existsSync(cli) ? cli : null;
}

/** Resolve the bundled node executable (runtime/bin/node). */
function bundledNode() {
    const path = require("path");
    const here = __dirname;
    const runtime = path.resolve(here, "..", "..", "..");
    const node = process.platform === "win32"
        ? path.join(runtime, "bin", "node.exe")
        : path.join(runtime, "bin", "node");
    return require("fs").existsSync(node) ? node : null;
}

class PiWrapper {
    supports(type) {
        return type === 'pi';
    }

    _workingDir(cfg) {
        if (cfg.workingDir) return (0, utils_1.expandHome)(cfg.workingDir);
        return process.cwd();
    }

    _piCommand() {
        // Prefer bundled CLI; fall back to a `pi` on PATH (dev without runtime).
        const cli = bundledPiCli();
        if (cli) {
            const nodeBin = bundledNode();
            return nodeBin ? { cmd: nodeBin, args: [cli] } : null;
        }
        return { cmd: 'pi', args: [] };
    }

    _spawn(cfg, prompt, sessionId) {
        const pi = this._piCommand();
        if (!pi) throw new Error('bundled Pi runtime not found under Resources/runtime');
        const workingDir = this._workingDir(cfg);
        // `-p` one-shot：每个工作事项是一次独立的 Pi 任务，始终单发。
        // 注意不带 `--output-format`——那是 Claude 的 flag，Pi 不认。
        const args = [...pi.args, '-p', prompt];
        logger_1.logger.info(`[pi] spawn in ${workingDir}: ${pi.cmd} ${args.join(' ')}`);
        const env = { ...(0, utils_1.childProcessEnv)() };
        // Isolate Pi's own state (~/.pi) into the workspace so multiple tasks
        // don't fight over one trust/auth file, and the sandbox-homed dir is writable.
        // file 统一 AI 配置 → Pi 的 LLM 接入：
        // Rust 层把 provider 映射成 Pi 认的 *_API_KEY env 名（如 DEEPSEEK_API_KEY），
        // 连 key 一起经 chat.js 的 header 传进 cfg.llmKeyEnv/llmKey。
        // 这里设成环境变量，Pi 认证就用这份配置，而不是它自己保存的登录态 ——
        // 这正是「AI 配置板块能控制 Pi 的 LLM 接入」。
        const llmKeyEnv = cfg && cfg.llmKeyEnv;
        const llmKey2 = cfg && cfg.llmKey;
        if (llmKeyEnv && llmKey2) {
            env[llmKeyEnv] = llmKey2;
            logger_1.logger.info(`[pi] LLM 凭据来自 file 统一配置: ${llmKeyEnv} (provider key)`);
        }
        env.PI_HOME = require('path').join(workingDir, '.pi');
        env.HOME = workingDir;
        return (0, child_process_1.spawn)(pi.cmd, args, {
            env,
            cwd: workingDir,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }

    async streamChat(cfg, req, sse) {
        const completionId = (0, sse_1.newCompletionId)();
        const created = Math.floor(Date.now() / 1000);
        const model = cfg.type || 'pi';
        const prompt = (0, utils_1.buildPrompt)(req.messages);
        let full = '';
        let errored = false;
        try {
            const proc = this._spawn(cfg, prompt, req.sessionId);
            proc.stdout.on('data', (b) => {
                const text = b.toString('utf-8');
                full += text;
                for (const line of text.split(/\r?\n/)) {
                    if (line.length) sse.write((0, sse_1.sseChunk)(completionId, model, created, line + '\n'));
                }
            });
            let stderr = '';
            proc.stderr.on('data', (b) => (stderr += b.toString()));
            const code = await new Promise((resolve) => {
                const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(-1); }, 5 * 60 * 1000);
                proc.on('close', (c) => { clearTimeout(timer); resolve(c ?? 0); });
                proc.on('error', (e) => { clearTimeout(timer); logger_1.logger.warn('[pi] proc error', e?.message); resolve(1); });
            });
            if (code === -1) { sse.write((0, sse_1.sseError)('Pi process timeout')); errored = true; }
            else if (code !== 0 && full.length === 0) {
                sse.write((0, sse_1.sseError)(`Pi exited ${code}: ${stderr.trim()}`)); errored = true;
            }
        } catch (e) {
            errored = true;
            if (full.length === 0) sse.write((0, sse_1.sseError)('Pi error: ' + (e?.message || String(e))));
        }
        if (!errored) sse.write((0, sse_1.sseDone)());
        return full;
    }

    async syncChat(cfg, req) {
        const prompt = (0, utils_1.buildPrompt)(req.messages);
        let full = '';
        let stderr = '';
        const proc = this._spawn(cfg, prompt, req.sessionId);
        for await (const b of proc.stdout) full += b.toString('utf-8');
        for await (const b of proc.stderr) stderr += b.toString('utf-8');
        const code = await new Promise((resolve) => {
            proc.on('close', (c) => resolve(c ?? 0));
            proc.on('error', () => resolve(1));
        });
        if (code !== 0 && full.length === 0) throw new Error(`Pi exited ${code}: ${stderr.trim()}`);
        return full;
    }
}
exports.PiWrapper = PiWrapper;
//# sourceMappingURL=pi.js.map