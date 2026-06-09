/**
 * Update CLI command handler.
 *
 * Handles `ompx update` to check for and install updates.
 *
 * OMPx is distributed as a GitHub release binary from `qtnx/omppp`, so updates
 * always download the matching release asset and swap the on-disk binary in
 * place. There is no npm/bun reinstall path: the published npm package lives in
 * a scope this fork does not own, so reinstalling from it would pull a different
 * project's build rather than the latest OMPx release.
 */
import * as fs from "node:fs";
import { $which, APP_NAME, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import { downloadReleaseAsset, fetchLatestReleaseInfo, type ReleaseInfo } from "./update-release";

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
	};
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryNameForPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			if (arch !== "x64") {
				throw new Error(`Unsupported Windows architecture: ${arch}; release binaries are only published for x64`);
			}
			return `${APP_NAME}-windows-x64.exe`;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	return `${APP_NAME}-${os}-${archName}`;
}

export function getBinaryNameForTest(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
	return getBinaryNameForPlatform(platform, arch);
}

/**
 * Resolve the installed `ompx` binary this process should replace.
 *
 * Throws when the binary cannot be located in PATH — there is nothing to swap
 * in place, and reinstalling via the install script is the right recovery.
 */
function resolveOmpxTarget(): string {
	const ompxPath = $which(APP_NAME) ?? undefined;
	if (!ompxPath) {
		throw new Error(
			`Could not resolve ${APP_NAME} binary path in PATH; reinstall with: ` +
				"curl -fsSL https://raw.githubusercontent.com/qtnx/omppp/main/scripts/install.sh | sh",
		);
	}
	return ompxPath;
}

/**
 * Extract the `X.Y.Z` version from `ompx --version` output.
 *
 * The binary prints the bare semver — see main.ts: `process.stdout.write(\`${VERSION}\n\`)`
 * — so the match must NOT require a prefix. We scan for the first `X.Y.Z` run,
 * which also tolerates an optional leading `ompx/` or `v` if the banner format
 * ever changes. Returns undefined when no version is present (e.g. the binary
 * printed an error instead of a version).
 */
export function parseReportedVersion(output: string): string | undefined {
	return output.match(/(\d+\.\d+\.\d+)/)?.[1];
}

/**
 * Run the resolved OMPx binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const ompxPath = $which(APP_NAME) ?? undefined;
	if (!ompxPath) return { ok: false };
	try {
		const result = await $`${ompxPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: ompxPath };
		const actual = parseReportedVersion(result.text());
		return { ok: actual === expectedVersion, actual, path: ompxPath };
	} catch {
		return { ok: false, path: ompxPath };
	}
}

function printVerifiedVersion(expectedVersion: string): void {
	console.log(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Remove a file, ignoring every failure.
 *
 * Used for the post-replacement backup cleanup: on Windows the previous binary
 * (renamed to `.bak`) is still held open by the running process, so unlinking
 * it fails with EPERM/EBUSY. The new binary is already in place and verified at
 * that point, so a leftover `.bak` is harmless — the next update clears it
 * before renaming — and must never fail an otherwise-successful update.
 */
async function unlinkBestEffort(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch {
		// Intentionally ignored; see doc comment.
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		await unlinkIfExists(options.backupPath);
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		await unlinkBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, release: ReleaseInfo): Promise<void> {
	const binaryName = getBinaryNameForPlatform(process.platform, process.arch);

	const tempPath = `${targetPath}.new`;
	const backupPath = `${targetPath}.bak`;
	await downloadReleaseAsset({ release, binaryName, tempPath });

	console.log(chalk.dim("Installing update..."));
	await replaceBinaryForUpdate({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion: release.version,
		verifyInstalledVersion,
	});
	printVerifiedVersion(release.version);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	// Check for updates
	let release: ReleaseInfo;
	try {
		release = await fetchLatestReleaseInfo();
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}

	const comparison = Bun.semver.order(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		// Just check, don't install
		return;
	}

	// Download the matching release binary and swap it in place.
	try {
		const targetPath = resolveOmpxTarget();
		await updateViaBinaryAt(targetPath, release);
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check   Check for updates without installing
  -f, --force   Force reinstall even if up to date

${chalk.bold("Examples:")}
  ${APP_NAME} update           Update to latest version
  ${APP_NAME} update --check   Check if updates are available
  ${APP_NAME} update --force   Force reinstall
`);
}
