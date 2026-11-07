"use strict";
// Session registry: maps sessionId -> { cliType, agentId }, persisted to
// sessions.json. Lets clients open a session once and route by session ID only.
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
exports.SessionRegistry = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const config_1 = require("./config");
const logger_1 = require("./logger");
const utils_1 = require("./utils");
class SessionRegistry {
    sessionCliTypes = new Map();
    sessionAgentIds = new Map();
    persistFile;
    constructor(persistDir = config_1.config.persistDir) {
        if (persistDir && persistDir.trim().length > 0) {
            const expanded = (0, utils_1.expandHome)(persistDir) || persistDir;
            this.persistFile = path.join(expanded, 'sessions.json');
            this.loadFromFile();
        }
        else {
            this.persistFile = null;
        }
    }
    openSession(cliType, agentId) {
        const sessionId = crypto.randomUUID();
        if (cliType)
            this.sessionCliTypes.set(sessionId, cliType);
        if (agentId)
            this.sessionAgentIds.set(sessionId, agentId);
        this.saveToFile();
        logger_1.logger.info(`Session opened: ${sessionId} cliType=${cliType || '-'} agentId=${agentId || '-'}`);
        return sessionId;
    }
    getCliType(sessionId) {
        if (!sessionId)
            return null;
        return this.sessionCliTypes.get(sessionId) || null;
    }
    getAgentId(sessionId) {
        if (!sessionId)
            return null;
        return this.sessionAgentIds.get(sessionId) || null;
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
                if (!obj || !obj.sessionId)
                    continue;
                if (obj.cliType)
                    this.sessionCliTypes.set(obj.sessionId, obj.cliType);
                if (obj.agentId)
                    this.sessionAgentIds.set(obj.sessionId, obj.agentId);
            }
            logger_1.logger.info(`Loaded ${this.sessionCliTypes.size} sessions from ${this.persistFile}`);
        }
        catch (e) {
            logger_1.logger.warn(`Failed to load sessions from ${this.persistFile}:`, e);
        }
    }
    saveToFile() {
        if (!this.persistFile)
            return;
        try {
            const dir = path.dirname(this.persistFile);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const ids = new Set([
                ...this.sessionCliTypes.keys(),
                ...this.sessionAgentIds.keys(),
            ]);
            const arr = [];
            for (const id of ids) {
                arr.push({
                    sessionId: id,
                    cliType: this.sessionCliTypes.get(id) || null,
                    agentId: this.sessionAgentIds.get(id) || null,
                    createdAt: Date.now(),
                });
            }
            fs.writeFileSync(this.persistFile, JSON.stringify(arr, null, 2));
        }
        catch (e) {
            logger_1.logger.warn(`Failed to save sessions to ${this.persistFile}:`, e);
        }
    }
}
exports.SessionRegistry = SessionRegistry;
//# sourceMappingURL=sessionRegistry.js.map