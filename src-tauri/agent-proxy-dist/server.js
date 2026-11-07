"use strict";
// HTTP server using Node's built-in http. Routes by path prefix.
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
exports.createServer = createServer;
const http = __importStar(require("http"));
const logger_1 = require("./logger");
const health_1 = require("./handlers/health");
const cliList_1 = require("./handlers/cliList");
const session_1 = require("./handlers/session");
const chat_1 = require("./handlers/chat");
const common_1 = require("./handlers/common");
function createServer(deps) {
    const handlers = {
        health: health_1.handleHealth,
        cliList: (0, cliList_1.makeCliListHandler)(deps.agentRegistry),
        session: (0, session_1.makeSessionHandler)(deps.sessionRegistry),
        chat: (0, chat_1.makeChatHandler)(deps.agentRegistry, deps.executor, deps.sessionRegistry),
    };
    return http.createServer(async (req, res) => {
        const url = req.url || '/';
        const path = url.split('?')[0];
        try {
            if (path === '/health')
                return handlers.health(req, res);
            if (path === '/v1/cli-agents')
                return handlers.cliList(req, res);
            if (path === '/v1/session/open')
                return handlers.session(req, res);
            if (path === '/v1/chat/completions')
                return handlers.chat(req, res);
            if (path === '/' || path === '') {
                (0, common_1.setCors)(res);
                return (0, common_1.sendError)(res, 200, {
                    service: 'agent-proxy',
                    endpoints: [
                        'GET  /v1/cli-agents',
                        'POST /v1/session/open',
                        'POST /v1/chat/completions',
                        'GET  /health',
                    ],
                });
            }
            (0, common_1.setCors)(res);
            (0, common_1.sendError)(res, 404, `not found: ${path}`);
        }
        catch (e) {
            logger_1.logger.error('Unhandled error in route', path, ':', e);
            try {
                if (!res.headersSent)
                    (0, common_1.sendError)(res, 500, e?.message || 'internal error');
                else
                    res.end();
            }
            catch {
                // ignore
            }
        }
    });
}
//# sourceMappingURL=server.js.map