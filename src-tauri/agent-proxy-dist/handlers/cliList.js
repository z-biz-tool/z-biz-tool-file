"use strict";
// GET /v1/cli-agents — list discovered CLIs (real-time PATH scan + registry
// join). Mirrors Java ProxyCliListHandler.
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeCliListHandler = makeCliListHandler;
const discovery_1 = require("../discovery");
const common_1 = require("./common");
function makeCliListHandler(registry) {
    return async function handle(req, res) {
        (0, common_1.setCors)(res);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method !== 'GET') {
            (0, common_1.sendError)(res, 405, `Method not allowed: ${req.method}`);
            return;
        }
        const found = await (0, discovery_1.discover)();
        const agents = found.map((cli) => {
            const registered = registry.findByType(cli.type);
            return {
                type: cli.type,
                command: cli.command,
                path: cli.resolvedPath,
                available: cli.available,
                version: cli.version,
                registered: !!registered,
                agent_id: registered ? registered.id : null,
            };
        });
        (0, common_1.sendJson)(res, 200, { cli_agents: agents });
    };
}
//# sourceMappingURL=cliList.js.map