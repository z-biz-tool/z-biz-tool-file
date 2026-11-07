"use strict";
// POST /v1/session/open — bind a session to a CLI type / agent. Subsequent
// chat requests can route by session ID only.
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeSessionHandler = makeSessionHandler;
const common_1 = require("./common");
function makeSessionHandler(sessionRegistry) {
    return async function handle(req, res) {
        if ((0, common_1.handleCors)(req, res))
            return;
        if (req.method !== 'POST') {
            (0, common_1.sendError)(res, 405, `Method not allowed: ${req.method}`);
            return;
        }
        let cliType = null;
        let agentId = null;
        const body = await (0, common_1.readBody)(req);
        if (body && body.trim().length > 0) {
            try {
                const parsed = JSON.parse(body);
                if (typeof parsed?.cliType === 'string')
                    cliType = parsed.cliType;
                if (typeof parsed?.agentId === 'string')
                    agentId = parsed.agentId;
            }
            catch {
                // ignore — body is optional
            }
        }
        const sessionId = sessionRegistry.openSession(cliType, agentId);
        (0, common_1.sendJson)(res, 200, { sessionId, cliType: cliType || undefined });
    };
}
//# sourceMappingURL=session.js.map