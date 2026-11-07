"use strict";
// Extract a text delta from a single line of CLI stdout.
// Mirrors Java StreamJsonParser.extractDelta: handles stream_event (claude-code),
// content_block_delta, OpenAI choices[0].delta.content, and plain text fallback.
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractDelta = extractDelta;
const META_PREFIXES = [
    'session_id:',
    'Session:',
    'Duration:',
    'Messages:',
    'Resume this session',
    'hermes --resume',
    'Query:',
];
function extractDelta(line) {
    if (!line)
        return null;
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    for (const prefix of META_PREFIXES) {
        if (trimmed.startsWith(prefix))
            return null;
    }
    // Try JSON first. Anything that doesn't look like JSON falls through.
    let parsed = null;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        // not JSON — treat as plain text only if it really doesn't look like JSON
        if (!line.startsWith('{') && !line.startsWith('['))
            return line;
        return null;
    }
    // `JSON.parse('7421')` returns the number 7421, `JSON.parse('"foo"')` returns
    // the string "foo", etc. None of those are useful here — fall through to
    // the line itself so callers still get the text.
    if (parsed === null || typeof parsed !== 'object') {
        return line;
    }
    const type = parsed.type;
    // stream_event: claude-code --include-partial-messages real streaming.
    // {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
    if (type === 'stream_event') {
        const event = parsed.event;
        if (!event)
            return null;
        const eventType = event.type;
        if (eventType === 'content_block_delta' || eventType === 'content_delta') {
            const delta = event.delta;
            if (delta && delta.type === 'text_delta') {
                return typeof delta.text === 'string' ? delta.text : null;
            }
        }
        return null;
    }
    // content_block_delta (un-nested form, for safety)
    if (type === 'content_block_delta') {
        const delta = parsed.delta;
        if (delta && typeof delta.text === 'string')
            return delta.text;
    }
    // assistant / result are full snapshots in claude-code; stream_event already
    // supplies deltas, so we must skip them here or we'd double-print.
    if (type === 'assistant' || type === 'result')
        return null;
    // OpenAI-compatible: choices[0].delta.content
    const choices = parsed.choices;
    if (Array.isArray(choices) && choices.length > 0) {
        const choice = choices[0];
        if (choice) {
            if (choice.delta && typeof choice.delta.content === 'string') {
                return choice.delta.content;
            }
            if (choice.message && typeof choice.message.content === 'string') {
                return choice.message.content;
            }
        }
    }
    // Bare fields (some CLIs print a single object per line)
    for (const k of ['text', 'content', 'output']) {
        if (typeof parsed[k] === 'string')
            return parsed[k];
    }
    return null;
}
//# sourceMappingURL=streamParser.js.map