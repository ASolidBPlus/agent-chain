// Unit tests for the front's two njs modules, run under the STANDALONE njs
// interpreter from the same pinned image the service uses.
//
// WHY THIS EXISTS RATHER THAN ONLY A LIVE-STACK SCRIPT. The ABI decoder and the
// allowlist matcher are pure functions, and the live script can only reach them
// through a whole nginx, a node and a deployed registry - so a decoder bug
// arrives as "the page has no names", which is also what an empty chain, a
// missing manifest and a wrong topic look like. These run the functions
// directly and say which one is wrong.
//
// The runtime is the constraint they are written to: njs 0.6.2 has no
// async/await and no test framework. This file is the framework.

import filter from '/etc/nginx/njs/rpc_filter.js';
import overview from '/etc/nginx/njs/overview.js';

var failures = 0;
var checks = 0;

function eq(what, actual, expected) {
    checks++;
    var a = JSON.stringify(actual);
    var e = JSON.stringify(expected);
    if (a === e) {
        console.log('  ok   ' + what);
    } else {
        console.log('  FAIL ' + what + ': got ' + a + ' want ' + e);
        failures++;
    }
}

// ---------------------------------------------------------------- the decoder

console.log('\n=== decoding Registered(string,address,address)');

// A REAL LOG, captured from a live chain rather than hand-assembled: this is
// the `data` of a `Registered` emitted by the deployed NameRegistry for the
// name below, taken with `cast logs` and pasted whole. A fixture somebody typed
// tests the decoder against its author's idea of the encoding; this one tests
// it against what the node actually emits.
//
// Regenerate with docker/front/test/capture-fixture.sh if the event ever
// changes shape - the script prints exactly this block.
var REAL_LOG_DATA = '0x0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000748549801286d9223e6fe561275cd423b9de8cdd000000000000000000000000748549801286d9223e6fe561275cd423b9de8cdd000000000000000000000000000000000000000000000000000000000000000e666978747572653a73616d706c65000000000000000000000000000000000000';
var REAL_LOG_NAME = 'fixture:sample';
var REAL_LOG_TARGET = '0x748549801286d9223e6fe561275cd423b9de8cdd';

var decoded = overview.decodeRegistered(REAL_LOG_DATA);
eq('a real log decodes to its name', decoded && decoded.name, REAL_LOG_NAME);
eq('...and to its target address', decoded && decoded.target, REAL_LOG_TARGET);

// The boundary that a hand-written fixture usually misses: a name whose utf8
// length is an exact multiple of 32, so the padding word is absent.
var exactly32 = 'abcdefghijklmnopqrstuvwxyz012345';
eq('a 32-byte name round-trips',
   overview.decodeRegistered(
       '0x' + '0000000000000000000000000000000000000000000000000000000000000060'
            + '000000000000000000000000' + '1111111111111111111111111111111111111111'
            + '000000000000000000000000' + '2222222222222222222222222222222222222222'
            + '0000000000000000000000000000000000000000000000000000000000000020'
            + '6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435'
   ).name, exactly32);

// A multi-byte character, because the length word counts BYTES and a decoder
// that sliced characters would be wrong by the difference.
eq('a name with a multi-byte character decodes by BYTE length',
   overview.decodeRegistered(
       '0x' + '0000000000000000000000000000000000000000000000000000000000000060'
            + '000000000000000000000000' + '1111111111111111111111111111111111111111'
            + '000000000000000000000000' + '2222222222222222222222222222222222222222'
            + '0000000000000000000000000000000000000000000000000000000000000005'
            + 'c3a46263640000000000000000000000000000000000000000000000000000000'.substr(0, 64)
   ).name, 'äbcd');

// MALFORMED INPUT IS NULL, NOT A THROW. A log this cannot read costs one name
// on the page; an exception costs the blocks as well.
eq('truncated data is null', overview.decodeRegistered('0xdeadbeef'), null);
eq('empty data is null', overview.decodeRegistered('0x'), null);
eq('undefined is null', overview.decodeRegistered(undefined), null);
eq('an offset past the end is null',
   overview.decodeRegistered(
       '0x' + 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0'
            + '0'.repeat(64) + '0'.repeat(64)
   ), null);
eq('a length past the end is null',
   overview.decodeRegistered(
       '0x' + '0000000000000000000000000000000000000000000000000000000000000060'
            + '0'.repeat(64) + '0'.repeat(64)
            + '00000000000000000000000000000000000000000000000000000000000000ff'
   ), null);

// --------------------------------------------------------------- the encoder

console.log('\n=== encoding resolve(string)');

// Selector, offset, length, padded bytes. Compared against a value produced by
// `cast calldata`, not against the encoder's own output.
eq('resolve("alpha.play")',
   overview.encodeResolve('alpha.play'),
   '0x461a4478'
   + '0000000000000000000000000000000000000000000000000000000000000020'
   + '000000000000000000000000000000000000000000000000000000000000000a'
   + '616c7068612e706c617900000000000000000000000000000000000000000000');

eq('a 32-byte name needs no padding word',
   overview.encodeResolve(exactly32).length,
   2 + 8 + 64 + 64 + 64);

// ------------------------------------------------------------- the allowlist

console.log('\n=== the method allowlist');

// `permitted` closes over the env read at module load, so these exercise the
// matcher through its own default set: eth_*, net_version, web3_clientVersion.
eq('an eth_ method is allowed', filter.permitted('eth_call'), true);
eq('an exact entry is allowed', filter.permitted('net_version'), true);
eq('an admin method is refused', filter.permitted('anvil_setBalance'), false);
eq('a near-miss prefix is refused', filter.permitted('ethx_call'), false);
eq('a non-string method is refused', filter.permitted(undefined), false);
eq('a method that merely CONTAINS an allowed prefix is refused',
   filter.permitted('evil_eth_call'), false);

// The parse, rather than the matcher: a trailing star is a prefix, anything
// else is exact, and whitespace and empty entries are tolerated.
var parsed = filter.allowList();
eq('the default parses to one prefix and two exact entries',
   [parsed.prefixes.length, Object.keys(parsed.exact).sort()],
   [1, ['net_version', 'web3_clientVersion']]);

// ------------------------------------------------ batch reply placement

console.log('\n=== batch replies land in the slot they came from');

// The property that matters: one refused call in a batch must not move the
// answers beside it. Slots 0 and 2 were forwarded, slot 1 was refused.
var out = new Array(3);
out[1] = { jsonrpc: '2.0', id: 'b', error: { code: -32601 } };
filter.placeReplies(
    [{ id: 'c', result: '0xc' }, { id: 'a', result: '0xa' }],   // out of order
    [{ id: 'a' }, { id: 'c' }],
    [0, 2],
    out
);
eq('replies are matched by id, not by arrival order',
   [out[0].result, out[1].error.code, out[2].result],
   ['0xa', -32601, '0xc']);

// ...and when a call carried no id, position is the only thing left.
var byPos = new Array(2);
filter.placeReplies([{ result: '0x1' }, { result: '0x2' }], [{}, {}], [0, 1], byPos);
eq('without ids, replies land by position', [byPos[0].result, byPos[1].result], ['0x1', '0x2']);

// ------------------------------------------------------------- block count

console.log('\n=== OVERVIEW_BLOCKS');
eq('defaults to 10 when unset or junk', overview.blockCount(), 10);

// ---------------------------------------------------------------- the poll

console.log('\n=== OVERVIEW_POLL_SECONDS and the inline script');

// The default, and the one value with a behaviour rather than a number:
// 0 must produce NO SCRIPT AT ALL, not a script that happens not to fire. A
// deployment asking for no scripting gets markup with nothing to execute.
eq('defaults to 5', overview.pollSeconds(), 5);

// ZERO MEANS NO SCRIPT, asserted on the markup rather than on the number: the
// requirement is that a deployment asking for no scripting gets a page with
// nothing to execute, and a `pollSeconds()` of 0 feeding a script that still
// renders would satisfy the number and not the requirement.
eq('0 produces no script at all', overview.pollScript(0), '');
eq('a non-zero interval produces one that polls the state feed',
   [overview.pollScript(5).indexOf('setInterval') > -1,
    overview.pollScript(5).indexOf('/overview/state.json') > -1],
   [true, true]);
eq('the interval reaches the script in milliseconds',
   overview.pollScript(7).indexOf('var ms=7000') > -1, true);

// The page is the same page either way apart from that script: a reader with
// scripting off must not be reading a different document.
var withPoll = overview.renderPage({ chainId: 1, height: 3, blocks: [], names: [] });
eq('the poll is the ONLY difference the script makes to the markup',
   withPoll.replace(overview.pollScript(overview.pollSeconds()), '').indexOf('<script') === -1,
   true);

// The page is complete before any of this runs. Rendered with an empty state,
// it still carries both sections and the footer - which is the property that
// must survive every change to the poll.
var quiet = overview.renderPage({ chainId: 31337, height: 0, blocks: [], names: null });
eq('a page with no blocks still renders its sections',
   [quiet.indexOf('Latest blocks') > -1, quiet.indexOf('Registered names') > -1], [true, true]);
eq('...and says so rather than showing an empty table',
   quiet.indexOf('The node returned no blocks') > -1, true);
eq('a deployment with no registry says that, not "no names yet"',
   quiet.indexOf('no name registry') > -1, true);

// SERVER-RENDERED ROWS, not placeholders for the script to fill. With scripting
// off the page must already show the data.
var withData = overview.renderPage({
    chainId: 31337, height: 2,
    blocks: [{ number: 2, time: '00:00:02', txs: 1, firstTx: '0x' + 'ab'.repeat(32) }],
    names: [{ name: 'sample.name', address: '0x' + '11'.repeat(20), block: 1 }]
});
eq('the block row is in the markup', withData.indexOf('/block/2') > -1, true);
eq('the name row is in the markup', withData.indexOf('sample.name') > -1, true);
eq('the transaction links into the explorer', withData.indexOf('/tx/0xabab') > -1, true);

// A hash is shortened for the eye and linked in full: a truncated href would be
// a link to a transaction that does not exist.
eq('the link carries the WHOLE hash, the text is shortened',
   [withData.indexOf('/tx/0x' + 'ab'.repeat(32)) > -1, withData.indexOf('\u2026') > -1],
   [true, true]);

eq('shortHash keeps both ends', overview.shortHash('0x' + 'ab'.repeat(32)),
   '0xabababab\u2026abababab');
eq('shortHash leaves a short value alone', overview.shortHash('0xdead'), '0xdead');

// Names and addresses are attacker-chosen strings - a name is whatever somebody
// registered - so they are escaped everywhere they are rendered.
var nasty = overview.renderPage({
    chainId: 1, height: 1, blocks: [],
    names: [{ name: '<script>x</script>', address: '0x' + '22'.repeat(20), block: 1 }]
});
eq('a name carrying markup is escaped', nasty.indexOf('<script>x') === -1, true);
eq('...and is still shown, escaped', nasty.indexOf('&lt;script&gt;x') > -1, true);

// ------------------------------------------------------- reading the manifest

console.log('\n=== the deployment manifest: absent, unreadable and broken are not the same');

// THE DISTINCTION THIS FUNCTION EXISTS TO MAKE. It returned a bare `null` for
// all of these once, and the page turned every one into "this deployment has no
// name registry" - a claim about the deployment, made on the evidence of a
// failed open. Each case is asserted separately, because a helper that collapsed
// them is exactly what was wrong.
eq('a manifest with a registry yields its address',
   overview.readRegistry('/fixtures/with-registry.json'),
   { address: '0x2222222222222222222222222222222222222222', fault: null });

// No manifest at all is an ORDINARY state, not a fault: a deployment that never
// deployed a registry has no file.
eq('no manifest at all is not a fault',
   overview.readRegistry('/fixtures/nothing-here.json'), { address: null, fault: null });

// A manifest that read and parsed and simply has no registry in it - also
// ordinary, and it must not be confused with either of the two above.
eq('a manifest without a names module is not a fault',
   overview.readRegistry('/fixtures/no-registry.json'), { address: null, fault: null });

// THE ONE THAT BIT. The file is present and the process cannot read it, because
// the deploy wrote it 0600 under the umask it sets for the mnemonic and this
// container drops CAP_DAC_OVERRIDE. Asserted on the fault being NAMED, not just
// non-null: "something went wrong" sends the reader nowhere.
var denied = overview.readRegistry('/fixtures/unreadable.json');
eq('an unreadable manifest IS a fault', denied.address === null && denied.fault !== null, true);
// `|| ''` so a red check above reports as red rather than throwing here and
// taking the rest of the suite with it - measured: the uid mutant killed the
// check above and then aborted the run, hiding every check after it.
eq('...and the fault names the reason', (denied.fault || '').indexOf('EACCES') > -1, true);

// THE POSITIVE CONTROL FOR THAT CHECK, and it is not decoration. `unreadable`
// is a byte-for-byte copy of `with-registry` in the same directory; the only
// difference between them is the mode. So the pair proves the fault comes from
// the PERMISSION - if the path were simply wrong, or the directory untraversable,
// the readable one would fail too, and if the suite were running as root the
// unreadable one would return the address and this would go red.
eq('the two fixtures differ only by mode, so the fault is the permission',
   [overview.readRegistry('/fixtures/with-registry.json').address,
    overview.readRegistry('/fixtures/unreadable.json').address],
   ['0x2222222222222222222222222222222222222222', null]);

eq('a manifest that is not JSON is a fault',
   overview.readRegistry('/fixtures/broken.json').fault !== null, true);
eq('a manifest with no modules list is a fault',
   overview.readRegistry('/fixtures/no-modules.json').fault !== null, true);

// And the page says the honest thing for each: a fault is reported as a fault,
// and an absent registry as an absent registry.
var faulted = overview.renderPage({ chainId: 1, height: 1, blocks: [], names: null,
                                    manifestFault: 'cannot read /deployments/local.json: EACCES' });
eq('a manifest fault is on the page, not "no registry"',
   [faulted.indexOf('could not be read') > -1, faulted.indexOf('has no name registry') > -1],
   [true, false]);
var absent = overview.renderPage({ chainId: 1, height: 1, blocks: [], names: null, manifestFault: null });
eq('...and with no fault the page says there is no registry',
   [absent.indexOf('has no name registry') > -1, absent.indexOf('could not be read') > -1],
   [true, false]);

// ------------------------------------------------------------------ verdict

console.log('');
if (failures === 0) {
    console.log('PASS: ' + checks + ' checks');
} else {
    console.log('FAIL: ' + failures + ' of ' + checks + ' checks');
}
