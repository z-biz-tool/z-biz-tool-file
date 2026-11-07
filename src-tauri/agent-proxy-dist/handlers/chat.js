"use strict";
// POST /v1/chat/completions — OpenAI-compatible chat. Routes to one of the
// registered wrappers based on session / header / model inference, then
// streams SSE or returns JSON.
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
exports.makeChatHandler = makeChatHandler;
const crypto = __importStar(require("crypto"));
const logger_1 = require("../logger");
const sse_1 = require("../sse");
const common_1 = require("./common");
const types_1 = require("../wrappers/types");
const DEFAULT_TYPE = 'claude-code';
function makeChatHandler(registry, executor, sessionRegistry) {
    return async function handle(req, res) {
        if ((0, common_1.handleCors)(req, res))
            return;
        if (req.method !== 'POST') {
            (0, common_1.sendError)(res, 405, `Method not allowed: ${req.method}`);
            return;
        }
        let body;
        try {
            const raw = await (0, common_1.readBody)(req);
            body = raw ? JSON.parse(raw) : {};
        }
        catch (e) {
            (0, common_1.sendError)(res, 400, 'invalid JSON body: ' + (e?.message || String(e)));
            return;
        }
        if (!body.messages || body.messages.length === 0) {
            (0, common_1.sendError)(res, 400, 'messages is required');
            return;
        }
        // Session id: header first, otherwise generate
        let sessionId = (0, common_1.headerString)(req, 'x-session-id') || (0, common_1.headerString)(req, 'X-Session-Id');
        if (!sessionId) {
            sessionId = crypto.randomUUID();
            logger_1.logger.info(`Generated new session: ${sessionId}`);
        }
        body.sessionId = sessionId;
        const cfg = resolveConfig(req, body, registry, sessionRegistry);
        // 工作区目录：请求可带 `X-Working-Dir` header，覆盖 cfg.workingDir ——
        // Pi 等 wrapper 用这个作为工作目录（读取上下文、写回产出）。
        // 相当于每个工作事项能指定自己的写作文件夹（见 worker 的 workspace.rs）。
        const wd = (0, common_1.headerString)(req, 'x-working-dir');
        if (wd && wd.trim().length > 0) {
            cfg.workingDir = wd.trim();
        }
        // Pi 的 LLM 接入（file 统一 AI 配置 → Pi 认的环境变量）：
        // Rust 侧读统一配置后把 provider 映射成 env 名 + key 走 header 传进来，
        // 这里挂到 cfg 上给 Pi wrapper spawn pi 时设环境变量。
        const llmKeyEnv = (0, common_1.headerString)(req, 'x-llm-key-env');
        const llmKey = (0, common_1.headerString)(req, 'x-llm-key');
        const llmModel = (0, common_1.headerString)(req, 'x-llm-model');
        if (llmKeyEnv && llmKey) {
            cfg.llmKeyEnv = llmKeyEnv.trim();
            cfg.llmKey = llmKey.trim();
            cfg.llmModel = (llmModel || '').trim();
        }
        logger_1.logger.info(`Routing to CLI: type=${cfg.type} command=${cfg.command} stream=${!!body.stream} session=${sessionId} wd=${wd || ''} llmEnv=${cfg.llmKeyEnv || ''}`);
        if (body.stream) {
            // SSE response. We need to flush headers first.
            (0, common_1.setCors)(res);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Session-Id', sessionId);
            res.writeHead(200);
            const writer = new types_1.HttpSseWriter(res);
            try {
                await executor.executeStream(cfg, body, writer);
            }
            catch (e) {
                logger_1.logger.warn('Stream execution error:', e);
                res.write((0, sse_1.sseError)('Execution error: ' + (e?.message || String(e))));
            }
            finally {
                res.end();
            }
        }
        else {
            try {
                const reply = await executor.executeSync(cfg, body);
                (0, common_1.setCors)(res);
                res.setHeader('X-Session-Id', sessionId);
                const json = (0, sse_1.buildChatCompletionSyncResponse)(cfg.type, reply);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(json);
            }
            catch (e) {
                logger_1.logger.warn('Sync execution error:', e);
                (0, common_1.sendError)(res, 500, 'Execution error: ' + (e?.message || String(e)));
            }
        }
    };
}
// ──────────── routing helpers ────────────
/** Three-level priority: session-bound agentId -> session-bound cliType ->
 *  X-Agent-Id header -> X-CLI-Type / model inference -> default config. */
function resolveConfig(req, body, registry, sessionRegistry) {
    const sessionId = body.sessionId || null;
    // 1. session-bound agentId
    if (sessionId) {
        const boundAgentId = sessionRegistry.getAgentId(sessionId);
        if (boundAgentId) {
            const cfg = registry.get(boundAgentId);
            if (cfg) {
                logger_1.logger.info(`Resolved by session-bound agentId: ${boundAgentId}`);
                return cfg;
            }
            logger_1.logger.warn(`Session-bound agentId not found in registry: ${boundAgentId}`);
        }
    }
    // 2. session-bound cliType
    if (sessionId) {
        const boundType = sessionRegistry.getCliType(sessionId);
        if (boundType) {
            const cfg = registry.findByType(boundType);
            if (cfg) {
                logger_1.logger.info(`Resolved by session-bound cliType: ${boundType}`);
                return cfg;
            }
            logger_1.logger.info(`Session-bound cliType=${boundType} not in registry, using default config`);
            return buildDefaultConfig(boundType);
        }
    }
    // 3. X-Agent-Id header
    const agentId = (0, common_1.headerString)(req, 'x-agent-id');
    if (agentId) {
        const cfg = registry.get(agentId);
        if (cfg) {
            logger_1.logger.info(`Resolved by X-Agent-Id: ${agentId}`);
            return cfg;
        }
        logger_1.logger.warn(`X-Agent-Id not found in registry: ${agentId}, falling through`);
    }
    // 4. X-CLI-Type or model-field inference
    const type = inferType(req, body);
    const byType = registry.findByType(type);
    if (byType) {
        logger_1.logger.info(`Resolved by type from registry: ${type}`);
        return byType;
    }
    logger_1.logger.info(`No registered agent for type=${type}, using default config`);
    return buildDefaultConfig(type);
}
function inferType(req, body) {
    const cliType = (0, common_1.headerString)(req, 'x-cli-type');
    if (cliType) {
        logger_1.logger.info(`Inferred type from X-CLI-Type: ${cliType}`);
        return cliType;
    }
    const model = (body.model || '').toLowerCase();
    if (model) {
        if (model.includes('hermes'))
            return 'hermes';
        if (model.includes('opencode'))
            return 'opencode';
        if (model.includes('claude'))
            return 'claude-code';
    }
    return DEFAULT_TYPE;
}
function buildDefaultConfig(type) {
    let command = type;
    let args = [];
    if (type === 'claude-code') {
        command = 'claude';
        args = [
            '-p', '{prompt}',
            '--output-format', 'stream-json',
            '--verbose',
            '--include-partial-messages',
        ];
    }
    else if (type === 'hermes') {
        command = 'hermes';
        args = ['chat', '-q', '{prompt}', '-Q'];
    }
    else if (type === 'opencode') {
        command = 'opencode';
        args = ['run', '{prompt}'];
    }
    else if (type === 'pi') {
        command = 'pi';
        args = ['-p', '{prompt}'];
    }
    return {
        id: `default-${type}`,
        name: `default-${type}`,
        type,
        command,
        args,
        workingDir: null,
    };
}
//# sourceMappingURL=chat.js.map