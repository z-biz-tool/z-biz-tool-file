"use strict";
// Centralized config: port, persistence dir, gateway URLs, command defaults.
// Mirrors the Java ProxyApplication defaults; lives at the top so every module
// can import a single source of truth.
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
exports.config = void 0;
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const DEFAULT_PORT = 9099;
const DEFAULT_PERSIST_DIR = path.join(os.homedir(), '.future-team');
const HERMES_GATEWAY_URL = 'http://127.0.0.1:8642/v1/chat/completions';
const OPENCODE_SERVER_URL = 'http://127.0.0.1:8643';
const HERMES_API_KEY_FILE = '/tmp/hermes_api_key.txt';
const ANTHROPIC_BASE_URL = 'https://api.minimaxi.com/anthropic';
const DEFAULT_CLAUDE_MODEL = 'MiniMax-M3';
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
function parsePort() {
    const flag = process.argv.find((a) => a === '--port' || a.startsWith('--port='));
    if (!flag)
        return DEFAULT_PORT;
    const val = flag.includes('=') ? flag.split('=')[1] : process.argv[process.argv.indexOf(flag) + 1];
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}
function parsePersistDir() {
    const flag = process.argv.find((a) => a === '--persist-dir' || a.startsWith('--persist-dir='));
    if (!flag)
        return DEFAULT_PERSIST_DIR;
    const val = flag.includes('=') ? flag.split('=')[1] : process.argv[process.argv.indexOf(flag) + 1];
    return val && val.trim().length > 0 ? expandHome(val) : DEFAULT_PERSIST_DIR;
}
function expandHome(p) {
    if (p.startsWith('~'))
        return path.join(os.homedir(), p.slice(1));
    return p;
}
exports.config = {
    host: '127.0.0.1',
    port: parsePort(),
    persistDir: parsePersistDir(),
    sessionPersistFile: path.join(parsePersistDir(), 'sessions.json'),
    agentsPersistFile: path.join(parsePersistDir(), 'cli-agents.json'),
    hermesGatewayUrl: HERMES_GATEWAY_URL,
    hermesApiKeyFile: HERMES_API_KEY_FILE,
    opencodeServerUrl: OPENCODE_SERVER_URL,
    processTimeoutMs: PROCESS_TIMEOUT_MS,
    anthropicBaseUrl: ANTHROPIC_BASE_URL,
    defaultClaudeModel: DEFAULT_CLAUDE_MODEL,
};
//# sourceMappingURL=config.js.map