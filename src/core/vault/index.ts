// GitRoll Vault: encrypted, signed items kept in a Roll (docs/VAULT-FORMAT.md).
// Platform-free; crypto primitives are injected (crypto.ts).

export * from "./format.ts";
export * from "./items.ts";
export * from "./ops.ts";
export type { VaultCrypto } from "./crypto.ts";
