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

export interface Resolved {
  address: Address;
  /// The registry's canonical name for the address: a qualified agent id for an
  /// agent (`orch:shadowbroker`), a platform name for a platform account
  /// (`treasury.vee`), or null if it has none - a burner registers no names
  /// (spec S4). Named `canonical` rather than `agentId` because it is not
  /// always an agent (ruled 20:07 UTC).
  canonical: string | null;
}

export class Resolver {
  constructor(private readonly chain: Chain) {}

  /// @returns null when the name is not registered. The registry returns
  /// address(0) rather than reverting on a miss, so "unknown" arrives as a
  /// value and becomes a 404 here (ruled 19:15 UTC).
  async lookup(name: string): Promise<Resolved | null> {
    let target: Address;
    try {
      target = (await this.chain.publicClient.readContract({
        address: this.chain.deployment.NameRegistry,
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

  async require(name: string): Promise<Resolved> {
    const found = await this.lookup(name);
    if (!found) throw new HttpError('unknown_name', `no registry entry for ${name}`);
    return found;
  }

  /// The address's primary name: always its canonical id, never a vanity alias
  /// (the registry writes the reverse on register only, spec S3.2).
  async reverseOf(address: Address): Promise<string | null> {
    try {
      const name = (await this.chain.publicClient.readContract({
        address: this.chain.deployment.NameRegistry,
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
    let logs;
    try {
      logs = await this.chain.publicClient.getContractEvents({
        address: this.chain.deployment.NameRegistry,
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
      // A wallet's alias is a name it OWNS and points at itself (ruled 22:12
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
