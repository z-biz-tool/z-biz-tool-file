"use strict";
// GET /health — minimal liveness probe.
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleHealth = handleHealth;
const common_1 = require("./common");
function handleHealth(req, res) {
    (0, common_1.setCors)(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    (0, common_1.sendJson)(res, 200, { status: 'ok' });
}
//# sourceMappingURL=health.js.map