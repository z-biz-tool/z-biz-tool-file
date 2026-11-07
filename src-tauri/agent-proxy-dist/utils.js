"use strict";
// Small utilities: PATH augmentation, command resolution, JSON helpers.
// The Java version inlines all of this; we keep it in one place so the three
// wrappers can share.
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
exports.commonBinDirs = commonBinDirs;
exports.resolveCommand = resolveCommand;
exports.enhancedPath = enhancedPath;
exports.childProcessEnv = childProcessEnv;
exports.expandHome = expandHome;
exports.readFileOrNull = readFileOrNull;
exports.readAllText = readAllText;
exports.requestJson = requestJson;
exports.probeVersion = probeVersion;
exports.buildPrompt = buildPrompt;
exports.escapeJson = escapeJson;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const logger_1 = require("./logger");
/** Return the set of dirs we should look in for CLI binaries. */
function commonBinDirs() {
    const home = os.homedir();
    const dirs = [];
    // $PATH first (preserves user's actual order, including nvm/brew shims)
    const pathEnv = process.env.PATH || '';
    for (const dir of pathEnv.split(path.delimiter)) {
        if (dir && !dirs.includes(dir))
            dirs.push(dir);
    }
    // Common spots GUI-launched processes may not have in PATH
    const extras = [
        path.join(home, '.local/bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/bin',
        '/bin',
    ];
    for (const d of extras) {
        if (!dirs.includes(d))
            dirs.push(d);
    }
    // nvm-managed node bins (claude is an npm global)
    const nvmRoot = path.join(home, '.nvm/versions/node');
    if (fs.existsSync(nvmRoot)) {
        try {
            for (const v of fs.readdirSync(nvmRoot)) {
                const bin = path.join(nvmRoot, v, 'bin');
                if (fs.existsSync(bin) && !dirs.includes(bin))
                    dirs.push(bin);
            }
        }
        catch (e) {
            logger_1.logger.warn('Failed to scan nvm versions:', e);
        }
    }
    return dirs;
}
/** Resolve a bare command name to an absolute path, or return null. */
function resolveCommand(command) {
    if (!command)
        return null;
    if (command.startsWith('/') || command.startsWith('./') || command.startsWith('../')) {
        return fs.existsSync(command) ? command : null;
    }
    for (const dir of commonBinDirs()) {
        const candidate = path.join(dir, command);
        try {
            const st = fs.statSync(candidate);
            if (st.isFile() && (st.mode & 0o111) !== 0) {
                return candidate;
            }
        }
        catch {
            // missing — keep scanning
        }
    }
    return null;
}
/** Return an enhanced PATH string with common bin dirs prepended. */
function enhancedPath() {
    const current = process.env.PATH || '/usr/bin:/bin';
    const extras = [];
    for (const dir of commonBinDirs()) {
        if (!current.includes(dir))
            extras.push(dir);
    }
    return [...extras, current].join(path.delimiter);
}
/** Build env for a child process with PATH augmented. */
function childProcessEnv() {
    return { ...process.env, PATH: enhancedPath() };
}
/** Expand leading "~" to the user's home directory. */
function expandHome(p) {
    if (!p)
        return p ?? null;
    if (p === '~')
        return os.homedir();
    if (p.startsWith('~/'))
        return path.join(os.homedir(), p.slice(2));
    return p;
}
/** Read a file as utf-8; returns null on missing. */
function readFileOrNull(p) {
    try {
        return fs.readFileSync(p, 'utf-8');
    }
    catch {
        return null;
    }
}
/** Drain a Readable to a string (utf-8). */
function readAllText(stream) {
    return new Promise((resolve) => {
        let buf = '';
        stream.setEncoding('utf-8');
        stream.on('data', (c) => (buf += c));
        stream.on('end', () => resolve(buf));
        stream.on('error', () => resolve(buf));
    });
}
/**
 * Issue an HTTP request, return the parsed JSON body. Throws on non-2xx.
 * `method` is GET / POST. `body` is only used for POST.
 */
function requestJson(method, urlStr, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        // Lazy import to avoid pulling http into the bundle unnecessarily.
        const http = require('http');
        const url = new URL(urlStr);
        const payload = body ?? '';
        const req = http.request({
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname + url.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                ...extraHeaders,
            },
        }, (res) => {
            const code = res.statusCode || 0;
            if (code < 200 || code >= 300) {
                readAllText(res).then((txt) => reject(new Error(`HTTP ${code} from ${urlStr}: ${txt}`)));
                return;
            }
            readAllText(res).then((txt) => {
                try {
                    resolve(txt ? JSON.parse(txt) : null);
                }
                catch {
                    resolve(txt);
                }
            });
        });
        req.on('error', (e) => reject(e));
        if (payload)
            req.write(payload);
        req.end();
    });
}
/** Best-effort version probe via "<command> --version". */
async function probeVersion(cmd) {
    const { spawn } = await Promise.resolve().then(() => __importStar(require('child_process')));
    return new Promise((resolve) => {
        let out = '';
        let child;
        try {
            child = spawn(cmd, ['--version'], { env: childProcessEnv() });
        }
        catch {
            resolve(null);
            return;
        }
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve(out.trim() || null);
        }, 3000);
        child.stdout?.on('data', (b) => (out += b.toString()));
        child.stderr?.on('data', (b) => (out += b.toString()));
        child.on('error', () => {
            clearTimeout(timer);
            resolve(null);
        });
        child.on('close', () => {
            clearTimeout(timer);
            resolve(out.trim() || null);
        });
    });
}
/** Convert an array of ChatMessage to a single prompt string. */
function buildPrompt(messages) {
    if (!messages || messages.length === 0)
        return '';
    const parts = [];
    for (const m of messages) {
        if (!m || m.content == null)
            continue;
        const role = (m.role || 'user').toLowerCase();
        if (role === 'system')
            parts.push(`[System Instructions]\n${m.content}\n`);
        else if (role === 'assistant')
            parts.push(`[Assistant]\n${m.content}\n`);
        else
            parts.push(`[User]\n${m.content}\n`);
    }
    return parts.join('\n').trim();
}
/** Escape a string for safe inclusion in a JSON string literal. */
function escapeJson(value) {
    if (value == null)
        return '';
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}
//# sourceMappingURL=utils.js.map