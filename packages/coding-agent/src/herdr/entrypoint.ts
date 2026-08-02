/**
 * Herdr's built-in `omp` agent kind binds a named agent to the pane's
 * *foreground process name*. This fork ships as `ompx`, so `herdr agent start
 * --kind omp` succeeds (the socket reporter identifies the session as agent
 * `omp`) and is then disowned on the next control call:
 *
 *   herdr agent prompt <name>    -> agent_not_ready: no longer the pane foreground process
 *   herdr agent send-keys <name> -> agent_not_ready: not an active named agent
 *
 * `process.title` cannot fix this: Bun's setter updates the JS-visible value
 * only, leaving `/proc/<pid>/comm` and the cmdline untouched. What the kernel
 * does honour is the name the binary was exec'd through, so an `omp`-named
 * symlink beside the real executable makes `comm` read `omp` and herdr keeps
 * ownership of the named agent — with no change on the herdr side.
 *
 * This is opt-in (`ompx herdr install`) because the name is shared with
 * upstream `omp`: silently claiming it would hijack a real installation.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, isEnoent, logger } from "@oh-my-pi/pi-utils";

/** The name herdr's `omp` kind expects in the pane's process table. */
export const HERDR_OMP_ENTRYPOINT_NAME = "omp";

/** Shell rc files that commonly define an `alias omp=…` shadowing the link. */
const SHELL_RC_FILES = [".zshrc", ".bashrc", ".bash_profile", ".profile"];
const SHADOWING_ALIAS = /^[^#\n]*\balias\s+omp=/m;

export type HerdrEntrypointState =
	/** `<dir>/omp` resolves to this ompx executable. */
	| "linked"
	/** Nothing occupies `<dir>/omp`. */
	| "missing"
	/** Something else already owns `<dir>/omp`. */
	| "conflict";

export interface HerdrEntrypointStatus {
	/** Absolute path of the ompx executable the link points (or would point) at. */
	target: string;
	/** Absolute path of the `omp` entrypoint. */
	linkPath: string;
	state: HerdrEntrypointState;
	/** Where `<dir>/omp` currently points, when it exists. */
	existingTarget?: string;
	/**
	 * Shell rc files defining an `alias omp=…`. An interactive shell expands the
	 * alias before PATH lookup, so herdr would still launch the aliased command
	 * and the process name would still be wrong.
	 */
	shadowedBy: string[];
}

/**
 * Absolute path of the running ompx executable, or undefined when ompx is being
 * run from source (`bun src/cli.ts`), where `execPath` is the bun binary.
 */
export function resolveOmpxExecutable(): string | undefined {
	const execPath = process.execPath;
	const name = path.basename(execPath).replace(/\.exe$/i, "");
	if (name !== "bun" && name !== "bunx" && name !== "node") return execPath;
	return $which("ompx") ?? undefined;
}

async function readShadowingAliases(homeDir: string): Promise<string[]> {
	const hits = await Promise.all(
		SHELL_RC_FILES.map(async name => {
			const rcPath = path.join(homeDir, name);
			try {
				return SHADOWING_ALIAS.test(await Bun.file(rcPath).text()) ? rcPath : undefined;
			} catch (error) {
				if (!isEnoent(error)) logger.debug("herdr-entrypoint: rc read failed", { rcPath, error: String(error) });
				return undefined;
			}
		}),
	);
	return hits.filter((hit): hit is string => hit !== undefined);
}

export interface HerdrEntrypointOptions {
	/** Directory to place the link in; defaults to the ompx executable's directory. */
	dir?: string;
	/** Executable to link to; defaults to {@link resolveOmpxExecutable}. */
	target?: string;
	/** Home directory scanned for shadowing aliases; test seam. */
	homeDir?: string;
}

async function describe(options: HerdrEntrypointOptions): Promise<HerdrEntrypointStatus> {
	const target = options.target ?? resolveOmpxExecutable();
	if (!target) {
		throw new Error(
			"cannot locate the ompx executable (running from source?); pass --target with the installed binary path",
		);
	}
	const linkPath = path.join(options.dir ?? path.dirname(target), HERDR_OMP_ENTRYPOINT_NAME);
	const shadowedBy = await readShadowingAliases(options.homeDir ?? os.homedir());

	let existingTarget: string | undefined;
	try {
		existingTarget = await fs.realpath(linkPath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return { target, linkPath, state: "missing", shadowedBy };
	}
	const linked = existingTarget === (await fs.realpath(target).catch(() => target));
	return { target, linkPath, state: linked ? "linked" : "conflict", existingTarget, shadowedBy };
}

export function inspectHerdrEntrypoint(options: HerdrEntrypointOptions = {}): Promise<HerdrEntrypointStatus> {
	return describe(options);
}

/**
 * Create (or repoint with `force`) the `omp` entrypoint. Refuses to clobber an
 * unrelated `omp` — that is very likely a real upstream install.
 */
export async function installHerdrEntrypoint(
	options: HerdrEntrypointOptions & { force?: boolean } = {},
): Promise<HerdrEntrypointStatus> {
	const status = await describe(options);
	if (status.state === "linked") return status;
	if (status.state === "conflict") {
		if (!options.force) {
			throw new Error(
				`${status.linkPath} already exists and points at ${status.existingTarget ?? "another file"}; re-run with --force to replace it`,
			);
		}
		await fs.rm(status.linkPath, { force: true });
	}
	await fs.mkdir(path.dirname(status.linkPath), { recursive: true });
	await fs.symlink(status.target, status.linkPath);
	logger.debug("herdr-entrypoint: installed", { linkPath: status.linkPath, target: status.target });
	return { ...status, state: "linked", existingTarget: status.target };
}

/** Remove the `omp` entrypoint, but only when it is ours. */
export async function uninstallHerdrEntrypoint(
	options: HerdrEntrypointOptions = {},
): Promise<{ removed: boolean; status: HerdrEntrypointStatus }> {
	const status = await describe(options);
	if (status.state !== "linked") return { removed: false, status };
	await fs.rm(status.linkPath, { force: true });
	return { removed: true, status: { ...status, state: "missing", existingTarget: undefined } };
}
