/**
 * Version-sentinel helpers shared by the native loader and the embed pipeline.
 *
 * Kept in its own module so `scripts/embed-native.ts` can reuse the exact-match
 * logic without importing `loader-state.js` — which pulls in the generated
 * `embedded-addon.js` and its `with { type: "file" }` archive import. That
 * chain fails to resolve when the archive is missing, which would break
 * `gen:native:reset` on an inconsistent tree (populated manifest, deleted
 * archive) before it can restore the checked-in null stub.
 */

/**
 * Native ABI version — the release version at which the native inputs last
 * changed (`NATIVE_INPUT_PATHS` in `scripts/native-source-hash.ts`).
 *
 * `scripts/release.ts` bumps this together with the `js_name` literal in
 * `crates/pi-natives/src/lib.rs`, and only when the native inputs differ from
 * the previous release tag. A release that leaves the native sources alone
 * therefore keeps the sentinel — and the `.node` artifacts CI already built for
 * the identical sources stay usable. MUST stay in sync with that `js_name`.
 */
export const NATIVE_ABI_VERSION = "1.11.1";

/**
 * Return the version sentinel exported by an addon built for `abiVersion`.
 * @param {string} abiVersion
 * @returns {string}
 */
export function versionSentinelFor(abiVersion) {
	return `__piNativesV${abiVersion.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/**
 * Check for an exact version sentinel rather than a longer sentinel with the
 * expected value as its prefix (e.g. `__piNativesV18_1_10` must not satisfy a
 * lookup for `__piNativesV18_1_1`).
 * @param {Buffer} bytes
 * @param {string} expected
 * @returns {boolean}
 */
export function containsVersionSentinel(bytes, expected) {
	if (expected.length === 0) return false;
	let offset = 0;
	while (offset < bytes.length) {
		const index = bytes.indexOf(expected, offset);
		if (index === -1) return false;
		const next = bytes[index + expected.length];
		const isIdentifierByte =
			next === 95 || (next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122);
		if (!isIdentifierByte) return true;
		offset = index + expected.length;
	}
	return false;
}
