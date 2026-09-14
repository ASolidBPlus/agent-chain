// §3.1. Per-argument validation against the ABI, before anything is encoded.
//
// THIS EXISTS BECAUSE VIEM'S ERRORS CANNOT BE TRANSLATED. Measured on the
// pinned 2.56.3: arity gives `AbiEncodingLengthMismatchError` with counts and
// no names; a bad address gives `InvalidAddressError` naming the value but not
// where it was; a bad bool gives a bare `BaseError`; a bad uint string gives a
// raw `SyntaxError` out of BigInt(); and a non-hex string in a `bytes32` slot is
// not an error at all - it is read as raw bytes and fails on SIZE, so the
// message talks about length. None of that carries an argument index, so a
// refusal a model can act on cannot be built by catching and rewording it. The
// validator runs first, and viem's encoder only ever sees values that already
// type-check; an error from the encoder after this means the validator and the
// ABI disagree, which is a bug here and not a caller's problem.
//
// WHAT IT DOES NOT DO: resolve addresses. For wallet scope an `address`
// argument arrives as `{token|contract|name: "..."}` and leaves the same way -
// this layer says the SHAPE is one some rule could accept, and §3.2 step 5
// applies the entry's own `addressArgs` rule for that index and turns it into
// an address. Only step 5 knows the allowlist, and only this knows the ABI.

import type { AbiParameter } from 'viem';
import { checksumAddress, isAddress } from 'viem';
import { HttpError } from './errors.ts';

/// A wallet-scope address argument, as it arrives and as it leaves here.
export type WireAddress = { token: string } | { contract: string } | { name: string };

export type EncodableArg =
  | bigint
  | boolean
  | string
  | WireAddress
  | EncodableArg[]
  | { [component: string]: EncodableArg };

export type CallScope = 'wallet' | 'platform';

/// The wire forms a wallet-scope address may take. ONE KEY, and the key names
/// which namespace the value lives in.
const ADDRESS_KEYS = ['token', 'contract', 'name'] as const;

/// 1024 BYTES, not characters: the bound exists to bound the calldata, and a
/// cap counted in UTF-16 units would admit 1024 astral characters, which is
/// 4096 bytes.
const MAX_STRING_BYTES = 1024;

/// A dynamic array a caller may send. Bounded because nothing else bounds it -
/// the 64 KiB body cap is generous enough to hold thousands of short elements,
/// and every element costs an encode and a chain-side loop.
const MAX_ARRAY_ELEMENTS = 256;

const utf8 = new TextEncoder();

/// `uint256` -> 256, `uint` -> 256, and null for anything that is not a uint.
function uintBits(type: string): number | null {
  if (type === 'uint') return 256;
  const m = /^uint(\d+)$/.exec(type);
  if (!m) return null;
  const bits = Number(m[1]);
  // Solidity only has multiples of 8 up to 256. `uint7` is not a narrower
  // uint8 - it is not a type, and accepting it would encode against an ABI
  // no compiler produced.
  return bits >= 8 && bits <= 256 && bits % 8 === 0 ? bits : null;
}

function intBits(type: string): number | null {
  if (type === 'int') return 256;
  const m = /^int(\d+)$/.exec(type);
  if (!m) return null;
  const bits = Number(m[1]);
  return bits >= 8 && bits <= 256 && bits % 8 === 0 ? bits : null;
}

/// `bytes32` -> 32, and null for `bytes` (dynamic) or a width Solidity has no
/// type for.
function bytesWidth(type: string): number | null {
  const m = /^bytes(\d+)$/.exec(type);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 32 ? n : null;
}

/// `uint256[3]` -> { element: 'uint256', length: 3 }; `uint256[]` -> length null.
function arrayOf(type: string): { element: string; length: number | null } | null {
  const m = /^(.*)\[(\d*)\]$/.exec(type);
  if (!m) return null;
  return { element: m[1]!, length: m[2] === '' ? null : Number(m[2]) };
}

function components(param: AbiParameter): readonly AbiParameter[] {
  return (param as { components?: readonly AbiParameter[] }).components ?? [];
}

/// Every type this validator can check. The ALLOWLIST LOADER calls this, so an
/// unsupported type closes the op when the file loads - in front of the
/// operator who wrote it - rather than surfacing at call time in front of a
/// persona, or as a 500 nobody can act on.
export function assertSupportedType(param: AbiParameter): void {
  const { type } = param;

  const arr = arrayOf(type);
  if (arr) {
    if (arr.length !== null && (!Number.isInteger(arr.length) || arr.length < 1)) {
      throw new Error(`unsupported parameter type "${type}"`);
    }
    assertSupportedType({ ...param, type: arr.element } as AbiParameter);
    return;
  }

  if (type === 'tuple') {
    const inner = components(param);
    if (inner.length === 0) throw new Error(`unsupported parameter type "tuple" with no components`);
    for (const c of inner) assertSupportedType(c);
    return;
  }

  if (
    uintBits(type) !== null ||
    intBits(type) !== null ||
    bytesWidth(type) !== null ||
    type === 'bool' ||
    type === 'address' ||
    type === 'bytes' ||
    type === 'string'
  ) {
    return;
  }

  throw new Error(`unsupported parameter type "${type}"`);
}

/// `argument 2 (amountIn)`, `argument 0 (a)[1]`, `argument 0 (pair).amount`.
/// The path is the whole point: "expected uint256" against a three-element
/// array does not say which element to fix.
function refuse(path: string, expected: string): never {
  throw new HttpError('bad_args', `${path}: expected ${expected}`);
}

const DECIMAL = /^\d{1,78}$/;
const SIGNED_DECIMAL = /^-?\d{1,78}$/;
const HEX = /^0x[0-9a-fA-F]*$/;

function validateOne(param: AbiParameter, value: unknown, path: string, scope: CallScope): EncodableArg {
  const { type } = param;

  const arr = arrayOf(type);
  if (arr) {
    if (!Array.isArray(value)) refuse(path, type);
    if (arr.length !== null && value.length !== arr.length) {
      refuse(path, `exactly ${arr.length} elements`);
    }
    if (arr.length === null && value.length > MAX_ARRAY_ELEMENTS) {
      refuse(path, `at most ${MAX_ARRAY_ELEMENTS} elements`);
    }
    const element = { ...param, type: arr.element } as AbiParameter;
    return value.map((v, i) => validateOne(element, v, `${path}[${i}]`, scope));
  }

  if (type === 'tuple') {
    // An OBJECT keyed by component name, never a positional array: two wire
    // forms for one type is one too many, and the array form is ambiguous with
    // a fixed-size array of the same arity.
    if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse(path, type);
    const inner = components(param);
    const supplied = new Set(Object.keys(value as Record<string, unknown>));
    const out: Record<string, EncodableArg> = {};
    for (const c of inner) {
      if (!supplied.delete(c.name ?? '')) refuse(`${path}.${c.name ?? '?'}`, c.type);
      out[c.name!] = validateOne(
        c,
        (value as Record<string, unknown>)[c.name!],
        `${path}.${c.name}`,
        scope,
      );
    }
    // An unknown component is a caller who thinks this function takes something
    // it does not. Ignoring it silently would encode the call they did not make.
    if (supplied.size > 0) refuse(path, `${type} without ${[...supplied].join(', ')}`);
    return out;
  }

  const uint = uintBits(type);
  if (uint !== null) {
    // A DECIMAL STRING, never a JSON number. 2^53 is where a JSON number stops
    // being exact and a wei amount passes that at one whole token, so a number
    // is already damaged by the time JSON.parse hands it over - the type is
    // refused rather than the value inspected. parseVee and isCap refuse it the
    // same way for the same reason.
    if (typeof value !== 'string' || !DECIMAL.test(value)) refuse(path, type);
    const n = BigInt(value);
    if (n > 2n ** BigInt(uint) - 1n) refuse(path, type);
    return n;
  }

  const int = intBits(type);
  if (int !== null) {
    if (typeof value !== 'string' || !SIGNED_DECIMAL.test(value)) refuse(path, type);
    const n = BigInt(value);
    const bound = 2n ** BigInt(int - 1);
    if (n > bound - 1n || n < -bound) refuse(path, type);
    return n;
  }

  if (type === 'bool') {
    // A JSON boolean only. "false" is a truthy string, so a validator that
    // coerced would turn a caller's "false" into true - the one wrong answer
    // that looks like it worked.
    if (typeof value !== 'boolean') refuse(path, type);
    return value;
  }

  if (type === 'address') {
    if (scope === 'platform') {
      // CHECKSUMMED, because the checksum is a typo detector and platform scope
      // is the only caller that may pass a raw address at all. An admin-call
      // goes to whatever address it is given, so a mistyped one is not caught
      // by anything downstream.
      //
      // `isAddress(v, { strict: true })` IS NOT THIS CHECK, measured on 2.56.3:
      // it accepts an all-lowercase address, because EIP-55 reads all-lowercase
      // as "no checksum claimed" rather than as a wrong one. That is the right
      // reading of the standard and the wrong one for a typo detector - it
      // passes exactly the form a human typing an address by hand produces. So
      // the check is equality with the checksummed spelling, and the strict
      // flag is left to do the format half.
      if (
        typeof value !== 'string' ||
        !isAddress(value, { strict: false }) ||
        checksumAddress(value) !== value
      ) {
        // "a checksummed address", not "address": the operator who lowercased
        // one needs to see the FIX. A refusal naming the type would send them
        // to check that they passed an address, which they did.
        refuse(path, 'a checksummed address');
      }
      return value;
    }
    // Wallet scope: a persona sees names, never addresses. The shape, not the
    // rule - §3.2 step 5 owns which of the three this index may take.
    if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse(path, type);
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length !== 1) refuse(path, type);
    const key = keys[0] as (typeof ADDRESS_KEYS)[number];
    if (!ADDRESS_KEYS.includes(key)) refuse(path, type);
    if (typeof (value as Record<string, unknown>)[key] !== 'string') refuse(path, type);
    return value as WireAddress;
  }

  const width = bytesWidth(type);
  if (width !== null) {
    // EXACTLY 2N hex digits. viem would read a non-hex string as raw bytes and
    // fail on size, so without this the refusal would send the caller to count
    // characters in a word that was never hex.
    if (typeof value !== 'string' || !HEX.test(value) || value.length !== 2 + width * 2) {
      refuse(path, type);
    }
    return value;
  }

  if (type === 'bytes') {
    if (typeof value !== 'string' || !HEX.test(value) || value.length % 2 !== 0) refuse(path, type);
    return value;
  }

  if (type === 'string') {
    if (typeof value !== 'string') refuse(path, type);
    if (utf8.encode(value).length > MAX_STRING_BYTES) {
      refuse(path, `string of at most ${MAX_STRING_BYTES} bytes`);
    }
    return value;
  }

  // UNREACHABLE THROUGH THE ALLOWLIST, and written anyway. Every entry's
  // parameters go through assertSupportedType when calls.json loads, so a type
  // this function cannot check closes the op at load. If one arrives here the
  // two lists have drifted, which is a bug in this file - an internal_error,
  // not a bad_args, because the caller did nothing wrong.
  throw new HttpError(
    'internal_error',
    `callargs: no rule for parameter type "${type}" at ${path}`,
  );
}

/// Validates every argument against the function's ABI inputs, left to right.
///
/// ARITY FIRST, before any argument is looked at: validating index 0 first
/// would answer a call that supplied nothing at all with "argument 0: expected
/// uint256", sending the caller to fix a value rather than to add one.
export function validateArgs(
  inputs: readonly AbiParameter[],
  args: unknown[],
  scope: CallScope,
): EncodableArg[] {
  if (args.length !== inputs.length) {
    throw new HttpError('bad_args', `expected ${inputs.length} arguments, got ${args.length}`);
  }
  return inputs.map((param, i) =>
    validateOne(param, args[i], `argument ${i} (${param.name ?? ''})`, scope),
  );
}
