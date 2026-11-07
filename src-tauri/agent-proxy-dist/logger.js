"use strict";
// Lightweight timestamped logger. Stdout for info, stderr for warn/error.
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const TS = () => new Date().toISOString();
function emit(level, args) {
    const line = `[${TS()}] [${level}] ${args
        .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
        .join(' ')}\n`;
    if (level === 'ERROR' || level === 'WARN') {
        process.stderr.write(line);
    }
    else {
        process.stdout.write(line);
    }
}
function safeStringify(v) {
    try {
        if (v instanceof Error)
            return v.stack || `${v.name}: ${v.message}`;
        return JSON.stringify(v);
    }
    catch {
        return String(v);
    }
}
exports.logger = {
    info: (...args) => emit('INFO', args),
    warn: (...args) => emit('WARN', args),
    error: (...args) => emit('ERROR', args),
    debug: (...args) => {
        if (process.env.AGENT_PROXY_DEBUG === '1')
            emit('DEBUG', args);
    },
};
//# sourceMappingURL=logger.js.map