/// The deployable modules, and the contract each one deploys.
///
/// ONE PLACE, and the Solidity side (`KIND_CONTRACT` in Deploy.s.sol) is the
/// other. They are two declarations of one fact and nothing but a test makes
/// them agree - which is why the manifest's `kind` is validated against this
/// map rather than against a list written beside it.
export const MODULES = {
  token: 'Token',
  names: 'NameRegistry',
} as const;

export type ModuleKind = keyof typeof MODULES;
