// Forwards the JSON-RPC methods in the allowlist to the node and answers
// everything else with -32601, so a published RPC is not a published admin
// console. Runs under njs, which has no async/await.
//
// THIS FILE READS A METHOD NAME OFF THE REQUEST AND FORWARDS IT. That is what
// it is for, and it is why the overview page lives in overview.js instead of
// gaining an export here: a page that reused `handle` would let a caller choose
// the method and the parameters, which is exactly what the page must never do.
// The separation is structural rather than remembered - `overview.js` cannot
// reach this function by accident, and the two `js_import` lines in the nginx
// config say which surface each location may use.

// Entries ending in '*' are prefixes. The explorer needs more than this set;
// see the config for what a deployment running one has to add.
var DEFAULT_ALLOWED = 'eth_*,net_version,web3_clientVersion';

function allowList() {
    var raw = process.env.RPC_ALLOWED_METHODS;
    if (raw === undefined || raw === null || raw === '') {
        raw = DEFAULT_ALLOWED;
    }

    var exact = {};
    var prefixes = [];
    var parts = raw.split(',');

    for (var i = 0; i < parts.length; i++) {
        var entry = parts[i].trim();
        if (entry === '') {
            continue;
        }
        if (entry.slice(-1) === '*') {
            prefixes.push(entry.slice(0, -1));
        } else {
            exact[entry] = true;
        }
    }

    return { exact: exact, prefixes: prefixes };
}

var ALLOWED = allowList();

function permitted(method) {
    if (typeof method !== 'string') {
        return false;
    }
    if (ALLOWED.exact[method] === true) {
        return true;
    }
    for (var i = 0; i < ALLOWED.prefixes.length; i++) {
        if (method.substr(0, ALLOWED.prefixes[i].length) === ALLOWED.prefixes[i]) {
            return true;
        }
    }
    return false;
}

var METHOD_NOT_FOUND = -32601;
var PARSE_ERROR = -32700;
var INVALID_REQUEST = -32600;

function origin() {
    return process.env.RPC_ALLOW_ORIGIN || '*';
}

function corsHeaders(r) {
    r.headersOut['Access-Control-Allow-Origin'] = origin();
    r.headersOut['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    r.headersOut['Access-Control-Allow-Headers'] = 'Content-Type';
    r.headersOut['Access-Control-Max-Age'] = '86400';
}

function refusal(id, method) {
    return {
        jsonrpc: '2.0',
        id: (id === undefined ? null : id),
        error: {
            code: METHOD_NOT_FOUND,
            message: 'method not available through this endpoint: ' + String(method)
        }
    };
}

function fail(r, code, message) {
    corsHeaders(r);
    r.headersOut['Content-Type'] = 'application/json';
    r.return(200, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: code, message: message } }));
}

// A batch may come back in any order, so replies are matched by id where there
// is one and by position otherwise.
function placeReplies(replies, forwarded, slots, out) {
    var byId = {};
    var usable = true;
    var i;

    for (i = 0; i < forwarded.length; i++) {
        var fid = forwarded[i].id;
        if (fid === undefined || fid === null) { usable = false; break; }
        byId[String(fid)] = slots[i];
    }

    for (i = 0; i < replies.length; i++) {
        var slot;
        if (usable && replies[i] && replies[i].id !== undefined && replies[i].id !== null
            && byId[String(replies[i].id)] !== undefined) {
            slot = byId[String(replies[i].id)];
        } else {
            slot = slots[i];
        }
        if (slot !== undefined) {
            out[slot] = replies[i];
        }
    }
}

function handle(r) {
    if (r.method === 'OPTIONS') {
        corsHeaders(r);
        r.return(204);
        return;
    }

    if (r.method !== 'POST') {
        fail(r, INVALID_REQUEST, 'this endpoint accepts JSON-RPC over POST');
        return;
    }

    var body;
    try {
        body = JSON.parse(r.requestText !== undefined ? r.requestText : r.requestBody);
    } catch (e) {
        fail(r, PARSE_ERROR, 'request body is not JSON');
        return;
    }

    var isBatch = Array.isArray(body);
    var calls = isBatch ? body : [body];

    if (isBatch && calls.length === 0) {
        fail(r, INVALID_REQUEST, 'empty batch');
        return;
    }

    // Each element of a batch is judged on its own.
    var out = new Array(calls.length);
    var forwarded = [];
    var slots = [];
    var refused = [];

    for (var i = 0; i < calls.length; i++) {
        var call = calls[i];
        var method = (call && typeof call === 'object') ? call.method : undefined;

        if (permitted(method)) {
            forwarded.push(call);
            slots.push(i);
        } else {
            out[i] = refusal(call && call.id, method);
            refused.push(String(method));
        }
    }

    // REFUSALS ARE LOGGED, and this line is an instrument rather than a
    // courtesy. The allowlist has to match what the things in front of it
    // actually call, and the only honest way to learn that set is to run them
    // and read what got refused - reading a client's source tells you what it
    // can call, not what this deployment does. It also answers the operator's
    // question: a page that renders empty says nothing, `refused: ots_*` says
    // everything.
    //
    // METHOD NAMES ONLY, never params: a refused call's arguments can carry
    // anything the caller put there, and this log is not the place for it.
    if (refused.length > 0) {
        r.warn('rpc filter refused: ' + refused.join(' '));
    }

    if (forwarded.length === 0) {
        answer(r, isBatch, out);
        return;
    }

    r.subrequest('/__node',
        { method: 'POST', body: JSON.stringify(isBatch ? forwarded : forwarded[0]) },
        function (reply) {
            if (!reply || reply.status >= 500) {
                fail(r, -32603, 'the node did not answer');
                return;
            }

            var parsed;
            try {
                parsed = JSON.parse(reply.responseBody !== undefined
                    ? reply.responseBody : reply.responseText);
            } catch (e) {
                fail(r, -32603, 'the node answered with something other than JSON');
                return;
            }

            placeReplies(Array.isArray(parsed) ? parsed : [parsed], forwarded, slots, out);
            answer(r, isBatch, out);
        });
}

function answer(r, isBatch, out) {
    corsHeaders(r);
    r.headersOut['Content-Type'] = 'application/json';
    r.return(200, JSON.stringify(isBatch ? out : out[0]));
}

// `permitted` and `placeReplies` are exported for the unit tests, which run
// this file under the standalone `njs` interpreter with no nginx around it.
// They are pure functions of their arguments; nothing else here is testable
// that way, because everything else needs a request object.
export default { handle, permitted, placeReplies, allowList };
