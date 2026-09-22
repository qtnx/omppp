#!/usr/bin/env bun
/**
 * Content hash of every input that affects the pi-natives `.node` output.
 *
 * CI keys native artifacts on this hash so a release tag reuses the addons a
 * main push already built. Release version bumps rewrite the workspace crate
 * versions (`Cargo.toml`, `Cargo.lock`) and `packages/natives/package.json`,
 * so those version fields are normalized away: a pure version bump keeps the
 * hash (and the artifacts) stable. The native version sentinel in
 * `crates/pi-natives/src/lib.rs` only moves when these inputs change
 * (`scripts/release.ts`), which is what makes the reuse sound.
 *
 * Usage: bun scripts/native-source-hash.ts   # prints the 16-hex-char hash
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Repo-relative files and directories whose content determines the native addon. */
export const NATIVE_INPUT_PATHS: readonly string[] = [
	"crates",
	"bazel",
	"Cargo.toml",
	"Cargo.lock",
	"rust-toolchain.toml",
	"BUILD.bazel",
	"MODULE.bazel",
	"MODULE.bazel.lock",
	".bazelrc",
	".bazelignore",
	".bazelversion",
	"packages/natives/scripts",
	"packages/natives/package.json",
	".github/actions/bazel-cache",
	".github/actions/build-native",
	"scripts/bazel-natives.ts",
	"scripts/ci-build-native.ts",
	"scripts/host-detect.ts",
	"scripts/native-source-hash.ts",
];

/** Drop release-bump version fields; everything else hashes verbatim. */
export function normalizeNativeInput(relPath: string, text: string): string {
	switch (relPath) {
		case "Cargo.toml":
			return text.replace(/^version = .*\n/gm, "");
		case "Cargo.lock":
			// Only workspace crates (no `source`) carry the release version;
			// registry/git dependency versions stay part of the hash.
			return text
				.split("\n[[package]]\n")
				.map(block => (block.includes("\nsource = ") ? block : block.replace(/^version = .*\n/m, "")))
				.join("\n[[package]]\n");
		case "packages/natives/package.json":
			return text.replace(/^\t"version": .*\n/m, "");
		default:
			return text;
	}
}

async function collectFiles(root: string, rel: string, out: string[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOTDIR") {
			out.push(rel);
			return;
		}
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	for (const entry of entries) {
		const child = `${rel}/${entry.name}`;
		if (entry.isDirectory()) await collectFiles(root, child, out);
		else if (entry.isFile()) out.push(child);
	}
}

export async function nativeSourceHash(root: string): Promise<string> {
	const files: string[] = [];
	for (const rel of NATIVE_INPUT_PATHS) await collectFiles(root, rel, files);
	files.sort();
	const hasher = new Bun.CryptoHasher("sha256");
	for (const rel of files) {
		const bytes = await Bun.file(path.join(root, rel)).bytes();
		const normalized = ["Cargo.toml", "Cargo.lock", "packages/natives/package.json"].includes(rel)
			? normalizeNativeInput(rel, new TextDecoder().decode(bytes))
			: bytes;
		hasher.update(`${rel}\0${new Bun.CryptoHasher("sha256").update(normalized).digest("hex")}\n`);
	}
	return hasher.digest("hex").slice(0, 16);
}

if (import.meta.main) {
	process.stdout.write(`${await nativeSourceHash(path.join(import.meta.dir, ".."))}\n`);
}
