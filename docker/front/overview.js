// The overview page: the last N blocks and every registered name with its
// current address, each linking into the explorer on the same origin.
//
// THIS FILE NEVER READS A METHOD NAME OFF THE REQUEST. Every call it makes is
// one it constructs here, with parameters it computed - `eth_blockNumber`,
// `eth_getBlockByNumber`, `eth_getLogs` and `eth_call` against one known
// selector. That is the whole reason it is a separate module from
// rpc_filter.js: `handle` forwards a caller's method and parameters, which is
// correct for an RPC endpoint and forbidden here, and a file that cannot import
// it cannot reach for it by mistake.
//
// It talks to the node through the front's own internal upstream rather than
// through the published `/rpc`, so the page renders identically whether a
// deployment publishes the RPC raw, filtered, or not at all.

// njs ships `fs` as a module; this file is an ES module, so it is imported
// rather than required.
import fs from 'fs';

// keccak256("Registered(string,address,address)") and the selector for
// keccak256("resolve(string)")[0:4]. Constants because njs has no keccak: both
// were computed with `cast sig-event` / `cast sig` against the contract's own
// signature, and a test decodes a REAL log from a live chain to prove the topic
// is the one the node actually emits rather than one that merely looks right.
var REGISTERED_TOPIC = '0x89e10b169d87e3f3c9c0cf7d190f5777367907b57ce823d5422007ca31f71986';
var RESOLVE_SELECTOR = '461a4478';

var ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ---------------------------------------------------------------- hex + ABI

function strip0x(hex) {
    return (typeof hex === 'string' && hex.slice(0, 2) === '0x') ? hex.slice(2) : String(hex || '');
}

/// The 32-byte word at index `i`, as hex with no 0x.
function wordAt(body, i) {
    return body.substr(i * 64, 64);
}

/// A word holding an address: 12 zero bytes then 20 address bytes.
function addressFromWord(word) {
    return '0x' + word.substr(24, 40);
}

/// A 32-byte word read as an unsigned integer.
///
/// `parseInt(hex, 16)` loses precision above 2^53, which no offset or length in
/// a log of this shape approaches - but a malformed word could carry anything,
/// so anything that does not land on a safe integer is refused rather than
/// silently truncated into a plausible-looking index.
function intFromWord(word) {
    var n = parseInt(word, 16);
    if (!isFinite(n) || n < 0 || n > 0x7fffffff) {
        return -1;
    }
    return n;
}

/// Decode `Registered(string name, address owner, address target)` from a log's
/// `data`. NONE of the three parameters is indexed, so all three are in data
/// and none is in topics - which is why this function exists at all.
///
/// Layout: three head words (offset-to-string, owner, target), then at that
/// offset a length word and the utf8 bytes padded up to a 32-byte boundary.
///
/// Returns null rather than throwing for anything that does not fit: a log this
/// cannot read is one name missing from a page, and that is a better outcome
/// than a 500 that loses the blocks as well.
function decodeRegistered(dataHex) {
    var body = strip0x(dataHex);
    if (body.length < 3 * 64) {
        return null;
    }

    var offset = intFromWord(wordAt(body, 0));
    if (offset < 0 || offset % 32 !== 0) {
        return null;
    }
    var owner = addressFromWord(wordAt(body, 1));
    var target = addressFromWord(wordAt(body, 2));

    // The offset is in BYTES from the start of data; words are 64 hex chars.
    var lenStart = offset * 2;
    if (lenStart + 64 > body.length) {
        return null;
    }
    var len = intFromWord(body.substr(lenStart, 64));
    if (len < 0) {
        return null;
    }
    var start = lenStart + 64;
    if (start + len * 2 > body.length) {
        return null;
    }

    var name = Buffer.from(body.substr(start, len * 2), 'hex').toString('utf8');
    return { name: name, owner: owner, target: target };
}

function padRight64(hex) {
    var out = hex;
    while (out.length % 64 !== 0) {
        out += '0';
    }
    return out;
}

function padLeft64(hex) {
    var out = hex;
    while (out.length < 64) {
        out = '0' + out;
    }
    return out;
}

/// Calldata for `resolve(string name)`: selector, the offset to the string
/// (always 0x20 for a single dynamic argument), its length, then its bytes.
function encodeResolve(name) {
    var utf8 = Buffer.from(name, 'utf8').toString('hex');
    return '0x' + RESOLVE_SELECTOR
        + padLeft64('20')
        + padLeft64(Buffer.from(name, 'utf8').length.toString(16))
        + padRight64(utf8);
}

// ------------------------------------------------------------------ the node

var NODE = '/__node';

/// One JSON-RPC round trip, batched. `calls` is an array of {method, params}.
///
/// ONE SUBREQUEST PER STEP RATHER THAN ONE PER CALL. The obvious shape is N+1
/// round trips - one per name - and njs 0.6.2 has no async/await, so that is
/// also N levels of nested callback. A JSON-RPC batch collapses each step to a
/// single subrequest whatever N is, which is both faster and flat.
///
/// CALLBACK, NOT PROMISE, and measured rather than assumed: njs 0.6.2 HAS
/// Promise and `.then` (async/await is the thing it lacks), and `r.subrequest`
/// returns a promise when the callback is omitted. Either shape works here; the
/// callback form is used because there are only three steps and it keeps the
/// error path in one place. Recorded so the next person does not re-run the
/// experiment to find out which the runtime supports.
function rpc(r, calls, done) {
    var payload = [];
    for (var i = 0; i < calls.length; i++) {
        payload.push({ jsonrpc: '2.0', id: i + 1, method: calls[i].method, params: calls[i].params || [] });
    }

    r.subrequest(NODE, { method: 'POST', body: JSON.stringify(payload) }, function (reply) {
        if (!reply || reply.status >= 400) {
            done(null);
            return;
        }
        var parsed;
        try {
            parsed = JSON.parse(reply.responseBody !== undefined ? reply.responseBody : reply.responseText);
        } catch (e) {
            done(null);
            return;
        }
        if (!Array.isArray(parsed)) {
            done(null);
            return;
        }
        // Batch replies may arrive in any order; put them back by id, which is
        // the index we assigned above.
        var out = new Array(calls.length);
        for (var j = 0; j < parsed.length; j++) {
            var slot = Number(parsed[j] && parsed[j].id) - 1;
            if (slot >= 0 && slot < out.length) {
                out[slot] = parsed[j];
            }
        }
        done(out);
    });
}

function resultOf(entry) {
    return (entry && entry.error === undefined) ? entry.result : undefined;
}

// ------------------------------------------------------------- the manifest

var MANIFEST = '/deployments/local.json';

/// The names registry's address, or null when this deployment has none.
///
/// READ PER REQUEST, NOT CACHED, and that is a correction to the brief rather
/// than a shortcut: njs 0.6.2's `fs` has no `statSync` (measured - it is
/// undefined), so there is no mtime to cache against. A time-based cache would
/// be worse than none here, because the thing it would hide is a redeploy
/// changing the registry address, and serving the old one until a timer expires
/// is exactly the failure the cache was meant to prevent. The file is small and
/// this page is rendered for a human.
///
/// A deployment with no names module, and a bare-EVM one with no manifest at
/// all, both land on null and get a page of blocks. Neither is an error.
/// Returns { address, fault }: the registry's address if this deployment has
/// one, and a human sentence if the manifest could not be read at all.
///
/// WHY TWO FIELDS RATHER THAN A NULL. The first version returned `null` for
/// five different situations, and the page turned every one of them into "this
/// deployment has no name registry" - which is a STATEMENT ABOUT THE
/// DEPLOYMENT, made on the evidence of a failed `open`. It was wrong here, and
/// it was wrong in the way that costs the most time: the deploy writes the
/// manifest under a 077 umask, so it arrives mode 0600 owned by the deploying
/// uid, and this container drops CAP_DAC_OVERRIDE and serves as `nginx`. The
/// page said the registry did not exist. The registry existed, was deployed,
/// had logs, and resolved - and none of that could be seen from the page,
/// because the sentence the page printed sent the reader to the contracts.
///
/// ENOENT IS NOT A FAULT: a deployment that has not deployed a registry has no
/// manifest, and that is an ordinary state with an ordinary sentence. Anything
/// else is a fault, and a fault is reported as one.
function readRegistry(path) {
    var file = (path === undefined) ? MANIFEST : path;
    var raw;
    try {
        raw = fs.readFileSync(file);
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            return { address: null, fault: null };
        }
        return { address: null, fault: 'cannot read ' + file + ': ' + (e && e.code ? e.code : 'unknown error') };
    }
    var parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { address: null, fault: file + ' is not valid JSON' };
    }
    var modules = parsed && parsed.modules;
    if (!Array.isArray(modules)) {
        return { address: null, fault: file + ' has no modules list' };
    }
    for (var i = 0; i < modules.length; i++) {
        if (modules[i] && modules[i].kind === 'names' && typeof modules[i].address === 'string') {
            return { address: modules[i].address, fault: null };
        }
    }
    // A manifest that read and parsed and simply has no registry in it.
    return { address: null, fault: null };
}

// ------------------------------------------------------------------ rendering

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function blockCount() {
    var raw = process.env.OVERVIEW_BLOCKS;
    var n = parseInt(raw === undefined || raw === null || raw === '' ? '10' : raw, 10);
    if (!isFinite(n) || n < 1 || n > 100) {
        return 10;
    }
    return n;
}

var STYLE =
    ':root{--ground:#f6f6f4;--panel:#fff;--ink:#17181a;--dim:#61646b;--rule:#dfe0dd;'
    + '--accent:#1f6f5c;--fresh:#e6efec}'
    + '@media(prefers-color-scheme:dark){:root{--ground:#131416;--panel:#1a1c1f;--ink:#e9e9e6;'
    + '--dim:#9a9ea6;--rule:#2b2e33;--accent:#63c9a8;--fresh:#17302a}}'
    + '*{box-sizing:border-box}'
    + 'body{margin:0;padding:28px 16px 48px;background:var(--ground);color:var(--ink);'
    + 'font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}'
    + '.wrap{max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:22px}'
    + 'header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px}'
    + 'h1{margin:0;font-size:19px;font-weight:600}'
    + '.facts{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--dim);font-size:13px}'
    + '.facts b{color:var(--ink);font-weight:600}'
    + '.live{display:flex;align-items:center;gap:7px;color:var(--dim);font-size:13px}'
    + '.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none}'
    + 'section{background:var(--panel);border:1px solid var(--rule)}'
    + 'h2{margin:0;padding:10px 14px;font-size:12px;font-weight:600;letter-spacing:.08em;'
    + 'text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--rule)}'
    + '.scroll{overflow-x:auto}'
    + 'table{width:100%;border-collapse:collapse;font-size:14px}'
    + 'th,td{text-align:left;padding:8px 14px;border-bottom:1px solid var(--rule);white-space:nowrap}'
    + 'th{font-weight:600;font-size:12px;color:var(--dim)}'
    + 'tbody tr:last-child td{border-bottom:0}'
    + 'td.num{text-align:right}'
    + 'tr.fresh td{background:var(--fresh)}'
    + '@media(prefers-reduced-motion:no-preference){tr.fresh td{transition:background 1.4s ease-out}}'
    + 'a{color:var(--accent);text-decoration:none;border-bottom:1px solid transparent}'
    + 'a:hover{border-bottom-color:var(--accent)}'
    + 'p.empty{color:var(--dim);padding:10px 14px;margin:0}'
    + 'footer{color:var(--dim);font-size:12px;line-height:1.6}';

/// The inline poll. EMPTY WHEN `OVERVIEW_POLL_SECONDS` IS 0.
///
/// INLINE because "no external assets" is half of why this service is cheap to
/// run and impossible to get out of step with itself: a script served from
/// somewhere else is a second thing to deploy and a second thing to cache.
///
/// AN ENHANCEMENT, NOT THE PAGE. Everything below is already in the markup when
/// it arrives; this only keeps it current. With scripting off, or with the
/// interval set to 0, the page reads exactly as it does with them on - which is
/// the property that must not be traded away for liveness.
function pollScript(seconds) {
    if (seconds === 0) {
        return '';
    }
    return '<script>(function(){'
        + 'var ms=' + (seconds * 1000) + ',last=Date.now(),h=document.getElementById("height"),'
        + 'u=document.getElementById("updated"),bt=document.getElementById("blocks"),'
        + 'nt=document.getElementById("names"),known=h?+h.textContent:-1;'
        + 'function since(){var s=Math.round((Date.now()-last)/1000);'
        + 'u.textContent=s<2?"updated just now":"updated "+s+"s ago";}'
        + 'function esc(t){var d=document.createElement("div");d.textContent=t==null?"":String(t);return d.innerHTML;}'
        + 'function blockRow(b){return "<td><a href=\'/block/"+b.number+"\'>"+b.number+"</a></td>"'
        + '+"<td>"+esc(b.time)+"</td><td class=\'num\'>"+b.txs+"</td>"'
        + '+"<td>"+(b.firstTx?"<a href=\'/tx/"+esc(b.firstTx)+"\'>"+esc(b.firstTx.slice(0,10)+"\u2026"+b.firstTx.slice(-8))+"</a>":"")+"</td>";}'
        + 'function nameRow(n){return "<td><a href=\'/address/"+esc(n.address)+"\'>"+esc(n.name)+"</a></td>"'
        + '+"<td><a href=\'/address/"+esc(n.address)+"\'>"+esc(n.address)+"</a></td>"'
        + '+"<td>"+(n.block==null?"":"block <a href=\'/block/"+n.block+"\'>"+n.block+"</a>")+"</td>";}'
        // ONLY WHAT CHANGED. A wholesale replace would fight the viewer: it
        // discards a text selection, and it re-animates every row on a page
        // where the highlight is supposed to mean "this one is new".
        + 'function draw(s){if(s.height===known)return;'
        + 'var fresh=known>=0;known=s.height;if(h)h.textContent=s.height;'
        + 'if(bt){var seen={},i,r;for(i=0;i<bt.rows.length;i++)seen[bt.rows[i].getAttribute("data-n")]=1;'
        + 'for(i=s.blocks.length-1;i>=0;i--){var b=s.blocks[i];if(seen[String(b.number)])continue;'
        + 'r=document.createElement("tr");r.setAttribute("data-n",b.number);r.innerHTML=blockRow(b);'
        + 'if(fresh)r.className="fresh";bt.insertBefore(r,bt.firstChild);'
        + 'if(fresh)setTimeout((function(x){return function(){x.className="";};})(r),60);}'
        + 'while(bt.rows.length>' + blockCount() + ')bt.deleteRow(bt.rows.length-1);}'
        // The names half is re-read only when the height moved, which is the
        // same condition the front caches on - so a quiet chain costs one
        // eth_blockNumber per poll and nothing else.
        + 'if(nt&&s.names){var html="";for(var j=0;j<s.names.length;j++)html+="<tr>"+nameRow(s.names[j])+"</tr>";'
        + 'if(nt.innerHTML!==html)nt.innerHTML=html;}'
        + 'last=Date.now();since();}'
        + 'function poll(){fetch("/overview/state.json",{cache:"no-store"})'
        + '.then(function(x){return x.ok?x.json():null;}).then(function(s){if(s)draw(s);})'
        + '.catch(function(){});}'
        + 'setInterval(since,1000);setInterval(poll,ms);'
        + '})();<\/script>';
}

function renderPage(state) {
    var blocks = state.blocks;
    var names = state.names;

    var html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>chain overview</title><style>' + STYLE + '</style></head><body><div class="wrap">'
        + '<header><h1>chain</h1><div class="facts">'
        + '<span>chain id <b>' + (isFinite(state.chainId) ? state.chainId : '?') + '</b></span>'
        + '<span>height <b id="height">' + state.height + '</b></span>'
        + '</div><div class="live"><span class="dot"></span>'
        + '<span id="updated">updated just now</span></div></header>';

    html += '<section><h2>Latest blocks</h2>';
    if (blocks.length === 0) {
        html += '<p class="empty">The node returned no blocks.</p>';
    } else {
        html += '<div class="scroll"><table><thead><tr><th>Block</th><th>Time</th>'
            + '<th class="num">Txs</th><th>First transaction</th></tr></thead><tbody id="blocks">';
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            html += '<tr data-n="' + b.number + '">'
                + '<td><a href="/block/' + b.number + '">' + b.number + '</a></td>'
                + '<td>' + escapeHtml(b.time) + '</td>'
                + '<td class="num">' + b.txs + '</td>'
                + '<td>' + (b.firstTx
                    ? '<a href="/tx/' + escapeHtml(b.firstTx) + '">' + escapeHtml(shortHash(b.firstTx)) + '</a>'
                    : '') + '</td></tr>';
        }
        html += '</tbody></table></div>';
    }
    html += '</section>';

    // TWO TABLES, BECAUSE ONE MIXED LIST READS AS A BROKEN PAGE. Every wallet's
    // agent identity is registered at spawn, so on a busy deployment the
    // identities outnumber the names somebody chose and bury them. Reported
    // from a live range: a reader seeing `drip:a-1789619721` beside
    // `treasury.play` concludes the page is malfunctioning.
    html += '<section><h2>Registered names</h2>';
    if (names === null) {
        html += (state.manifestFault
            ? '<p class="empty">The deployment manifest could not be read, so this page cannot say '
              + 'whether a registry exists: ' + escapeHtml(state.manifestFault) + '</p>'
            : '<p class="empty">This deployment has no name registry.</p>');
    } else {
        var vanity = [];
        var identities = [];
        for (var j = 0; j < names.length; j++) {
            (looksLikeIdentity(names[j].name) ? identities : vanity).push(names[j]);
        }
        if (names.length === 0) {
            html += '<p class="empty">No names are registered yet.</p>';
        } else if (vanity.length === 0) {
            html += '<p class="empty">No names have been registered beyond the agent identities below.</p>';
        } else {
            html += nameTable(vanity, 'names');
        }
        // The identities are shown rather than hidden: they are real entries and
        // a reader looking for one must be able to find it. Second, and headed
        // for what they are, so the list above is the one somebody curated.
        if (identities.length > 0) {
            html += '<h2>Agent identities</h2>'
                + '<p class="empty">Registered automatically when a wallet is created, one per wallet. '
                + 'They are qualified ids of the form <code>org:id</code>.</p>'
                + nameTable(identities, 'identities');
        }
    }
    html += '</section>';

    // The footer says only what a reader cannot discover by looking. A sentence
    // about links working over a forward or a published port explained the
    // implementation to someone who wanted the data, and described a property
    // they experience rather than need telling about: if the links work, they
    // work. These two routes are not visible from the page, so they stay.
    html += '<footer>Machine-readable list at <code>/overview/names.json</code>; a single name resolves at '
        + '<code>/overview/names/&lt;name&gt;</code>, which redirects to its address page or answers 404 '
        + 'when nobody has registered it.</footer>';

    return html + '</div>' + pollScript(pollSeconds()) + '</body></html>';
}

/// One table of registered names. Shared by both sections so a column added to
/// one cannot quietly go missing from the other.
function nameTable(rows, id) {
    var html = '<div class="scroll"><table><thead><tr><th>Name</th><th>Address</th>'
        + '<th>Registered</th></tr></thead><tbody id="' + id + '">';
    for (var i = 0; i < rows.length; i++) {
        var n = rows[i];
        html += '<tr>'
            + '<td><a href="/address/' + escapeHtml(n.address) + '">' + escapeHtml(n.name) + '</a></td>'
            + '<td><a href="/address/' + escapeHtml(n.address) + '">' + escapeHtml(n.address) + '</a></td>'
            + '<td>' + (n.block === null ? '' : 'block <a href="/block/' + n.block + '">' + n.block + '</a>')
            + '</td></tr>';
    }
    return html + '</tbody></table></div>';
}

/// A block's timestamp as HH:MM:SS UTC.
///
/// The time rather than the date: every row on this page is from the last few
/// minutes of a chain somebody is watching, and a full ISO stamp spends a
/// column's width on the part that is the same in every row.
function clockFromHexSeconds(hex) {
    var secs = parseInt(strip0x(hex), 16);
    if (!isFinite(secs)) {
        return '';
    }
    var iso = new Date(secs * 1000).toISOString();
    return iso.substr(11, 8);
}

/// `0x1234abcd…5678ef90` - enough of a hash to recognise, not enough to wrap.
function shortHash(hash) {
    var h = String(hash || '');
    if (h.length <= 22) {
        return h;
    }
    return h.substr(0, 10) + '\u2026' + h.substr(h.length - 8);
}

/// How often the page re-reads `/overview/state.json`, in seconds. ZERO MEANS
/// NO SCRIPT AT ALL - a deployment that wants a page with no scripting says so
/// here, and gets markup with nothing to execute rather than a script that
/// happens not to fire.
function pollSeconds() {
    var raw = process.env.OVERVIEW_POLL_SECONDS;
    var n = parseInt(raw === undefined || raw === null || raw === '' ? '5' : raw, 10);
    if (!isFinite(n) || n < 0 || n > 3600) {
        return 5;
    }
    return n;
}

// ----------------------------------------------------------- the names cache

/// Names, and the height they were correct at.
///
/// The name set only changes when a block lands, so recomputing it on every
/// poll would ask the node for every `Registered` log and one `resolve` per name
/// several times a minute to learn nothing. Keyed on HEIGHT rather than on a
/// clock: a cache with a timer is stale for a while by design, and this one is
/// exact - a new block invalidates it, nothing else can change the answer.
///
/// Also keyed on the registry address, so a redeploy under a running front does
/// not serve the previous deployment's names.
var namesCache = { height: -1, registry: null, names: null };

// -------------------------------------------------------------- the gathering

/// Blocks first, then - if there is a registry - the name set, then one batched
/// `resolve` per name.
///
/// THE LOGS GIVE A SET OF NAMES, NOT A SET OF ADDRESSES, and that is not an
/// optimisation to skip. `Registered` says where a name pointed when it was
/// created; `Transferred` and `TargetChanged` move it afterwards, so a page
/// built from the log's `target` would show addresses that were true once. The
/// names are taken from the logs and every current address is asked for.
function gather(r, done) {
    var want = blockCount();

    rpc(r, [{ method: 'eth_blockNumber', params: [] }, { method: 'eth_chainId', params: [] }],
        function (head) {
        var latestHex = head && resultOf(head[0]);
        if (latestHex === undefined) {
            done(null);
            return;
        }
        var latest = parseInt(strip0x(latestHex), 16);
        if (!isFinite(latest)) {
            done(null);
            return;
        }
        var chainId = parseInt(strip0x(head[1] && resultOf(head[1])) || 'NaN', 16);

        var reg = readRegistry();
        var registry = reg.address;
        // Logged for the same reason the filter logs a refusal: a page that
        // renders a sentence about an empty deployment is indistinguishable
        // from a page that could not look.
        if (reg.fault !== null) {
            r.warn('overview: ' + reg.fault);
        }
        var fresh = namesCache.height !== latest || namesCache.registry !== registry;

        var calls = [];
        var first = latest - want + 1;
        if (first < 0) {
            first = 0;
        }
        for (var n = latest; n >= first; n--) {
            calls.push({ method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), false] });
        }
        var logsAt = -1;
        if (registry !== null && fresh) {
            logsAt = calls.length;
            calls.push({
                method: 'eth_getLogs',
                params: [{ fromBlock: '0x0', toBlock: 'latest', address: registry, topics: [REGISTERED_TOPIC] }]
            });
        }

        rpc(r, calls, function (replies) {
            if (replies === null) {
                done(null);
                return;
            }

            var blocks = [];
            var blockEnd = (logsAt < 0) ? replies.length : logsAt;
            for (var i = 0; i < blockEnd; i++) {
                var b = resultOf(replies[i]);
                if (!b) {
                    continue;
                }
                var txs = Array.isArray(b.transactions) ? b.transactions : [];
                blocks.push({
                    number: parseInt(strip0x(b.number), 16),
                    time: clockFromHexSeconds(b.timestamp),
                    txs: txs.length,
                    // `false` above asks for hashes rather than whole objects,
                    // so this is already a hash and needs no second call.
                    firstTx: txs.length > 0 ? txs[0] : null
                });
            }

            if (registry === null) {
                namesCache = { height: latest, registry: null, names: null };
                done({ chainId: chainId, height: latest, blocks: blocks, names: null,
                       manifestFault: reg.fault });
                return;
            }

            if (!fresh) {
                done({ chainId: chainId, height: latest, blocks: blocks, names: namesCache.names });
                return;
            }

            var logs = resultOf(replies[logsAt]);
            if (!Array.isArray(logs)) {
                namesCache = { height: latest, registry: registry, names: [] };
                done({ chainId: chainId, height: latest, blocks: blocks, names: [] });
                return;
            }

            // THE SET, in first-seen order, remembering where each was first
            // registered. A name registered, transferred and registered again
            // appears once, at its first block.
            var seen = {};
            var order = [];
            for (var j = 0; j < logs.length; j++) {
                var decoded = decodeRegistered(logs[j] && logs[j].data);
                if (decoded === null || decoded.name === '') {
                    continue;
                }
                if (seen[decoded.name] === undefined) {
                    seen[decoded.name] = parseInt(strip0x(logs[j].blockNumber), 16);
                    order.push(decoded.name);
                }
            }

            if (order.length === 0) {
                namesCache = { height: latest, registry: registry, names: [] };
                done({ chainId: chainId, height: latest, blocks: blocks, names: [] });
                return;
            }

            var resolves = [];
            for (var k = 0; k < order.length; k++) {
                resolves.push({
                    method: 'eth_call',
                    params: [{ to: registry, data: encodeResolve(order[k]) }, 'latest']
                });
            }

            rpc(r, resolves, function (answers) {
                var names = [];
                if (answers !== null) {
                    for (var m = 0; m < order.length; m++) {
                        var word = resultOf(answers[m]);
                        if (typeof word !== 'string') {
                            continue;
                        }
                        var addr = addressFromWord(padLeft64(strip0x(word)));
                        // A NAME WHOSE CURRENT TARGET IS ZERO IS NOT A
                        // REGISTERED NAME. `resolve` does not revert for an
                        // unknown or burned name - it returns the zero address -
                        // so listing it would put a row about 0x0000…0000 on the
                        // page and link to it.
                        if (addr === ZERO_ADDRESS) {
                            continue;
                        }
                        var at = seen[order[m]];
                        names.push({
                            name: order[m],
                            address: addr,
                            block: isFinite(at) ? at : null
                        });
                    }
                }
                namesCache = { height: latest, registry: registry, names: names };
                done({ chainId: chainId, height: latest, blocks: blocks, names: names });
            });
        });
    });
}

// ---------------------------------------------------------------- the routes

function page(r) {
    gather(r, function (state) {
        r.headersOut['Content-Type'] = 'text/html; charset=utf-8';
        if (state === null) {
            r.return(503, '<!doctype html><meta charset="utf-8"><title>chain overview</title>'
                + '<style>' + STYLE + '</style><div class="wrap"><h1>chain</h1>'
                + '<p class="empty">The node did not answer.</p></div>');
            return;
        }
        r.return(200, renderPage(state));
    });
}

/// The page's own feed. ONE FIXED SHAPE, and nothing in it comes from the
/// request: no block range, no address, no method, no parameters. The caller
/// chooses nothing, which is what keeps this a page rather than a proxy.
///
/// Separate from `/overview/names.json` on purpose. That one is the stable
/// contract for tooling and does not change shape; this is the page's private
/// feed and may.
function stateJson(r) {
    gather(r, function (state) {
        r.headersOut['Content-Type'] = 'application/json';
        // NO CACHING BY ANYTHING IN BETWEEN: the whole point is freshness, and a
        // proxy holding this for even a few seconds makes the poll a lie.
        r.headersOut['Cache-Control'] = 'no-store';
        if (state === null) {
            r.return(503, JSON.stringify({ error: 'the node did not answer' }));
            return;
        }
        r.return(200, JSON.stringify({
            chainId: isFinite(state.chainId) ? state.chainId : null,
            height: state.height,
            blocks: state.blocks,
            names: state.names === null ? [] : state.names
        }));
    });
}

function namesJson(r) {
    gather(r, function (state) {
        r.headersOut['Content-Type'] = 'application/json';
        if (state === null) {
            r.return(503, JSON.stringify({ error: 'the node did not answer' }));
            return;
        }
        // NAMES, ADDRESSES AND WHICH KIND. This is not a proxy and must not
        // become one by growing a field that echoes something a caller asked
        // for - `kind` is derived here from the name itself and echoes nothing.
        // Added rather than replacing anything, so an existing reader of this
        // feed keeps working.
        var out = [];
        var names = state.names === null ? [] : state.names;
        for (var i = 0; i < names.length; i++) {
            out.push({
                name: names[i].name,
                address: names[i].address,
                kind: looksLikeIdentity(names[i].name) ? 'identity' : 'name'
            });
        }
        r.return(200, JSON.stringify({ names: out }));
    });
}

/// Whether a registered name is an agent identity rather than a vanity name.
///
/// A PRESENTATION TEST THAT DECIDES NOTHING, and it is written weak on purpose.
/// `svc/src/validate.ts` owns what "canonical" means - exactly one colon,
/// lowercase, per CANONICAL_ID - and its own comment is the reason this is not
/// a copy of that regex: "a second copy of the rule is a second authority".
/// That file's authority is consulted on the money path. This one chooses which
/// table a row is drawn in, so the worst it can be is untidy.
///
/// IT HOLDS BECAUSE OF WHO MAY REGISTER, not because of the registry. The
/// contract admits `:` in any name and deliberately cannot tell the two kinds
/// apart - putting that rule on-chain would freeze a game-layer distinction
/// into the ABI. What makes the split real is that REGISTRAR_ROLE goes to the
/// treasury alone, and chain-svc rejects a colon in a vanity alias precisely so
/// an alias can never impersonate an identity. A deployment that granted the
/// role elsewhere would make this a guess, and a misfiled row is the whole cost.
function looksLikeIdentity(name) {
    return typeof name === 'string' && name.indexOf(':') !== -1;
}

function nameRedirect(r) {
    var wanted = decodeURIComponent(r.uri.substr('/overview/names/'.length));
    if (wanted === '') {
        r.return(404, 'no such name\n');
        return;
    }

    var reg = readRegistry();
    var registry = reg.address;
    if (reg.fault !== null) {
        r.warn('overview: ' + reg.fault);
    }
    if (registry === null) {
        r.return(404, reg.fault !== null
            ? 'the deployment manifest could not be read: ' + reg.fault + '\n'
            : 'this deployment has no name registry\n');
        return;
    }

    rpc(r, [{ method: 'eth_call', params: [{ to: registry, data: encodeResolve(wanted) }, 'latest'] }],
        function (answers) {
            var word = answers && resultOf(answers[0]);
            if (typeof word !== 'string') {
                r.return(502, 'the node did not answer\n');
                return;
            }
            var addr = addressFromWord(padLeft64(strip0x(word)));
            // 404 rather than a redirect to the zero address: `resolve` answers
            // 0x0 for a name nobody registered, and a 302 to /address/0x0000…
            // would be a page about the zero address wearing the answer to a
            // question that has none.
            if (addr === ZERO_ADDRESS) {
                r.return(404, 'no such name\n');
                return;
            }
            // THE TARGET GOES IN `r.return`, NOT IN headersOut.
            //
            // Setting headersOut['Location'] and then calling `r.return(302)`
            // emits TWO Location headers - the one set here and an empty one
            // nginx adds for the redirect status - and a browser refuses the
            // response outright ("Corrupted Content Error" in Firefox). curl
            // follows it without complaint, which is why this survived: the
            // duplicate is invisible to every client that is not a browser.
            r.return(302, '/address/' + addr);
        });
}

// `decodeRegistered`, `encodeResolve` and the hex helpers are exported for the
// unit tests, which run this file under the standalone `njs` interpreter with
// no nginx around it. They are pure functions; everything else needs a request.
export default {
    page, stateJson, namesJson, nameRedirect,
    decodeRegistered, encodeResolve, addressFromWord, intFromWord, blockCount, escapeHtml,
    readRegistry, looksLikeIdentity,
    pollSeconds, pollScript, shortHash, clockFromHexSeconds, renderPage
};
