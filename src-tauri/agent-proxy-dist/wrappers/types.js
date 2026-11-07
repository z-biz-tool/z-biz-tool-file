"use strict";
// Common contract every CLI wrapper satisfies.
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpSseWriter = void 0;
/** Tiny SSE writer that pipes a Node Writable to a streamed HTTP response. */
class HttpSseWriter {
    out;
    constructor(out) {
        this.out = out;
    }
    write(chunk) {
        this.out.write(chunk);
    }
    end() {
        // caller closes the response
    }
}
exports.HttpSseWriter = HttpSseWriter;
//# sourceMappingURL=types.js.map