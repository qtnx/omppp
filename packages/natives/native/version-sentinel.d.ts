/**
 * Native ABI version — the release version at which the native inputs last
 * changed. Bumped by `scripts/release.ts` only when native inputs change, and
 * kept in sync with the `js_name` literal in `crates/pi-natives/src/lib.rs`.
 */
export const NATIVE_ABI_VERSION: string;

/** Return the native-addon export expected for a native ABI version. */
export function versionSentinelFor(abiVersion: string): string;

/** Check whether addon bytes contain the exact expected version sentinel. */
export function containsVersionSentinel(bytes: Buffer, expected: string): boolean;
