#!/usr/bin/env bun

import * as path from "node:path";
import { ADDON_OUTPUTS, AGGREGATE_TARGETS } from "./bazel-natives";

const repoRoot = path.join(import.meta.dir, "..");
const isDryRun = process.argv.includes("--dry-run");
const knownTargetNames = [...Object.keys(ADDON_OUTPUTS), ...Object.keys(AGGREGATE_TARGETS)];

export interface NativeBuildEnvironment {
	CROSS_TARGET?: string;
	TARGET_PLATFORM?: string;
	TARGET_ARCH?: string;
	TARGET_VARIANTS?: string;
	LIBC?: string;
}

/** Adds release-portability env required by native addon builds. */
export function withPortableNativeBuildEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return { ...env, PCRE2_SYS_STATIC: "1" };
}

function cannotMapNativeTarget(env: NativeBuildEnvironment, reason: string): never {
	const receivedEnv = {
		CROSS_TARGET: env.CROSS_TARGET ?? "",
		TARGET_PLATFORM: env.TARGET_PLATFORM ?? "",
		TARGET_ARCH: env.TARGET_ARCH ?? "",
		TARGET_VARIANTS: env.TARGET_VARIANTS ?? "",
		LIBC: env.LIBC ?? "",
	};
	throw new Error(
		`Cannot map CI native target: ${reason}. Received env: ${JSON.stringify(receivedEnv)}. ` +
			`Known targets: ${knownTargetNames.join(", ")}`,
	);
}

function parseTargetVariants(env: NativeBuildEnvironment): Array<"baseline" | "modern"> {
	const rawVariants = env.TARGET_VARIANTS?.trim() ?? "";
	if (!rawVariants) return [];

	const variants: Array<"baseline" | "modern"> = [];
	for (const variant of rawVariants.split(/\s+/)) {
		if (variant !== "baseline" && variant !== "modern") {
			cannotMapNativeTarget(env, `unsupported TARGET_VARIANTS entry "${variant}"`);
		}
		if (!variants.includes(variant)) variants.push(variant);
	}
	return variants;
}

function requireOnlyVariants(
	env: NativeBuildEnvironment,
	variants: Array<"baseline" | "modern">,
	allowed: Array<"baseline" | "modern">,
): void {
	if (variants.length === 0 || variants.some(variant => !allowed.includes(variant))) {
		cannotMapNativeTarget(env, `TARGET_VARIANTS must contain only ${allowed.join(" or ")} for this target`);
	}
}

function requireNoVariants(env: NativeBuildEnvironment, variants: Array<"baseline" | "modern">): void {
	if (variants.length > 0) {
		cannotMapNativeTarget(env, "TARGET_VARIANTS is unsupported for this target");
	}
}

function requireKnownAddonTarget(env: NativeBuildEnvironment, target: string): string {
	if (target in ADDON_OUTPUTS) return target;
	cannotMapNativeTarget(env, `no addon target named "${target}"`);
}

/**
 * Maps the CI matrix environment to concrete Bazel addon targets.
 * Musl targets intentionally stay separate from GNU targets because they share
 * destination filenames.
 */
export function resolveNativeTargets(env: NativeBuildEnvironment): string[] {
	const platform = env.TARGET_PLATFORM?.trim();
	const arch = env.TARGET_ARCH?.trim();
	const libc = env.LIBC?.trim() ?? "";
	const variants = parseTargetVariants(env);

	if (!platform || !arch) {
		cannotMapNativeTarget(env, "TARGET_PLATFORM and TARGET_ARCH are required");
	}
	if (libc !== "" && libc !== "musl") {
		cannotMapNativeTarget(env, `unsupported LIBC "${libc}"`);
	}
	if (platform !== "linux" && libc) {
		cannotMapNativeTarget(env, `LIBC "${libc}" is only supported for linux`);
	}

	if (platform === "linux" && arch === "x64") {
		requireOnlyVariants(env, variants, libc === "musl" ? ["baseline"] : ["baseline", "modern"]);
		if (libc === "musl") return [requireKnownAddonTarget(env, "linux-musl-x64-baseline")];
		return variants.map(variant => requireKnownAddonTarget(env, `linux-x64-${variant}`));
	}
	if (platform === "linux" && arch === "arm64") {
		requireNoVariants(env, variants);
		return [requireKnownAddonTarget(env, libc === "musl" ? "linux-musl-arm64" : "linux-arm64")];
	}
	if (platform === "darwin" && arch === "x64") {
		requireOnlyVariants(env, variants, ["baseline"]);
		return [requireKnownAddonTarget(env, "darwin-x64-baseline")];
	}
	if (platform === "darwin" && arch === "arm64") {
		requireNoVariants(env, variants);
		return [requireKnownAddonTarget(env, "darwin-arm64")];
	}
	if (platform === "win32" && arch === "x64") {
		requireOnlyVariants(env, variants, ["baseline"]);
		return [requireKnownAddonTarget(env, "win32-x64-baseline")];
	}
	cannotMapNativeTarget(env, `unsupported platform/arch pair "${platform}/${arch}"`);
}

async function runCommand(command: string[], env: NodeJS.ProcessEnv): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function runNativeBuild(env: NodeJS.ProcessEnv, label: string): Promise<void> {
	const targets = resolveNativeTargets(env);
	const buildEnv = withPortableNativeBuildEnv(env);
	const command = ["bun", "scripts/bazel-natives.ts", ...targets, "--dest", "packages/natives/native"];
	if (isDryRun) {
		console.log(`DRY RUN ${command.join(" ")} [${label}] PCRE2_SYS_STATIC=${buildEnv.PCRE2_SYS_STATIC}`);
		return;
	}

	console.log(`Building natives [${label}]...`);
	await runCommand(command, buildEnv);
}

async function main(): Promise<void> {
	const label = Bun.env.TARGET_VARIANTS?.trim() || "default";
	await runNativeBuild(Bun.env, label);
}

if (import.meta.main) await main();
