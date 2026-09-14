// §3.1. THE ARGUMENT VALIDATOR, ALONE.
//
// WHY THIS EXISTS AT ALL, rather than letting viem's encoder be the check:
// viem's errors carry no argument index. Measured on the pinned 2.56.3 -
// arity gives `AbiEncodingLengthMismatchError` with counts and no names; a bad
// address gives `InvalidAddressError` naming the value but not where it was; a
// bad bool gives a bare `BaseError`; a bad uint string gives a raw `SyntaxError`
// from BigInt(); and a non-hex string for `bytes32` is not an error at all - it
// is read as raw bytes and fails on SIZE, with a message about length. A
// refusal a model can act on ("argument 2 (amountIn): expected uint256") cannot
// be built by translating any of that, so the validation happens first and
// viem's encoder only ever sees values that already type-check.
//
// The tests are per RULE, not per function: each ABI type gets one value that
// must be accepted and one that must be refused, because a validator that
// accepts everything and one that refuses everything both pass a suite that
// only checks one side.

import { describe, it, expect } from 'bun:test';
import type { AbiParameter } from 'viem';
import { validateArgs, assertSupportedType } from '../src/callargs.ts';
import { HttpError } from '../src/errors.ts';

const p = (type: string, name = ''): AbiParameter => ({ type, name }) as AbiParameter;

const CHECKSUMMED = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const LOWERCASE = CHECKSUMMED.toLowerCase();

/// The refusal, or `undefined` if the call was accepted. Returning rather than
/// asserting inside, so each test says what it expects in its own body.
function refusal(inputs: AbiParameter[], args: unknown[], scope: 'wallet' | 'platform' = 'wallet') {
  try {
    validateArgs(inputs, args, scope);
    return undefined;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return err;
  }
}

const accept = (inputs: AbiParameter[], args: unknown[], scope: 'wallet' | 'platform' = 'wallet') =>
  validateArgs(inputs, args, scope);

describe('arity', () => {
  it('refuses too few and too many, counting both sides', () => {
    const inputs = [p('uint256', 'a'), p('uint256', 'b'), p('uint256', 'c')];
    const short = refusal(inputs, ['1', '2']);
    expect(short?.code).toBe('bad_args');
    expect(short?.detail).toBe('expected 3 arguments, got 2');
    expect(refusal(inputs, ['1', '2', '3', '4'])?.detail).toBe('expected 3 arguments, got 4');
  });

  it('is checked before any argument, so a short call is not also a type error', () => {
    // Order matters for the message: validating index 0 first would report
    // "argument 0: expected uint256" for a call that supplied no arguments at
    // all, sending the caller to fix a value rather than to add one.
    expect(refusal([p('uint256', 'a')], [])?.detail).toBe('expected 1 arguments, got 0');
  });

  it('accepts an empty argument list for a function that takes none', () => {
    expect(accept([], [])).toEqual([]);
  });
});

describe('uint', () => {
  it('accepts a decimal string and converts it to a bigint', () => {
    expect(accept([p('uint256', 'amount')], ['40'])).toEqual([40n]);
    expect(accept([p('uint256', 'amount')], ['0'])).toEqual([0n]);
  });

  it('refuses a JSON number, which is the whole point', () => {
    // The same hazard parseVee and isCap already refuse: 2^53 is where a JSON
    // number stops being exact, and a wei-denominated amount passes that on the
    // way past one whole token at 18 decimals. A number that ARRIVES here has
    // already been through JSON.parse, so the damage is done before any check
    // this code could make - which is why the type itself is refused rather
    // than the value inspected.
    const r = refusal([p('uint256', 'amount')], [40]);
    expect(r?.code).toBe('bad_args');
    expect(r?.detail).toBe('argument 0 (amount): expected uint256');
  });

  it('refuses a negative, a decimal point, and other non-digits', () => {
    for (const bad of ['-1', '1.5', '1e18', ' 1', '1 ', '0x10', '', 'abc']) {
      expect(refusal([p('uint256', 'amount')], [bad])?.code).toBe('bad_args');
    }
  });

  it('accepts the maximum of the declared width and refuses one more', () => {
    // WIDTH IS PART OF THE TYPE, and a value that overflows it is not caught by
    // the digit check - viem would encode 2^8 into a uint8 slot by truncation
    // if it encoded it at all. The contract's own bound is what the ABI says.
    expect(accept([p('uint8', 'n')], ['255'])).toEqual([255n]);
    expect(refusal([p('uint8', 'n')], ['256'])?.detail).toBe('argument 0 (n): expected uint8');

    const max256 = (2n ** 256n - 1n).toString();
    expect(accept([p('uint256', 'n')], [max256])).toEqual([2n ** 256n - 1n]);
    expect(refusal([p('uint256', 'n')], [(2n ** 256n).toString()])?.code).toBe('bad_args');
  });

  it('reads bare `uint` as uint256', () => {
    expect(accept([p('uint', 'n')], ['7'])).toEqual([7n]);
  });

  it('refuses a string longer than any uint256, without parsing it', () => {
    expect(refusal([p('uint256', 'n')], ['9'.repeat(79)])?.code).toBe('bad_args');
  });
});

describe('int', () => {
  it('accepts a signed decimal string', () => {
    expect(accept([p('int256', 'delta')], ['-40'])).toEqual([-40n]);
    expect(accept([p('int256', 'delta')], ['40'])).toEqual([40n]);
  });

  it('refuses a JSON number here too', () => {
    expect(refusal([p('int256', 'delta')], [-40])?.code).toBe('bad_args');
  });

  it('holds both ends of the declared width', () => {
    expect(accept([p('int8', 'n')], ['127'])).toEqual([127n]);
    expect(accept([p('int8', 'n')], ['-128'])).toEqual([-128n]);
    expect(refusal([p('int8', 'n')], ['128'])?.code).toBe('bad_args');
    expect(refusal([p('int8', 'n')], ['-129'])?.code).toBe('bad_args');
  });

  it('refuses a lone minus and a double sign', () => {
    for (const bad of ['-', '--1', '+1', '- 1']) {
      expect(refusal([p('int256', 'n')], [bad])?.code).toBe('bad_args');
    }
  });
});

describe('bool', () => {
  it('accepts a JSON boolean only', () => {
    expect(accept([p('bool', 'flag')], [true])).toEqual([true]);
    expect(accept([p('bool', 'flag')], [false])).toEqual([false]);
  });

  it('refuses the strings that look like booleans', () => {
    // "false" is truthy as a string, so a validator that coerced would turn a
    // caller's "false" into true - the one wrong answer that looks like it
    // worked.
    for (const bad of ['true', 'false', 0, 1, null]) {
      expect(refusal([p('bool', 'flag')], [bad])?.detail).toBe('argument 0 (flag): expected bool');
    }
  });
});

describe('address', () => {
  it('takes the wire forms for wallet scope and passes them through untouched', () => {
    // NOT RESOLVED HERE. This validator says the shape is one a rule could
    // accept; §3.2 step 5 applies the entry's own rule for that index and turns
    // it into an address. Two layers because only step 5 knows the allowlist.
    expect(accept([p('address', 'token')], [{ token: 'play' }])).toEqual([{ token: 'play' }]);
    expect(accept([p('address', 'c')], [{ contract: 'shop' }])).toEqual([{ contract: 'shop' }]);
    expect(accept([p('address', 'to')], [{ name: 'alpha' }])).toEqual([{ name: 'alpha' }]);
  });

  it('refuses a raw address from wallet scope', () => {
    // Joel's rule: a persona sees names, never addresses. A persona that can
    // pass a raw address can pay an address nobody registered, which is the
    // one counterparty the deny list cannot name.
    const r = refusal([p('address', 'to')], [CHECKSUMMED]);
    expect(r?.code).toBe('bad_args');
    expect(r?.detail).toBe('argument 0 (to): expected address');
  });

  it('refuses an object with two keys, or a wrong key, or a non-string value', () => {
    for (const bad of [
      { token: 'play', name: 'alpha' },
      { address: '0x0' },
      {},
      { token: 1 },
      { token: null },
      [{ token: 'play' }],
    ]) {
      expect(refusal([p('address', 'to')], [bad])?.code).toBe('bad_args');
    }
  });

  it('takes a checksummed address for platform scope, and refuses a wire form', () => {
    expect(accept([p('address', 'to')], [CHECKSUMMED], 'platform')).toEqual([CHECKSUMMED]);
    expect(refusal([p('address', 'to')], [{ name: 'alpha' }], 'platform')?.code).toBe('bad_args');
  });

  it('refuses an unchecksummed address for platform scope', () => {
    // The checksum is a typo detector and the hub is the only caller that may
    // pass raw addresses at all. Accepting lowercase would silently accept a
    // mistyped one, and an admin-call goes to whatever address it is given.
    const r = refusal([p('address', 'to')], [LOWERCASE], 'platform');
    expect(r?.code).toBe('bad_args');
    // The detail names the FIX, not the type: an operator who lowercased an
    // address would otherwise be sent to check that they passed an address.
    expect(r?.detail).toBe('argument 0 (to): expected a checksummed address');
  });

  it('refuses a malformed address for platform scope', () => {
    for (const bad of ['0x', '0x1234', `${CHECKSUMMED}00`, 'not an address', 42]) {
      expect(refusal([p('address', 'to')], [bad], 'platform')?.code).toBe('bad_args');
    }
  });
});

describe('bytes', () => {
  it('accepts exactly 2N hex for bytesN', () => {
    const tag = `0x${'ab'.repeat(32)}`;
    expect(accept([p('bytes32', 'tag')], [tag])).toEqual([tag]);
    expect(accept([p('bytes4', 'sel')], ['0xdeadbeef'])).toEqual(['0xdeadbeef']);
  });

  it('refuses the wrong length for bytesN, in both directions', () => {
    expect(refusal([p('bytes32', 'tag')], [`0x${'ab'.repeat(31)}`])?.detail).toBe(
      'argument 0 (tag): expected bytes32',
    );
    expect(refusal([p('bytes32', 'tag')], [`0x${'ab'.repeat(33)}`])?.code).toBe('bad_args');
  });

  it('refuses a non-hex string for bytesN, which viem would NOT refuse', () => {
    // Measured: viem reads a non-hex string as raw bytes and fails on size, so
    // "hello" in a bytes32 slot produces a message about length. Without this
    // rule the refusal would send the caller to count characters.
    expect(refusal([p('bytes32', 'tag')], ['hello'])?.code).toBe('bad_args');
    expect(refusal([p('bytes32', 'tag')], [`0x${'zz'.repeat(32)}`])?.code).toBe('bad_args');
  });

  it('accepts any even-length hex for dynamic bytes, including empty', () => {
    expect(accept([p('bytes', 'data')], ['0x'])).toEqual(['0x']);
    expect(accept([p('bytes', 'data')], ['0xdeadbeef'])).toEqual(['0xdeadbeef']);
    expect(refusal([p('bytes', 'data')], ['0xabc'])?.code).toBe('bad_args');
  });
});

describe('string', () => {
  it('accepts a JSON string up to 1024 bytes', () => {
    expect(accept([p('string', 's')], ['hello'])).toEqual(['hello']);
    expect(accept([p('string', 's')], ['x'.repeat(1024)])?.[0]).toHaveLength(1024);
  });

  it('measures the cap in BYTES, not characters', () => {
    // A cap counted in UTF-16 units would let a caller send 1024 astral
    // characters - 4096 bytes on the wire and in the calldata. The bound exists
    // to bound the calldata, so it is counted where the calldata is.
    const emoji = '😀'.repeat(256); // 256 chars, 1024 bytes
    expect(accept([p('string', 's')], [emoji])).toEqual([emoji]);
    expect(refusal([p('string', 's')], ['😀'.repeat(257)])?.code).toBe('bad_args');
  });

  it('refuses a non-string', () => {
    expect(refusal([p('string', 's')], [42])?.detail).toBe('argument 0 (s): expected string');
  });
});

describe('arrays', () => {
  it('accepts a dynamic array of a supported type, element by element', () => {
    expect(accept([p('uint256[]', 'amounts')], [['1', '2', '3']])).toEqual([[1n, 2n, 3n]]);
  });

  it('bounds a dynamic array at 256 elements', () => {
    const at = Array.from({ length: 256 }, () => '1');
    expect(accept([p('uint256[]', 'a')], [at])[0]).toHaveLength(256);
    expect(refusal([p('uint256[]', 'a')], [[...at, '1']])?.code).toBe('bad_args');
  });

  it('requires exactly N elements for a fixed-size array', () => {
    expect(accept([p('uint256[3]', 'a')], [['1', '2', '3']])).toEqual([[1n, 2n, 3n]]);
    const r = refusal([p('uint256[3]', 'a')], [['1', '2']]);
    expect(r?.detail).toBe('argument 0 (a): expected exactly 3 elements');
    expect(refusal([p('uint256[3]', 'a')], [['1', '2', '3', '4']])?.code).toBe('bad_args');
  });

  it('refuses a non-array, and a bad element inside a good array', () => {
    expect(refusal([p('uint256[]', 'a')], ['1'])?.code).toBe('bad_args');
    const r = refusal([p('uint256[]', 'a')], [['1', 2, '3']]);
    expect(r?.code).toBe('bad_args');
    // The path says WHICH element, because "expected uint256" against a
    // three-element array does not say which one to fix.
    expect(r?.detail).toBe('argument 0 (a)[1]: expected uint256');
  });

  it('handles an array of addresses in each scope', () => {
    expect(accept([p('address[]', 'tos')], [[{ name: 'alpha' }, { token: 'play' }]])).toEqual([
      [{ name: 'alpha' }, { token: 'play' }],
    ]);
    expect(refusal([p('address[]', 'tos')], [[CHECKSUMMED]])?.code).toBe('bad_args');
    expect(accept([p('address[]', 'tos')], [[CHECKSUMMED]], 'platform')).toEqual([[CHECKSUMMED]]);
  });
});

describe('tuples', () => {
  const pair = {
    type: 'tuple',
    name: 'pair',
    components: [
      { type: 'address', name: 'token' },
      { type: 'uint256', name: 'amount' },
    ],
  } as unknown as AbiParameter;

  it('accepts an object keyed by component name', () => {
    expect(accept([pair], [{ token: { token: 'play' }, amount: '40' }])).toEqual([
      { token: { token: 'play' }, amount: 40n },
    ]);
  });

  it('names the component in the refusal', () => {
    const r = refusal([pair], [{ token: { token: 'play' }, amount: 40 }]);
    expect(r?.detail).toBe('argument 0 (pair).amount: expected uint256');
  });

  it('refuses a missing component and an unknown one', () => {
    expect(refusal([pair], [{ token: { token: 'play' } }])?.code).toBe('bad_args');
    expect(
      refusal([pair], [{ token: { token: 'play' }, amount: '1', extra: '1' }])?.code,
    ).toBe('bad_args');
  });

  it('refuses an array for a tuple', () => {
    // Positional tuples would be a second wire form for one type, and the one
    // that is ambiguous with a fixed-size array.
    expect(refusal([pair], [[{ token: 'play' }, '40']])?.code).toBe('bad_args');
  });

  it('nests arrays of tuples', () => {
    const many = { type: 'tuple[]', name: 'pairs', components: (pair as never as { components: unknown[] }).components } as unknown as AbiParameter;
    expect(accept([many], [[{ token: { token: 'play' }, amount: '1' }]])).toEqual([
      [{ token: { token: 'play' }, amount: 1n }],
    ]);
  });
});

describe('assertSupportedType', () => {
  // The allowlist loader calls this for every parameter of every entry, so an
  // unsupported type is refused when the FILE loads and the op stays closed -
  // never at call time in front of a persona, and never as a surprise 500.
  it('accepts every type the validator implements', () => {
    for (const type of [
      'uint256',
      'uint8',
      'int256',
      'bool',
      'address',
      'bytes32',
      'bytes',
      'string',
      'uint256[]',
      'address[3]',
    ]) {
      expect(() => assertSupportedType(p(type, 'x'))).not.toThrow();
    }
  });

  it('refuses a type the validator cannot check', () => {
    for (const type of ['function', 'fixed128x18', 'uint7', 'bytes33', 'uint264']) {
      expect(() => assertSupportedType(p(type, 'x'))).toThrow(/unsupported parameter type/);
    }
  });

  it('looks inside arrays and tuples', () => {
    expect(() => assertSupportedType(p('fixed128x18[]', 'x'))).toThrow(/unsupported parameter type/);
    const t = {
      type: 'tuple',
      name: 't',
      components: [{ type: 'function', name: 'f' }],
    } as unknown as AbiParameter;
    expect(() => assertSupportedType(t)).toThrow(/unsupported parameter type/);
  });
});
