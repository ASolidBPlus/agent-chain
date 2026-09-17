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
//
// NAMED ONE BY ONE RATHER THAN AS `eth_*`. The eth_ namespace on this node is
// not a read namespace: it carries `eth_sendTransaction`, `eth_sign`, three
// `eth_signTypedData` variants, `eth_sendRawTransaction` and
// `eth_sendUnsignedTransaction`, and the node holds the treasury key unlocked.
// A prefix admits all of them, so a published RPC that looked filtered was an
// unauthenticated console onto the treasury: measured on the pinned anvil,
// `eth_sendUnsignedTransaction` moved treasury funds with no signature at all,
// and `eth_sendRawTransaction` let an unfunded stranger deploy a contract,
// because the node runs with zero gas price.
//
// The cost of this list being short by one is an explorer page that fails and
// says so at test time. The cost of the prefix was the above, silently. That
// asymmetry is the whole reason it is a list.
var DEFAULT_ALLOWED = [
    'net_version', 'web3_clientVersion',
    'ots_*', 'erigon_getHeaderByNumber',
    'eth_chainId', 'eth_blockNumber', 'eth_syncing', 'eth_gasPrice',
    'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_blobBaseFee',
    'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getProof',
    'eth_getTransactionCount',
    'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBlockReceipts',
    'eth_getBlockTransactionCountByNumber', 'eth_getBlockTransactionCountByHash',
    'eth_getTransactionByHash', 'eth_getTransactionReceipt',
    'eth_getTransactionByBlockNumberAndIndex',
    'eth_getTransactionByBlockHashAndIndex',
    'eth_getLogs', 'eth_call', 'eth_estimateGas', 'eth_createAccessList'
].join(',');

// THE FLOOR. Refused before the allowlist is consulted, so an allowlist that is
// wider than its author realised - a future `eth_*`, or a prefix added for one
// method that quietly admits these - still cannot reach them. Every entry either
// signs with a key the node holds or submits a transaction.
//
// EXEMPT UNDER PASS-THROUGH. A bare `*` is a deployment that has asked for an
// unrestricted admin RPC on purpose and documented it as such; the floor exists
// to catch an allowlist that is wrong by accident, not to overrule a choice that
// was made deliberately. Without this exemption a pass-through deployment gets a
// node that silently cannot transact.
var DENIED = {
    eth_sendTransaction: true,
    eth_sendUnsignedTransaction: true,
    eth_sendRawTransaction: true,
    eth_sign: true,
    eth_signTransaction: true,
    eth_signTypedData: true,
    eth_signTypedData_v3: true,
    eth_signTypedData_v4: true
};

// `raw` is a parameter so the tests can build a matcher for a list other than
// the one this process was started with; production calls it with nothing.
function allowList(raw) {
    if (raw === undefined || raw === null || raw === '') {
        raw = process.env.RPC_ALLOWED_METHODS;
    }
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

    // A bare '*' becomes the empty prefix, which matches every method.
    var passThrough = false;
    for (var p = 0; p < prefixes.length; p++) {
        if (prefixes[p] === '') {
            passThrough = true;
        }
    }

    return { exact: exact, prefixes: prefixes, passThrough: passThrough };
}

var ALLOWED = allowList();

function permitted(method, allowed) {
    if (typeof method !== 'string') {
        return false;
    }
    if (allowed === undefined) {
        allowed = ALLOWED;
    }
    if (!allowed.passThrough && DENIED[method] === true) {
        return false;
    }
    if (allowed.exact[method] === true) {
        return true;
    }
    for (var i = 0; i < allowed.prefixes.length; i++) {
        if (method.substr(0, allowed.prefixes[i].length) === allowed.prefixes[i]) {
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
