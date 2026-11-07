"use strict";
// CLI auto-discovery: scan PATH + common bin dirs for hermes / opencode /
// claude. Mirrors Java CliDiscoveryService.discover/discoverAndRegister.
Object.defineProperty(exports, "__esModule", { value: true });
exports.discover = discover;
exports.discoverAndRegister = discoverAndRegister;
const logger_1 = require("./logger");
const utils_1 = require("./utils");
const CLI_MAPPINGS = [
    ['claude', 'claude-code'],
    ['hermes', 'hermes'],
    ['opencode', 'opencode'],
    // Bundled Pi: resolveCommand('pi') finds it on PATH; if not, we still report
    // it available because the bundled runtime ships with Pi (wrapper resolves it).
    ['pi', 'pi'],
];
async function discover() {
    const out = [];
    for (const [command, type] of CLI_MAPPINGS) {
        let resolved = (0, utils_1.resolveCommand)(command);
        // Bundled Pi: if not on PATH, fall back to the Pi shipped under our
        // own Resources/runtime — it's always available (装完即用).
        if (type === 'pi' && !resolved) {
            resolved = bundledPiCli();
        }
        let version = null;
        if (resolved) {
            version = type === 'pi' ? bundledPiVersion() : await (0, utils_1.probeVersion)(resolved);
            logger_1.logger.info(`Discovered CLI: ${type} at ${resolved} (v=${version || 'unknown'})`);
        }
        else {
            logger_1.logger.info(`CLI not found: ${command} (type=${type})`);
        }
        out.push({
            type,
            command,
            resolvedPath: resolved,
            available: resolved !== null,
            version,
        });
    }
    return out;
}

/** Bundled Pi CLI path (runtime/lib/pi/node_modules/.../dist/bundle/cli.js). */
function bundledPiCli() {
    const path = require("path");
    const here = __dirname; // runtime/agent-proxy/dist
    const runtime = path.resolve(here, "..", ".."); // runtime
    const cli = path.join(runtime, "lib", "pi", "node_modules",
        "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    return require("fs").existsSync(cli) ? cli : null;
}
function bundledPiVersion() {
    const path = require("path");
    const here = __dirname;
    const runtime = path.resolve(here, "..", "..");
    const pkg = path.join(runtime, "lib", "pi", "node_modules",
        "@earendil-works", "pi-coding-agent", "package.json");
    try {
        const j = JSON.parse(require("fs").readFileSync(pkg, "utf8"));
        return j.version || null;
    }
    catch { return null; }
}
/**
 * Discover and register new CLIs in the AgentRegistry. Existing entries with
 * the same type but a different command get replaced (nvm upgrade etc).
 */
async function discoverAndRegister(registry) {
    const found = await discover();
    for (const cli of found) {
        if (!cli.available)
            continue;
        const existing = registry.findByType(cli.type);
        if (!existing) {
            registry.register(cli.type, cli.type, cli.command, null, null);
            logger_1.logger.info(`Registered CLI: ${cli.type} at ${cli.resolvedPath}`);
        }
        else if (cli.command !== existing.command) {
            registry.remove(existing.id);
            registry.register(cli.type, cli.type, cli.command, null, null);
            logger_1.logger.info(`Updated CLI: ${cli.type} -> ${cli.resolvedPath}`);
        }
        else {
            logger_1.logger.info(`CLI already registered: ${cli.type} at ${cli.resolvedPath}`);
        }
    }
    return found;
}
//# sourceMappingURL=discovery.js.map