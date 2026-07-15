/**
 * Update CLI command handler.
 *
 * Handles `ompx update` to check for and install updates.
 *
 * OMPx is distributed as a GitHub release binary from `qtnx/omppp`. On POSIX
 * platforms updates run the repo's `scripts/install.sh` (pinned to the release
 * tag) so the update path and the install path stay one source of truth —
 * checksum verification, standard-config seeding, and any future installer
 * migrations apply to updates automatically. The previous binary is backed up
 * and restored when the updated binary fails version verification. Windows
 * (and any environment where the script cannot run) falls back to downloading
 * the release asset and swapping the on-disk binary in place. There is no
 * npm/bun reinstall path: the published npm package lives in a scope this fork
 * does not own, so reinstalling from it would pull a different project's build
 * rather than the latest OMPx release.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, APP_NAME, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import { downloadReleaseAsset, fetchLatestReleaseInfo, type ReleaseInfo } from "./update-release";

const REPO = "qtnx/omppp";
const PACKAGE = "@oh-my-pi/pi-coding-agent";
const NPM_REGISTRY = "https://registry.npmjs.org/";
const HOMEBREW_FORMULA = "qtnx/omppp/ompx";
const MISE_TOOL = "github:qtnx/omppp";

const NATIVES_PACKAGE = "@oh-my-pi/pi-natives";
const SUPPORTED_NATIVE_TAGS: ReadonlySet<string> = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
]);

function currentNativeTag(): string {
	return `${process.platform}-${process.arch}`;
}

/** Raw URL of the install script pinned to a release tag. */
export function installScriptUrl(tag: string): string {
	return `https://raw.githubusercontent.com/${REPO}/${tag}/scripts/install.sh`;
}

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
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean; plugins: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
		plugins: args.includes("--plugins") || args.includes("-l"),
	};
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	// Layer realpath resolution on top of the lexical guard. On Windows, ~/.bun
	// is a junction when Bun is installed via Scoop, so `bun pm bin -g` and the
	// PATH-resolved omp path can refer to the same directory through different
	// strings. path.resolve does not traverse junctions/symlinks; realpath does.
	// Resolve both the file and its parent directory: the file catches manager
	// links like Homebrew's `bin/omp -> Cellar/.../bin/omp`; the parent fallback
	// still tolerates fresh install paths where the file does not exist yet.
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!dirReal) return false;
	const fileReal = tryRealpath(path.resolve(filePath));
	if (fileReal && isPathInDirectoryLexical(fileReal, dirReal)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	if (!fileDir) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

type UpdateMethod = "brew" | "mise" | "bun" | "npm" | "binary";

interface UpdateMethodResolutionOptions {
	homebrewPrefix?: string;
	miseBinDirs?: readonly string[];
	miseDataDir?: string;
	npmBinDir?: string;
}

function resolveUpdateMethod(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	const { homebrewPrefix, miseBinDirs = [], miseDataDir, npmBinDir } = options;
	const launcherExtension = path.extname(ompPath).toLowerCase();
	const isWindowsScriptLauncher =
		launcherExtension === ".cmd" || launcherExtension === ".ps1" || launcherExtension === ".bat";
	if (homebrewPrefix && isPathInDirectory(ompPath, path.join(homebrewPrefix, "bin"))) return "brew";
	if (miseBinDirs.some(dir => isPathInDirectory(ompPath, dir))) return "mise";
	if (miseDataDir && isPathInDirectory(ompPath, path.join(miseDataDir, "shims"))) return "mise";
	if (bunBinDir && isPathInDirectory(ompPath, bunBinDir)) return "bun";
	if ((npmBinDir && isPathInDirectory(ompPath, npmBinDir)) || isWindowsScriptLauncher) return "npm";
	return "binary";
}

export function resolveUpdateMethodForTest(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	return resolveUpdateMethod(ompPath, bunBinDir, options);
}

interface BunInstallCachePruneResult {
	scannedPackages: number;
	removedEntries: number;
}

interface BunCachePackageGroup {
	actualDirs: Map<string, string[]>;
	markerDir?: string;
	markerEntries: Map<string, string[]>;
}

function stripBunCacheVersionSuffix(name: string): string {
	const metadataIndex = name.indexOf("@@");
	return metadataIndex === -1 ? name : name.slice(0, metadataIndex);
}

function compareSemverIdentifier(a: string, b: string): number {
	const aNumber = /^\d+$/.test(a);
	const bNumber = /^\d+$/.test(b);
	if (aNumber && bNumber) return Number(a) - Number(b);
	if (aNumber) return -1;
	if (bNumber) return 1;
	return a.localeCompare(b);
}

function compareSemverLikeVersions(a: string, b: string): number {
	const [aCoreWithPrerelease] = a.split("+", 1);
	const [bCoreWithPrerelease] = b.split("+", 1);
	const [aCore, aPrerelease] = aCoreWithPrerelease.split("-", 2);
	const [bCore, bPrerelease] = bCoreWithPrerelease.split("-", 2);
	const aParts = aCore.split(".");
	const bParts = bCore.split(".");
	for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
		const diff = Number(aParts[i] ?? 0) - Number(bParts[i] ?? 0);
		if (diff !== 0 && Number.isFinite(diff)) return diff;
	}
	if (!aPrerelease && !bPrerelease) return 0;
	if (!aPrerelease) return 1;
	if (!bPrerelease) return -1;
	const aPrereleaseParts = aPrerelease.split(".");
	const bPrereleaseParts = bPrerelease.split(".");
	for (let i = 0; i < Math.max(aPrereleaseParts.length, bPrereleaseParts.length); i++) {
		const aPart = aPrereleaseParts[i];
		const bPart = bPrereleaseParts[i];
		if (aPart === undefined) return -1;
		if (bPart === undefined) return 1;
		const diff = compareSemverIdentifier(aPart, bPart);
		if (diff !== 0) return diff;
	}
	return 0;
}

async function readdirIfExists(dir: string): Promise<fs.Dirent[]> {
	try {
		return await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

function getBunCacheGroup(groups: Map<string, BunCachePackageGroup>, packageName: string): BunCachePackageGroup {
	let group = groups.get(packageName);
	if (!group) {
		group = { actualDirs: new Map(), markerEntries: new Map() };
		groups.set(packageName, group);
	}
	return group;
}

function addVersionPath(entries: Map<string, string[]>, version: string, entryPath: string): void {
	const paths = entries.get(version);
	if (paths) {
		paths.push(entryPath);
		return;
	}
	entries.set(version, [entryPath]);
}

async function addBunCacheActualDir(
	groups: Map<string, BunCachePackageGroup>,
	dirPath: string,
	packageNames: Set<string> | undefined,
): Promise<void> {
	try {
		const manifest = (await Bun.file(path.join(dirPath, "package.json")).json()) as Partial<
			Record<"name" | "version", unknown>
		>;
		if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return;
		if (packageNames && !packageNames.has(manifest.name)) return;
		const group = getBunCacheGroup(groups, manifest.name);
		addVersionPath(group.actualDirs, manifest.version, dirPath);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
}

async function addBunCacheMarkerDir(
	groups: Map<string, BunCachePackageGroup>,
	packageName: string,
	markerDir: string,
	packageNames: Set<string> | undefined,
): Promise<void> {
	if (packageNames && !packageNames.has(packageName)) return;
	const markerEntries = await readdirIfExists(markerDir);
	const group = getBunCacheGroup(groups, packageName);
	group.markerDir = markerDir;
	for (const entry of markerEntries) {
		const cacheVersion = stripBunCacheVersionSuffix(entry.name);
		addVersionPath(group.markerEntries, cacheVersion, path.join(markerDir, entry.name));
	}
}

async function collectBunCacheGroups(
	cacheDir: string,
	packageNames: Set<string> | undefined,
): Promise<Map<string, BunCachePackageGroup>> {
	const groups = new Map<string, BunCachePackageGroup>();
	for (const entry of await readdirIfExists(cacheDir)) {
		if (!entry.isDirectory()) continue;
		const entryPath = path.join(cacheDir, entry.name);
		if (entry.name.startsWith("@")) {
			for (const scopedEntry of await readdirIfExists(entryPath)) {
				if (!scopedEntry.isDirectory()) continue;
				const scopedEntryPath = path.join(entryPath, scopedEntry.name);
				const versionSeparator = scopedEntry.name.lastIndexOf("@");
				if (versionSeparator === -1) {
					await addBunCacheMarkerDir(groups, `${entry.name}/${scopedEntry.name}`, scopedEntryPath, packageNames);
				} else {
					await addBunCacheActualDir(groups, scopedEntryPath, packageNames);
				}
			}
			continue;
		}
		const versionSeparator = entry.name.lastIndexOf("@");
		if (versionSeparator === -1) {
			await addBunCacheMarkerDir(groups, entry.name, entryPath, packageNames);
		} else {
			await addBunCacheActualDir(groups, entryPath, packageNames);
		}
	}
	return groups;
}

async function removeCacheEntries(paths: string[]): Promise<number> {
	for (const entryPath of paths) {
		await fs.promises.rm(entryPath, { recursive: true, force: true });
	}
	return paths.length;
}

/**
 * Prune Bun's package cache so each package keeps only its newest cached version.
 *
 * Bun stores package cache entries as both a package marker directory
 * (`react/19.2.6@@@1`) and a materialized package directory
 * (`react@19.2.6@@@1`). Global `omp` updates can leave one full copy per
 * release. The marker and materialized entries are removed together so the
 * cache stays internally consistent.
 */
export async function pruneBunInstallCache(
	cacheDir: string,
	packageNames?: Set<string>,
): Promise<BunInstallCachePruneResult> {
	const groups = await collectBunCacheGroups(cacheDir, packageNames);
	let scannedPackages = 0;
	let removedEntries = 0;
	for (const group of groups.values()) {
		if (group.actualDirs.size === 0) continue;
		scannedPackages++;
		let latestVersion: string | undefined;
		for (const version of group.actualDirs.keys()) {
			if (!latestVersion || compareSemverLikeVersions(version, latestVersion) > 0) latestVersion = version;
		}
		if (!latestVersion) continue;
		for (const [version, paths] of group.actualDirs) {
			if (version !== latestVersion) removedEntries += await removeCacheEntries(paths);
		}
		for (const [version, paths] of group.markerEntries) {
			if (version !== latestVersion) removedEntries += await removeCacheEntries(paths);
		}
	}
	return { scannedPackages, removedEntries };
}

export function resolveBunGlobalNodeModulesDirFromLocations(
	globalBinDir: string | undefined,
	cacheDir: string | undefined,
): string | undefined {
	if (globalBinDir && globalBinDir.length > 0) {
		return path.join(path.dirname(globalBinDir), "install", "global", "node_modules");
	}
	if (cacheDir && cacheDir.length > 0) {
		return path.join(path.dirname(cacheDir), "global", "node_modules");
	}
	return undefined;
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
function resolveOmpPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

function resolveOmpxTarget(): string {
	const ompxPath = resolveOmpPath();
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
 * The binary prints the bare semver — see main.ts: `process.stdout.write(`${VERSION}\n`)`
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
	const ompxPath = resolveOmpPath();
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
 * Remove a backup binary without letting the removal abort a completed update.
 *
 * On Windows the executable that was just moved aside is still mapped as the
 * running process image, so unlinking it fails with EPERM/EACCES until this
 * process exits (issue #845). The replacement and verification already
 * succeeded by the time we get here, so every error is swallowed; the leftover
 * is reclaimed by {@link sweepStaleBackups} on the next update once it is no
 * longer in use. Returns whether the file is gone.
 */
async function removeBackupBestEffort(filePath: string): Promise<boolean> {
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/**
 * Best-effort removal of binary-update backups left by earlier runs.
 *
 * Each self-update moves the previous executable to `<binary>.<timestamp>.<pid>.bak`
 * before swapping the new one in. On Windows that backup cannot be deleted
 * while the updating process is alive, so it is left for a later run to reclaim
 * once its owning process has exited. Also matches the legacy fixed
 * `<binary>.bak` name produced before backups were timestamped, so users
 * upgrading from a buggy release get the orphaned file cleaned up.
 */
export async function sweepStaleBackups(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`) || !entry.endsWith(".bak")) continue;
		// Legacy "<base>.bak" → empty middle; new "<base>.<timestamp>.<pid>.bak"
		// → dot-separated numeric run. Anything else is an unrelated *.bak file.
		const middle = entry.slice(base.length + 1, entry.length - ".bak".length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		await removeBackupBestEffort(path.join(dir, entry));
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		// `backupPath` is unique per attempt (see updateViaBinaryAt), so this rename
		// never has to overwrite — or unlink — a possibly-locked leftover from an
		// earlier run. Renaming the running executable itself is permitted on
		// Windows; only deleting its still-mapped image is not.
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
		// Swap done and verified. On Windows the backup is still the running
		// process image and cannot be unlinked until this process exits, so a
		// failure here must NOT fail an otherwise-successful update.
		await removeBackupBestEffort(options.backupPath);
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

function buildVersionedPackageInstallArgs(expectedVersion: string, nativeTag: string): string[] {
	const args = [`${PACKAGE}@${expectedVersion}`, `${NATIVES_PACKAGE}@${expectedVersion}`];
	if (SUPPORTED_NATIVE_TAGS.has(nativeTag)) {
		args.push(`${NATIVES_PACKAGE}-${nativeTag}@${expectedVersion}`);
	}
	return args;
}

/**
 * Build the bun argv used to globally install a specific omp version.
 *
 * The install is retained as a testable compatibility helper, but the OMPx app
 * updater itself uses the qtnx/omppp release and pinned install script path.
 */
export function buildBunInstallArgs(expectedVersion: string, nativeTag: string = currentNativeTag()): string[] {
	return [
		"install",
		"-g",
		"--no-cache",
		`--registry=${NPM_REGISTRY}`,
		...buildVersionedPackageInstallArgs(expectedVersion, nativeTag),
	];
}

/** Build the npm argv used to update npm-managed global installs. */
export function buildNpmInstallArgs(expectedVersion: string, nativeTag: string = currentNativeTag()): string[] {
	const args = [
		"install",
		"-g",
		`--registry=${NPM_REGISTRY}`,
		...buildVersionedPackageInstallArgs(expectedVersion, nativeTag),
	];
	return args;
}

export function buildHomebrewUpdateArgs(force: boolean): string[] {
	return [force ? "reinstall" : "upgrade", HOMEBREW_FORMULA];
}

export function buildMiseUpgradeArgs(): string[] {
	return ["upgrade", MISE_TOOL, "--bump"];
}

export function buildMiseForceInstallArgs(expectedVersion: string): string[] {
	return ["install", "--force", `${MISE_TOOL}@${expectedVersion}`];
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, release: ReleaseInfo): Promise<void> {
	const binaryName = getBinaryNameForPlatform(process.platform, process.arch);

	const tempPath = `${targetPath}.new`;
	// Unique per attempt: a stale backup from an earlier update may still be
	// locked (it is the previous process image on Windows), and a fixed name
	// would force the move-aside rename to overwrite it. pid + timestamp keeps
	// two forced updates in the same millisecond from colliding.
	const backupPath = `${targetPath}.${Date.now()}.${process.pid}.bak`;
	await downloadReleaseAsset({ release, binaryName, tempPath });

	console.log(chalk.dim("Installing update..."));
	await replaceBinaryForUpdate({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion: release.version,
		verifyInstalledVersion,
	});
	// Reclaim backups from earlier updates whose owning process has since exited.
	await sweepStaleBackups(targetPath);
	printVerifiedVersion(release.version);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/** Dependencies for {@link updateViaInstallScript}; injectable for tests. */
export interface InstallScriptUpdateOptions {
	targetPath: string;
	release: ReleaseInfo;
	fetchScript?: (url: string) => Promise<string>;
	runScript?: (scriptPath: string, args: string[], installDir: string) => Promise<number>;
	verifyInstalledVersion?: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

async function fetchInstallScript(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Install script download failed: ${response.status} ${response.statusText}`);
	}
	return response.text();
}

async function runInstallScript(scriptPath: string, args: string[], installDir: string): Promise<number> {
	const proc = Bun.spawn(["sh", scriptPath, ...args], {
		env: { ...process.env, PI_INSTALL_DIR: installDir },
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}

/**
 * Update by running the repo install script pinned to the release tag.
 *
 * `PI_INSTALL_DIR` steers the script at the directory of the currently
 * resolved binary, and `--binary --ref <tag>` pins the exact release — no
 * "latest" race between our version check and the script's own resolution.
 * The script verifies the SHA256SUMS entry itself and seeds the standard
 * config when missing; we keep a backup of the current binary and restore it
 * when the script fails or the updated binary reports the wrong version.
 */
export async function updateViaInstallScript(options: InstallScriptUpdateOptions): Promise<void> {
	const { targetPath, release } = options;
	const fetchScript = options.fetchScript ?? fetchInstallScript;
	const runScript = options.runScript ?? runInstallScript;
	const verify = options.verifyInstalledVersion ?? verifyInstalledVersion;

	const script = await fetchScript(installScriptUrl(release.tag));

	const scriptPath = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompx-update-")), "install.sh");
	await Bun.write(scriptPath, script);

	const backupPath = `${targetPath}.bak`;
	await unlinkIfExists(backupPath);
	await fs.promises.copyFile(targetPath, backupPath);

	try {
		console.log(chalk.dim("Running install script..."));
		const exitCode = await runScript(scriptPath, ["--binary", "--ref", release.tag], path.dirname(targetPath));
		if (exitCode !== 0) {
			throw new Error(`install script exited with code ${exitCode}`);
		}

		const verification = await verify(release.version);
		if (!verification.ok) {
			throw new Error(formatVerificationFailure(verification, release.version));
		}

		await removeBackupBestEffort(backupPath);
	} catch (err) {
		// Restore best-effort: never mask the root failure with a rollback error.
		try {
			await unlinkIfExists(targetPath);
			await fs.promises.rename(backupPath, targetPath);
		} catch (restoreErr) {
			throw new Error(
				`${err instanceof Error ? err.message : err}; failed to restore previous ${APP_NAME} binary: ${restoreErr}`,
			);
		}
		throw new Error(`${err instanceof Error ? err.message : err}; restored previous ${APP_NAME} binary`);
	} finally {
		await fs.promises.rm(path.dirname(scriptPath), { recursive: true, force: true });
	}
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

	// POSIX: run the pinned install script (one source of truth with fresh
	// installs — checksum verify + standard-config seeding). Windows or a
	// failed script fetch falls back to the in-place binary swap.
	try {
		const targetPath = resolveOmpxTarget();
		if (process.platform === "win32") {
			await updateViaBinaryAt(targetPath, release);
		} else {
			try {
				await updateViaInstallScript({ targetPath, release });
				printVerifiedVersion(release.version);
				console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
			} catch (err) {
				console.error(chalk.yellow(`Install script update failed: ${err}`));
				console.log(chalk.dim("Falling back to direct binary download..."));
				await updateViaBinaryAt(targetPath, release);
			}
		}
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
  -c, --check     Check for updates without installing
  -f, --force     Force reinstall even if up to date
  -l, --plugins   Update installed plugins

${chalk.bold("Examples:")}
  ${APP_NAME} update              Update to latest version
  ${APP_NAME} update --check      Check if updates are available
  ${APP_NAME} update --force      Force reinstall
  ${APP_NAME} update -l           Update installed plugins
`);
}
