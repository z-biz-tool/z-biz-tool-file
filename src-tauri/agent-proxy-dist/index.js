"use strict";
// Entry point. Wires the registries, runs CLI discovery, starts the HTTP
// server, and registers shutdown handlers.
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const logger_1 = require("./logger");
const server_1 = require("./server");
const agentRegistry_1 = require("./agentRegistry");
const sessionRegistry_1 = require("./sessionRegistry");
const executor_1 = require("./executor");
const registry_1 = require("./wrappers/registry");
const claudeCode_1 = require("./wrappers/claudeCode");
const hermes_1 = require("./wrappers/hermes");
const opencode_1 = require("./wrappers/opencode");
const pi_1 = require("./wrappers/pi");
const discovery_1 = require("./discovery");
async function main() {
    logger_1.logger.info(`Starting agent-proxy on ${config_1.config.host}:${config_1.config.port}`);
    logger_1.logger.info(`Persistence: ${config_1.config.persistDir}`);
    const agentRegistry = new agentRegistry_1.AgentRegistry(config_1.config.persistDir);
    logger_1.logger.info(`AgentRegistry loaded: ${agentRegistry.list().length} agents`);
    // discoverAndRegister is fire-and-forget; failures are logged.
    (0, discovery_1.discoverAndRegister)(agentRegistry)
        .then((found) => {
        logger_1.logger.info(`After discovery: ${agentRegistry.list().length} agents registered`);
        const ok = found.filter((f) => f.available).length;
        logger_1.logger.info(`Discovered ${ok}/${found.length} CLIs available locally`);
    })
        .catch((e) => logger_1.logger.error('Discovery failed:', e));
    const sessionRegistry = new sessionRegistry_1.SessionRegistry(config_1.config.persistDir);
    const wrapperRegistry = new registry_1.CliAgentWrapperRegistry(new claudeCode_1.ClaudeCodeWrapper(), new hermes_1.HermesProcessWrapper(), new opencode_1.OpencodeProcessWrapper(), new pi_1.PiWrapper());
    const executor = new executor_1.CliChatExecutor(wrapperRegistry);
    const server = (0, server_1.createServer)({ agentRegistry, sessionRegistry, executor });
    await new Promise((resolve) => {
        server.listen(config_1.config.port, config_1.config.host, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config_1.config.port;
    logger_1.logger.info(`agent-proxy ready on http://${config_1.config.host}:${port}`);
    logger_1.logger.info('  GET  /v1/cli-agents       — list discovered CLI agents');
    logger_1.logger.info('  POST /v1/session/open     — create session (binds cliType), returns sessionId');
    logger_1.logger.info('  POST /v1/chat/completions — chat (SSE/JSON, OpenAI compatible)');
    logger_1.logger.info('  GET  /health              — health check');
    const shutdown = (signal) => {
        logger_1.logger.info(`Received ${signal}, shutting down...`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}
main().catch((e) => {
    logger_1.logger.error('Fatal:', e);
    process.exit(1);
});
//# sourceMappingURL=index.js.map