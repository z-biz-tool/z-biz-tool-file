"use strict";
// SSE chunk builders — OpenAI-compatible wire format. Mirrors the static
// helpers on Java ChatCompletionResponse.
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
exports.sseChunk = sseChunk;
exports.sseDone = sseDone;
exports.sseError = sseError;
exports.newCompletionId = newCompletionId;
exports.buildChatCompletionSyncResponse = buildChatCompletionSyncResponse;
const crypto = __importStar(require("crypto"));
function sseChunk(completionId, model, created, deltaContent) {
    const body = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: model || 'future-team-local',
        choices: [
            {
                index: 0,
                delta: { content: deltaContent },
            },
        ],
    };
    return `data: ${JSON.stringify(body)}\n\n`;
}
function sseDone() {
    return 'data: [DONE]\n\n';
}
function sseError(message) {
    return `data: ${JSON.stringify({ error: message })}\n\n`;
}
function newCompletionId() {
    return `chatcmpl-cli-${crypto.randomBytes(12).toString('hex')}`;
}
function buildChatCompletionSyncResponse(model, content) {
    return JSON.stringify({
        id: `chatcmpl-local-${crypto.randomBytes(12).toString('hex')}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'future-team-local',
        choices: [
            {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: content || '' },
            },
        ],
    });
}
//# sourceMappingURL=sse.js.map