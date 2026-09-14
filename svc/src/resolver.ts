// Name resolution (spec S4/S5). Every address in this service is reached by
// NAME - a canonical id or a vanity alias - never by a raw address handed in by
// a caller and never by an id scraped off a mesh message, which is
// observer-relative and would key money under the wrong account.

import type { Address } from 'viem';
import { getAddress, zeroAddress } from 'viem';
import { NameRegistryAbi } from './abi.ts';
import type { Chain } from './chain.ts';
import { asChainError } from './chain.ts';
import { HttpError } from './errors.ts';
import { isCanonicalAgentId } from './validate.ts';
import { requireNames } from './modules.ts';
import type { Store } from './store.ts';

export interface Resolved {
  address: Address;
  /// The registry's canonical name for the address: a qualified agent id for an
  /// agent (`orch:vendor`), a platform name for a platform account
  /// (`treasury.play`), or null if it has none - a burner registers no names
  /// (spec S4). Named `canonical` rather than `agentId` because it is not
  /// always an agent (ruled).
  canonical: string | null;
}

export interface WalletResolution extends Resolved {
  /// WHICH RULE resolved it, not merely who it resolved to. `canonical` says
  /// WHO; without this a correct bare id and a wrong name that happens to
  /// resolve look identical to the caller - the DO-NOT-FLATTEN rule in
  /// wallet.ts, seen from the success side.
  resolvedVia: 'exact' | 'own_namespace';
  /// Whether the caller supplied a colon-less name. Drives the bare-id counter,
  /// which increments on any bare `to` that was not an exactly registered name.
  bare: boolean;
}

export class Resolver {
  /// The store is here for the NAMES-LESS branch and nothing else. A
  /// deployment without a registry still has wallets, and the only record of
  /// which agent owns which address is the spawns table - so on that branch
  /// this class answers from the store instead of from a contract.
  constructor(
    private readonly chain: Chain,
    private readonly store: Pick<Store, 'spawnedAddress' | 'agentIdForAddress'>,
  ) {}

  /// Whether this deployment resolves names at all.
  private get hasNames(): boolean {
    return this.chain.modules.names !== undefined;
  }

  /// @returns null when the name is not registered. The registry returns
  /// address(0) rather than reverting on a miss, so "unknown" arrives as a
  /// value and becomes a 404 here (ruled).
  async lookup(name: string): Promise<Resolved | null> {
    // WITHOUT A REGISTRY, the only thing a name can be is a wallet's own
    // canonical id, matched EXACTLY. No bare-id fallback and no aliases:
    // both are registry features, and inventing a local imitation of them
    // would give a names-less deployment a second, quieter resolution rule
    // that nothing else in the system knows about.
    if (!this.hasNames) {
      const address = this.store.spawnedAddress(name);
      return address === null ? null : { address: getAddress(address), canonical: name };
    }

    let target: Address;
    try {
      target = (await this.chain.publicClient.readContract({
        address: requireNames(this.chain.modules).address,
        abi: NameRegistryAbi,
        functionName: 'resolve',
        args: [name],
      })) as Address;
    } catch (err) {
      throw asChainError(err);
    }
    if (target === zeroAddress) return null;

    return { address: getAddress(target), canonical: await this.reverseOf(target) };
  }

  /// WALLET-SCOPE resolution of a `to` (spec S5). Delegates to the free
  /// function below so a caller holding only a `lookup` - the test fixtures,
  /// and Treasury, which passes this resolver's own - runs the SAME code. One
  /// implementation, not a method and a copy of it.
  async resolveForWallet(to: string, namespace: string): Promise<WalletResolution> {
    return resolveBareName((name) => this.lookup(name), to, namespace);
  }

  /// The address that OWNS a registered name, for the `chain.name_collision`
  /// signal: an ambiguity is evidence about whoever registered the colliding
  /// alias, and "go and look at who registered that alias" needs the who.
  async registrantOf(name: string): Promise<Address | null> {
    // Registry-only, and reached only from the bare-id path, which exists only
    // when names are deployed. Guarded rather than assumed so a future caller
    // gets a refusal that names the reason instead of a chain read against a
    // registry that is not there.
    requireNames(this.chain.modules);

    let logs;
    try {
      logs = await this.chain.publicClient.getContractEvents({
        address: requireNames(this.chain.modules).address,
        abi: NameRegistryAbi,
        eventName: 'Registered',
        fromBlock: 0n,
        toBlock: 'latest',
      });
    } catch (err) {
      throw asChainError(err);
    }
    // LAST writer wins: a name can be re-registered, and the current owner is
    // the one to go and look at.
    let owner: Address | null = null;
    for (const log of logs) {
      const args = log.args as { name?: string; owner?: Address };
      if (args.name === name && args.owner) owner = getAddress(args.owner);
    }
    return owner;
  }

  async require(name: string): Promise<Resolved> {
    const found = await this.lookup(name);
    if (!found) throw new HttpError('unknown_name', `no registry entry for ${name}`);
    return found;
  }

  /// The address's primary name: always its canonical id, never a vanity alias
  /// (the registry writes the reverse on register only, spec S3.2).
  async reverseOf(address: Address): Promise<string | null> {
    if (!this.hasNames) return this.store.agentIdForAddress(address);

    try {
      const name = (await this.chain.publicClient.readContract({
        address: requireNames(this.chain.modules).address,
        abi: NameRegistryAbi,
        functionName: 'reverseOf',
        args: [address],
      })) as string;
      return name === '' ? null : name;
    } catch (err) {
      throw asChainError(err);
    }
  }

  /// Vanity aliases BELONGING to an address, indexed from Registered logs
  /// (spec S4). A name merely pointing at the wallet is not its alias: the
  /// event must have owner == target == the wallet. The registry has no alias
  /// enumeration on chain, and adding one would mean an unbounded array in
  /// storage.
  async aliasesOf(address: Address): Promise<string[]> {
    // An alias is a registry record. Without a registry there are none - which
    // is different from "we could not find any", and the empty array is the
    // honest answer rather than a degraded one.
    if (!this.hasNames) return [];

    let logs;
    try {
      logs = await this.chain.publicClient.getContractEvents({
        address: requireNames(this.chain.modules).address,
        abi: NameRegistryAbi,
        eventName: 'Registered',
        fromBlock: 0n,
        toBlock: 'latest',
      });
    } catch (err) {
      throw asChainError(err);
    }

    const canonical = await this.reverseOf(address);
    const names: string[] = [];
    for (const log of logs) {
      const args = log.args as { name?: string; owner?: Address; target?: Address };
      if (!args.name || !args.target || !args.owner) continue;
      if (args.target.toLowerCase() !== address.toLowerCase()) continue;
      // A wallet's alias is a name it OWNS and points at itself (ruled
      // UTC).
      //
      // The threat this was originally written against is GONE: `register` was
      // permissionless with an arbitrary target, and since #12 it is
      // `onlyRole(REGISTRAR_ROLE)`. The filter is still required, for a
      // different and still-live reason: `registerFor` takes owner and target
      // separately, so the registrar can legitimately create a name owned by
      // one wallet and pointing at another. Such a name is not the target's
      // alias and must not be reported as one.
      //
      // Recorded explicitly because the old justification named a threat that
      // no longer exists - and a filter whose stated reason is obsolete is one
      // somebody relaxes on the grounds that the danger is past.
      if (args.owner.toLowerCase() !== address.toLowerCase()) continue;
      if (args.name === canonical) continue;
      // A name whose target has since moved away (retirement clears alias
      // targets) must not still be listed as this wallet's alias.
      const still = await this.lookup(args.name);
      if (still && still.address.toLowerCase() === address.toLowerCase()) names.push(args.name);
    }
    return [...new Set(names)];
  }
}

/// The §5 bare-id rule itself, over any `lookup`.
///
/// A bare id resolves within the CALLER'S OWN NAMESPACE and nowhere else. dana
/// was shown `attacker` by the mesh, the registry holds `acme:attacker`, and
/// returning an unsolicited bribe failed on the gap between the id a model SEES
/// and the id the registry HOLDS.
///
/// THE REFUSAL, NOT THE ORDER, IS THE SAFETY PROPERTY - and the distinction is
/// load-bearing. When both readings exist this REFUSES, so the precedence
/// between them is never observable: measured, swapping the two returns below
/// changes no behaviour and kills no test, because the overlap case never
/// reaches them. Anyone who removes the ambiguity check on the grounds that
/// "the exact name wins anyway" would be making precedence matter for the first
/// time, in the direction that redirects payments. Without that
/// refusal, whoever registers the vanity alias `toby` silently receives every
/// in-namespace payment meant for `<ns>:toby` - a phishing primitive on the
/// money path, the one direction this rail must never err in. With it, the
/// squat turns a payment into a visible refusal and nothing else.
///
/// `namespace` comes from the AUTHENTICATED PRINCIPAL, never from the request
/// and never from config - the standing §0 constraint. It is total:
/// CANONICAL_ID admits exactly one colon, so a caller in none or several
/// namespaces is inapplicable rather than unlikely.
/// The own-namespace candidate for a bare `to`, or null when no such candidate
/// can exist because `<namespace>:<to>` would not be a canonical id.
///
/// EXPORTED SO THE CALLER CAN CLASSIFY THE OUTCOME WITHOUT RE-DERIVING THE RULE.
/// `chain.bare_id` distinguishes a fallback that was SKIPPED FOR SHAPE from one
/// that was tried and MISSED, and both arrive at the same `unknown_name`. The
/// caller therefore has to ask the same question this function answers - and
/// asking it through this function rather than by repeating
/// `isCanonicalAgentId(`${namespace}:${to}`)` means the two cannot disagree
/// about which case they are in. A label that disagrees with the behaviour it
/// describes is worse than no label.
export function ownNamespaceCandidate(namespace: string, to: string): string | null {
  const candidate = `${namespace}:${to}`;
  return isCanonicalAgentId(candidate) ? candidate : null;
}

export async function resolveBareName(
  lookup: (name: string) => Promise<Resolved | null>,
  to: string,
  namespace: string,
): Promise<WalletResolution> {
    // A qualified id resolves exactly as it always has. Only a BARE name gets
    // the fallback, so this rule can never reach across namespaces.
    if (to.includes(':')) {
      const found = await lookup(to);
      if (!found) throw new HttpError('unknown_name', `no registry entry for ${to}`);
      return { ...found, resolvedVia: 'exact', bare: false };
    }

    const exact = await lookup(to);

    // Skipped, not lowercased and not rejected, when the constructed candidate
    // would not be a canonical id - a mixed-case bare name like `aIpha` can be
    // a registered alias and can never be a local id.
    const candidate = `${namespace}:${to}`;
    const shaped = ownNamespaceCandidate(namespace, to) !== null;
    const peer = shaped ? await lookup(candidate) : null;

    // AMBIGUOUS MEANS THEY DISAGREE, NOT MERELY THAT BOTH EXIST.
    //
    // A wallet aliasing itself with its own local id is ordinary and harmless:
    // `acme:toby` registering the alias `toby` makes both readings resolve, to
    // THE SAME ADDRESS. Refusing on existence alone made that a 409 whose advice
    // named one id twice ("acme:toby and acme:toby; say which"), and raised a
    // chain.name_collision against an agent that had done nothing - a false
    // positive on the signal path, where it costs most.
    //
    // Worse, it refused the case this rule was written for: had `acme:attacker`
    // aliased itself `attacker`, dana's return would have been refused by the
    // change made so it would not be.
    //
    // Addresses, not canonicals: both are getAddress-normalised, and the
    // question is whether two names lead to two DIFFERENT WALLETS. Comparing
    // canonicals would make a burner (which registers no names, so canonical is
    // null) compare equal to anything else with none.
    if (exact && peer && exact.address !== peer.address) {
      throw new HttpError(
        'ambiguous_name',
        `${to} is both a registered name and a DIFFERENT wallet in your namespace ` +
          `(${exact.canonical ?? exact.address} and ${peer.canonical ?? candidate}); ` +
          `say which by using the full id`,
      );
    }
    // Reached only when at most ONE of them resolved, so their order is inert -
    // see the note above, and do not read it as the precedence rule.
    if (exact) return { ...exact, resolvedVia: 'exact', bare: true };
    if (peer) return { ...peer, resolvedVia: 'own_namespace', bare: true };

    // BOTH ATTEMPTS NAMED. After this rule `unknown_name` covers two worlds,
    // and this is a game students DEBUG: "no wallet is registered as toby" with
    // `acme:toby` sitting in the registry sends them hunting a registration
    // bug that does not exist.
    throw new HttpError(
      'unknown_name',
      shaped
        ? `no wallet is registered as ${to}, nor as ${candidate}`
        : `no wallet is registered as ${to}, and ${to} is not a valid local id ` +
          `(canonical ids are lowercase), so ${namespace}:${to} was not tried`,
    );
}
