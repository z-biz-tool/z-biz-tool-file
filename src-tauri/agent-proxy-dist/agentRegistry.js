"use strict";
// Persistent CLI agent registry: maps agentId -> CliAgentConfig, backed by a
// JSON file on disk. Mirrors Java CliAgentRegistry but kept minimal — we only
// need register/list/get/remove for the proxy to work.
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
exports.AgentRegistry = void 0;
exports.defaultArgs = defaultArgs;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("./config");
const logger_1 = require("./logger");
const utils_1 = require("./utils");
class AgentRegistry {
    agents = new Map();
    persistFile;
    constructor(persistDir = config_1.config.persistDir) {
        if (persistDir && persistDir.trim().length > 0) {
            const expanded = (0, utils_1.expandHome)(persistDir) || persistDir;
            this.persistFile = path.join(expanded, 'cli-agents.json');
            this.loadFromFile();
        }
        else {
            this.persistFile = null;
        }
    }
    /** Register a new agent. Returns the stored config. */
    register(name, type, command, args, workingDir) {
        const id = `${type}-${randomId()}`;
        const cfg = {
            id,
            name: name || type,
            type,
            command: command || defaultCommand(type),
            args: args && args.length > 0 ? [...args] : defaultArgs(type),
            workingDir: workingDir ? (0, utils_1.expandHome)(workingDir) : null,
        };
        this.agents.set(id, cfg);
        this.saveToFile();
        logger_1.logger.info(`Registered CLI agent: id=${id} name=${name} type=${type} command=${cfg.command}`);
        return cfg;
    }
    get(id) {
        return this.agents.get(id);
    }
    remove(id) {
        const removed = this.agents.delete(id);
        if (removed) {
            this.saveToFile();
            logger_1.logger.info(`Removed CLI agent: id=${id}`);
        }
        return removed;
    }
    list() {
        return Array.from(this.agents.values());
    }
    /** Convenience: find a registered agent by type (first match). */
    findByType(type) {
        for (const cfg of this.agents.values()) {
            if (cfg.type === type)
                return cfg;
        }
        return null;
    }
    // ──────────── persistence ────────────
    loadFromFile() {
        if (!this.persistFile || !fs.existsSync(this.persistFile))
            return;
        try {
            const raw = fs.readFileSync(this.persistFile, 'utf-8');
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr))
                return;
            for (const obj of arr) {
                if (!obj || typeof obj !== 'object')
                    continue;
                const cfg = {
                    id: String(obj.id),
                    name: String(obj.name || obj.type || 'agent'),
                    type: String(obj.type),
                    command: String(obj.command || defaultCommand(obj.type)),
                    args: Array.isArray(obj.args) ? obj.args.map(String) : defaultArgs(obj.type),
                    workingDir: obj.workingDir || null,
                };
                if (cfg.id && cfg.type)
                    this.agents.set(cfg.id, cfg);
            }
            logger_1.logger.info(`Loaded ${this.agents.size} CLI agents from ${this.persistFile}`);
        }
        catch (e) {
            logger_1.logger.warn(`Failed to load CLI agents from ${this.persistFile}:`, e);
        }
    }
    saveToFile() {
        if (!this.persistFile)
            return;
        try {
            const dir = path.dirname(this.persistFile);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const arr = Array.from(this.agents.values()).map((cfg) => ({
                id: cfg.id,
                name: cfg.name,
                type: cfg.type,
                command: cfg.command,
                args: cfg.args,
                workingDir: cfg.workingDir,
            }));
            fs.writeFileSync(this.persistFile, JSON.stringify(arr, null, 2));
        }
        catch (e) {
            logger_1.logger.warn(`Failed to save CLI agents to ${this.persistFile}:`, e);
        }
    }
}
exports.AgentRegistry = AgentRegistry;
function defaultCommand(type) {
    if (type === 'claude-code')
        return 'claude';
    if (type === 'hermes')
        return 'hermes';
    if (type === 'opencode')
        return 'opencode';
    return '';
}
function defaultArgs(type) {
    if (type === 'claude-code') {
        return [
            '-p', '{prompt}',
            '--output-format', 'stream-json',
            '--verbose',
            '--include-partial-messages',
        ];
    }
    if (type === 'hermes')
        return ['chat', '-q', '{prompt}', '-Q'];
    if (type === 'opencode')
        return ['run', '{prompt}'];
    return [];
}
function randomId() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-6);
}
//# sourceMappingURL=agentRegistry.js.map