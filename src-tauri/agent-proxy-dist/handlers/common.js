"use strict";
// Small HTTP helpers shared by handlers. Built on Node's http module so we
// don't pull Express for what amounts to four routes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.readBody = readBody;
exports.sendJson = sendJson;
exports.sendError = sendError;
exports.setCors = setCors;
exports.handleCors = handleCors;
exports.headerString = headerString;
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}
function sendJson(res, status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(text);
}
function sendError(res, status, body) {
    if (typeof body === 'string') {
        sendJson(res, status, { error: body });
    }
    else {
        sendJson(res, status, body);
    }
}
function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id, X-Agent-Id, X-CLI-Type');
}
/** If the request is an OPTIONS preflight, send 204 and return true. */
function handleCors(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return true;
    }
    return false;
}
function headerString(req, name) {
    const v = req.headers[name.toLowerCase()];
    if (Array.isArray(v))
        return v[0] ?? null;
    return v ?? null;
}
//# sourceMappingURL=common.js.map