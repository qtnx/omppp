/**
 * Optional RTK command compression for the bash tool.
 *
 * `rtk rewrite <command>` maps a shell command onto its rtk-prefixed
 * equivalent, which emits far less output for the same work. RTK is the single
 * source of truth for which commands have equivalents: this module never keeps
 * its own rewrite table.
 *
 * Exit-code contract (upstream `rtk-ai/rtk`):
 *   0 + stdout  rewrite found
 *   3 + stdout  advisory rewrite, treated identically
 *   anything else / no stdout  no equivalent, run the original command
 *
 * Every failure path is fail-open: a missing binary, an old binary without the
 * `rewrite` subcommand, a spawn error, an abort, or a timeout returns the
 * original command bytes so bash execution is never blocked by RTK.
 */
import { $which } from "@oh-my-pi/pi-utils/which";

const RTK_COMMAND = "rtk";
const REWRITE_TIMEOUT_MS = 2_000;
/** Exit codes that mean "stdout holds a usable rewrite". */
const REWRITE_EXIT_CODES: Record<number, true> = { 0: true, 3: true };

export interface RtkRewriteOptions {
	/**
	 * Executable to invoke. Omit to resolve `rtk` on PATH; pass `null` to skip
	 * the subprocess entirely (RTK unavailable).
	 */
	executable?: string | null;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Returns the RTK-compressed equivalent of `command`, or `command` unchanged
 * when RTK is unavailable, errors, or has no equivalent.
 */
export async function rewriteCommandWithRtk(command: string, options?: RtkRewriteOptions): Promise<string> {
	const trimmed = command.trim();
	// Nothing to rewrite, and an already-rewritten command must not be re-fed to
	// RTK: a second pass would either no-op or double-wrap the invocation.
	if (!trimmed || trimmed.startsWith(`${RTK_COMMAND} `)) return command;

	const executable = options?.executable === undefined ? $which(RTK_COMMAND) : options.executable;
	if (!executable) return command;

	try {
		const child = Bun.spawn([executable, "rewrite", command], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			signal: options?.signal,
			timeout: options?.timeoutMs ?? REWRITE_TIMEOUT_MS,
			windowsHide: true,
		});
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		if (!REWRITE_EXIT_CODES[exitCode]) return command;
		const rewritten = stdout.trim();
		return rewritten || command;
	} catch {
		// Spawn failure, abort, or kill: run what the model actually asked for.
		return command;
	}
}
