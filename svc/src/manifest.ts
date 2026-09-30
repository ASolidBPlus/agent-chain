// The manifest grammar, ported rule for rule from Deploy.s.sol.
//
// A stack deploys either through the boot container, which runs Deploy.s.sol,
// or through POST /admin/deploy, which runs this. The two must accept and refuse
// the same documents, or switching paths changes which manifests work - so this
// is a port and not a re-design, and deployments/cases/manifest-cases.json is
// run through BOTH implementations to prove they agree. Refusal wording may
// differ; the accept-or-refuse outcome may not.
//
// FORGE'S JSON CHEATCODES ARE THE SPECIFICATION, not what they look like they
// should do, and every behaviour below that surprised was measured on forge
// 1.8.1 rather than assumed:
//
//   parseJsonString  coerces a number, boolean or null to its text: 1 -> "1",
//                    true -> "true", null -> "null". A number keeps its source
//                    text exactly, at any precision, except that an exponent is
//                    normalised: 1e3 -> "1e+3", 1E2 -> "1e+2". An object or a
//                    missing key is refused.
//   parseJsonUint    accepts a JSON integer, or a string of decimal or 0x-hex:
//                    1, "1" and "0x1" are all 1. 1.0 and true are refused.
//   parseUint        decimal, 0x or 0X hex, and scientific notation when the
//                    result is a whole number (1e3, 1.5e3); not 1.0, 1.5 or 1e-1.
//   parseAddress     40 hex digits with or without 0x, ANY case - the checksum
//                    is not checked.
//   parseBytes32     64 hex digits with or without 0x; a short value is not
//                    padded, and an uppercase 0X is refused.
//
// JSON NUMBERS ARE READ FROM THEIR SOURCE TEXT. JSON.parse rounds an integer past
// 2^53, so `"initialSupply": 123456789012345678` would be accepted by both paths
// and mint a different amount on this one - agreement on the outcome, and a
// silently wrong value. parseManifestText keeps every number's text instead.

import { HttpError } from './errors.ts';

export const SCHEMA = 1n;
export const RATE_SCALE = 10n ** 18n;
export const MAX_RATE = 10n ** 30n;
const UINT256_MAX = (1n << 256n) - 1n;

export const KIND_TOKEN = 'token';
export const KIND_NAMES = 'names';
export const KIND_CONVERTER = 'converter';
export const KIND_CONTRACT = 'contract';

/// A JSON number, carried as the text forge would coerce it to.
export class JsonNumber {
  constructor(readonly source: string) {}
}

export interface ContractArg {
  type: string;
  value: string;
}

export interface ModuleSpec {
  kind: string;
  /// The key for token and contract; absent for the singletons.
  key?: string;
  /// A token's name, or a contract entry's Solidity contract name.
  name?: string;
  symbol?: string;
  initialSupply?: bigint;
  tld?: string;
  args?: ContractArg[];
}

export interface ConverterPair {
  source: string;
  target: string;
  rate: bigint;
}

export interface Manifest {
  modules: ModuleSpec[];
  pairs: ConverterPair[];
}

export class ManifestError extends HttpError {
  constructor(detail: string) {
    super('invalid_request', `manifest: ${detail}`);
  }
}

const refuse = (detail: string): never => {
  throw new ManifestError(detail);
};

/// JSON.parse, keeping every number as the text forge would coerce it to.
export function parseManifestText(text: string): unknown {
  try {
    return JSON.parse(text, (_key, value: unknown, ctx?: { source?: string }) =>
      typeof value === 'number' ? new JsonNumber(normaliseNumberText(ctx?.source ?? String(value))) : value,
    );
  } catch {
    return refuse('the document is not valid JSON');
  }
}

/// forge writes an exponent as a lowercase `e` with an explicit sign.
function normaliseNumberText(source: string): string {
  return source.replace(/[eE]([+-]?)(\d+)$/, (_m, sign: string, digits: string) => `e${sign || '+'}${digits}`);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof JsonNumber);

/// forge's parseJsonString, for a node already located.
function jsonString(node: unknown, where: string): string {
  if (node === undefined) return refuse(`${where} is missing`);
  if (typeof node === 'string') return node;
  if (node instanceof JsonNumber) return node.source;
  if (typeof node === 'boolean') return node ? 'true' : 'false';
  if (node === null) return 'null';
  return refuse(`${where} must be a string`);
}

/// forge's parseJsonUint, for a node already located.
function jsonUint(node: unknown, where: string): bigint {
  if (node instanceof JsonNumber) {
    if (!/^\d+$/.test(node.source)) return refuse(`${where} must be an unsigned integer`);
    return BigInt(node.source);
  }
  if (typeof node === 'string') {
    const v = parseUintLike(node);
    if (v === null) return refuse(`${where} must be an unsigned integer`);
    return v;
  }
  return refuse(`${where} must be an unsigned integer`);
}

/// forge's parseUint. null for anything it refuses.
export function parseUintLike(s: string): bigint | null {
  let v: bigint;
  if (/^\d+$/.test(s)) {
    v = BigInt(s);
  } else if (/^0[xX][0-9a-fA-F]+$/.test(s)) {
    v = BigInt(`0x${s.slice(2)}`);
  } else {
    // Scientific notation, accepted only when the value is a whole number.
    const m = /^(\d+)(?:\.(\d+))?[eE]([+-]?)(\d+)$/.exec(s);
    if (!m) return null;
    const frac = m[2] ?? '';
    const mantissa = BigInt(m[1] + frac);
    const exp = BigInt(`${m[3] === '-' ? '-' : ''}${m[4]}`) - BigInt(frac.length);
    if (exp >= 0n) {
      v = mantissa * 10n ** exp;
    } else {
      const div = 10n ** -exp;
      if (mantissa % div !== 0n) return null;
      v = mantissa / div;
    }
  }
  return v <= UINT256_MAX ? v : null;
}

export const isKey = (s: string): boolean => /^[a-z][a-z0-9]{0,15}$/.test(s);
/// Counted in BYTES, as Solidity does - a JavaScript length counts UTF-16 units.
export const isName = (s: string): boolean => {
  const n = Buffer.byteLength(s, 'utf8');
  return n > 0 && n <= 64;
};
export const isSymbol = (s: string): boolean => /^[A-Z][A-Z0-9]{0,9}$/.test(s);

/// A token's initialSupply: 1 to 18 ASCII digits, in whole units.
function parseWholeUnits(s: string, key: string): bigint {
  if (!/^\d{1,18}$/.test(s)) return refuse(`"${key}" has an invalid initialSupply`);
  return BigInt(s);
}

/// A rate, scaled by 1e18: digits and at most one dot, not leading, at most 18
/// places, greater than 0 and at most MAX_RATE. "5." is five.
export function parseDecimal18(s: string): bigint {
  if (!/^[0-9.]*$/.test(s) || (s.match(/\./g) ?? []).length > 1) return refuse(`"${s}" is not a decimal`);
  const dot = s.indexOf('.');
  const dotPos = dot === -1 ? s.length : dot;
  if (dotPos === 0) return refuse(`"${s}" is not a decimal`);
  const intPart = BigInt(s.slice(0, dotPos));
  if (intPart > MAX_RATE / RATE_SCALE) return refuse('rate exceeds MAX_RATE');
  let result = intPart * RATE_SCALE;
  if (dot !== -1) {
    const fracText = s.slice(dot + 1);
    if (fracText.length > 18) return refuse('rate has more than 18 decimal places');
    if (fracText.length > 0) result += BigInt(fracText) * 10n ** BigInt(18 - fracText.length);
  }
  if (result === 0n) return refuse('rate must be > 0');
  if (result > MAX_RATE) return refuse('rate exceeds MAX_RATE');
  return result;
}

/// The identifier an entry occupies in the one shared key namespace.
export const effectiveKey = (m: ModuleSpec): string =>
  m.kind === KIND_TOKEN || m.kind === KIND_CONTRACT ? (m.key as string) : m.kind;

/// Deploy.s.sol `_readManifest`, `_readConverterPairs` and the contract-argument
/// rules, in their order. Throws ManifestError on the first refusal.
export function readManifest(doc: unknown): Manifest {
  if (!isObject(doc)) return refuse('the document must be a JSON object');
  if (jsonUint(doc.schema, 'schema') !== SCHEMA) return refuse(`schema ${String(doc.schema)} unsupported`);

  const list = Array.isArray(doc.modules) ? doc.modules : [];
  if (list.length === 0) return refuse('at least one module is required');

  const mods: ModuleSpec[] = [];
  let namesSeen = 0;
  let convertersSeen = 0;
  for (let i = 0; i < list.length; i++) {
    const node = list[i] as Record<string, unknown> | null;
    const field = (name: string): unknown => (isObject(node) ? node[name] : undefined);
    const kind = jsonString(field('kind'), `modules[${i}].kind`);
    let m: ModuleSpec;

    if (kind === KIND_TOKEN) {
      const key = jsonString(field('key'), `modules[${i}].key`);
      const name = jsonString(field('name'), `modules[${i}].name`);
      const symbol = jsonString(field('symbol'), `modules[${i}].symbol`);
      const initialSupply =
        field('initialSupply') !== undefined
          ? parseWholeUnits(jsonString(field('initialSupply'), `modules[${i}].initialSupply`), key)
          : 0n;
      if (!isKey(key)) refuse(`"${key}" has an invalid key`);
      if (!isName(name)) refuse(`"${key}" has an invalid name`);
      if (!isSymbol(symbol)) refuse(`"${key}" has an invalid symbol`);
      for (const prior of mods) {
        if (prior.kind === KIND_TOKEN && prior.symbol === symbol) refuse(`duplicate symbol "${symbol}"`);
      }
      m = { kind, key, name, symbol, initialSupply };
    } else if (kind === KIND_NAMES) {
      if (++namesSeen > 1) refuse('more than one names module');
      const tld = jsonString(field('tld'), `modules[${i}].tld`);
      if (!isKey(tld)) refuse('names module has an invalid tld');
      m = { kind, tld };
    } else if (kind === KIND_CONVERTER) {
      if (++convertersSeen > 1) refuse('more than one converter module');
      m = { kind };
    } else if (kind === KIND_CONTRACT) {
      const key = jsonString(field('key'), `modules[${i}].key`);
      const name = jsonString(field('contract'), `modules[${i}].contract`);
      if (!isKey(key)) refuse(`"${key}" has an invalid key`);
      m = { kind, key, name, args: [] };
    } else {
      return refuse(`unknown kind "${kind}"`);
    }

    const identifier = effectiveKey(m);
    for (const prior of mods) {
      if (effectiveKey(prior) === identifier) refuse(`duplicate key "${identifier}"`);
    }
    mods.push(m);
  }

  const pairs = readConverterPairs(list, mods);

  // THE CONTRACT ARGUMENTS, CHECKED NOW. The container reads them at deploy
  // time, inside the broadcast, so a bad one fails after earlier modules are on
  // chain; the route must refuse before it sends anything. The rules are the
  // container's; only the moment is earlier.
  for (let i = 0; i < mods.length; i++) {
    if (mods[i].kind !== KIND_CONTRACT) continue;
    mods[i].args = readContractArgs(list[i], i, mods);
  }
  return { modules: mods, pairs };
}

function readConverterPairs(list: unknown[], mods: ModuleSpec[]): ConverterPair[] {
  const convIdx = mods.findIndex((m) => m.kind === KIND_CONVERTER);
  if (convIdx === -1) return [];
  const node = list[convIdx] as Record<string, unknown>;
  const raw = isObject(node) && Array.isArray(node.pairs) ? node.pairs : [];
  if (raw.length === 0) return refuse('converter has no pairs');

  const tokenKeys = new Set(mods.filter((m) => m.kind === KIND_TOKEN).map((m) => m.key));
  const pairs: ConverterPair[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] as Record<string, unknown> | null;
    const at = (name: string): unknown => (isObject(p) ? p[name] : undefined);
    const source = jsonString(at('source'), `pairs[${i}].source`);
    const target = jsonString(at('target'), `pairs[${i}].target`);
    if (source === target) refuse(`converter pair "${source}" converts to itself`);
    if (!tokenKeys.has(source)) refuse(`converter pair source "${source}" is not a token key`);
    if (!tokenKeys.has(target)) refuse(`converter pair target "${target}" is not a token key`);
    pairs.push({ source, target, rate: parseDecimal18(jsonString(at('rate'), `pairs[${i}].rate`)) });
  }
  // A pair and its reverse must not multiply to more than one: a round trip
  // that returns more than it took mints value.
  for (let i = 0; i < pairs.length; i++) {
    for (let k = i + 1; k < pairs.length; k++) {
      const a = pairs[i];
      const b = pairs[k];
      if (a.source === b.target && a.target === b.source && a.rate * b.rate > RATE_SCALE * RATE_SCALE) {
        refuse(`pair ${a.source}->${a.target} x ${b.source}->${b.target} mints value`);
      }
    }
  }
  return pairs;
}

function readContractArgs(node: unknown, idx: number, mods: ModuleSpec[]): ContractArg[] {
  const raw = isObject(node) && Array.isArray(node.args) ? node.args : [];
  const args: ContractArg[] = [];
  for (let a = 0; a < raw.length; a++) {
    const entry = raw[a] as Record<string, unknown> | null;
    const at = (name: string): unknown => (isObject(entry) ? entry[name] : undefined);
    const type = jsonString(at('type'), `args[${a}].type`);
    const value = jsonString(at('value'), `args[${a}].value`);
    checkArg(type, value, idx, mods);
    args.push({ type, value });
  }
  return args;
}

/// Deploy.s.sol `_encodeOneArg`, as a check: the same types and the same values.
function checkArg(type: string, value: string, idx: number, mods: ModuleSpec[]): void {
  if (type === 'address') {
    if (value.startsWith('@')) {
      const ref = value.slice(1);
      if (ref === 'treasury') return;
      // An EARLIER module only: its address must be known when this one deploys.
      if (mods.slice(0, idx).some((m) => effectiveKey(m) === ref)) return;
      return refuse(`"${value}" is not deployed yet`);
    }
    if (!/^(0x)?[0-9a-fA-F]{40}$/.test(value)) refuse(`"${value}" is not an address`);
    return;
  }
  if (type === 'uint256') {
    if (parseUintLike(value) === null) refuse(`"${value}" is not a uint256`);
    return;
  }
  if (type === 'bool') {
    if (value !== 'true' && value !== 'false') refuse(`bool arg must be "true" or "false", got "${value}"`);
    return;
  }
  if (type === 'bytes32') {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(value)) refuse(`"${value}" is not a bytes32`);
    return;
  }
  refuse(`constructor arg type "${type}" is not supported; use an initialiser function`);
}

/// The parsed values that reach the chain, as one string, in the exact form
/// ManifestCases.t.sol builds from Deploy.s.sol: `kind|key|name|symbol|
/// initialSupply|tld` per module and `source>target@rate` per pair. Agreeing on
/// accept-or-refuse is not enough - a token's name and symbol are constructor
/// arguments, so a name read differently deploys to a different address.
export function canon(m: Manifest): string {
  const mods = m.modules
    .map((x) =>
      [x.kind, x.key ?? '', x.kind === KIND_CONTRACT || x.kind === KIND_TOKEN ? (x.name ?? '') : '',
        x.symbol ?? '', String(x.initialSupply ?? 0n), x.tld ?? ''].join('|'),
    )
    .join(';');
  return `${mods}#${m.pairs.map((p) => `${p.source}>${p.target}@${p.rate}`).join(';')}`;
}
