"use strict";
// Read ~/.hermes/config.yaml to find the minimax (minimax) provider's api_key.
// The Java MinimaxConfigLoader does a line-based scan: it walks until it finds
// "- name: minimax", then reads the next api_key: line. We keep that simple
// shape — full YAML parsing would be overkill for a single field.
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
exports.getAnthropicBaseUrl = getAnthropicBaseUrl;
exports.getDefaultClaudeModel = getDefaultClaudeModel;
exports.loadMinimaxApiKey = loadMinimaxApiKey;
exports._resetMinimaxApiKeyCache = _resetMinimaxApiKeyCache;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const logger_1 = require("./logger");
const PROVIDER_NAME = 'minimax';
let cachedKey; // undefined == not loaded yet
function getAnthropicBaseUrl() {
    return 'https://api.minimaxi.com/anthropic';
}
function getDefaultClaudeModel() {
    return 'MiniMax-M3';
}
/** Return the minimax api key from ~/.hermes/config.yaml (cached). */
function loadMinimaxApiKey() {
    if (cachedKey !== undefined)
        return cachedKey;
    const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    if (!fs.existsSync(configPath)) {
        logger_1.logger.warn('hermes config not found:', configPath);
        cachedKey = null;
        return null;
    }
    try {
        const text = fs.readFileSync(configPath, 'utf-8');
        const lines = text.split(/\r?\n/);
        let inBlock = false;
        for (const raw of lines) {
            const line = raw.trim();
            if (line === `- name: ${PROVIDER_NAME}`) {
                inBlock = true;
                continue;
            }
            if (inBlock) {
                if (line.startsWith('- name:'))
                    break; // next provider, stop
                if (line.startsWith('api_key:')) {
                    const idx = line.indexOf(':');
                    const key = idx >= 0 ? line.slice(idx + 1).trim() : '';
                    if (key) {
                        cachedKey = key;
                        logger_1.logger.info('Loaded minimax api_key from hermes config:', key.slice(0, 15) + '...');
                        return key;
                    }
                }
            }
        }
    }
    catch (e) {
        logger_1.logger.warn('Failed to read hermes config.yaml:', e);
    }
    cachedKey = null;
    return null;
}
/** Force the cache to reload on the next call. Useful for tests. */
function _resetMinimaxApiKeyCache() {
    cachedKey = undefined;
}
//# sourceMappingURL=hermesConfig.js.map