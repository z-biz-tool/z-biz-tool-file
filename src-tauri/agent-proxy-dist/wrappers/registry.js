"use strict";
// Map agent type -> wrapper. The Java version is a tiny list-of-wrappers
// with a linear scan; we use a Map for the same O(1) lookup.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CliAgentWrapperRegistry = void 0;
class CliAgentWrapperRegistry {
    wrappers;
    byType = new Map();
    constructor(...wrappers) {
        this.wrappers = wrappers;
        for (const w of wrappers) {
            // Each wrapper picks exactly one type; re-run supports() for safety.
            for (const t of ['claude-code', 'hermes', 'opencode', 'pi']) {
                if (w.supports(t) && !this.byType.has(t))
                    this.byType.set(t, w);
            }
        }
    }
    get(type) {
        if (!type)
            return null;
        return this.byType.get(type) || null;
    }
    has(type) {
        return this.get(type) !== null;
    }
    all() {
        return [...this.wrappers];
    }
}
exports.CliAgentWrapperRegistry = CliAgentWrapperRegistry;
//# sourceMappingURL=registry.js.map