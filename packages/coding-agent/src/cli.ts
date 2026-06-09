#!/usr/bin/env bun
import "./cli/preload-env";

// `preload-env` must stay above broader CLI imports. It captures inherited
// sandbox flags before pi-utils overlays .env files and strips macOS malloc
// logging vars before this entrypoint spawns subprocesses/workers.

/**
 * CLI entry point — registers all commands explicitly and delegates to the
 * lightweight CLI runner from pi-utils.
 */
import { type CliConfig, run } from "@oh-my-pi/pi-utils/cli";
import { APP_NAME, MIN_BUN_VERSION, VERSION } from "@oh-my-pi/pi-utils/dirs";
import { extractRootNoSandboxFlag } from "./cli/sandbox-flags";
import { commands, isSubcommand } from "./cli-commands";
import {
	disableMacOSSandboxForProcess,
	disconnectMacOSSandboxSupervisor,
	reexecUnderMacOSSandboxIfNeeded,
} from "./task/omp-command";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		`error: Bun runtime must be >= ${MIN_BUN_VERSION} (found v${Bun.version}). Please upgrade: bun upgrade\n`,
	);
	process.exit(1);
}

process.title = APP_NAME;

async function showHelp(config: CliConfig): Promise<void> {
	const { renderRootHelp } = await import("@oh-my-pi/pi-utils/cli");
	const { getExtraHelpText } = await import("./cli/args");
	renderRootHelp(config);
	const extra = getExtraHelpText();
	if (extra.trim().length > 0) {
		process.stdout.write(`\n${extra}\n`);
	}
}
/**
 * Smoke-test entry. Spawns bundled workers, pings them, exits.
 *
 * Purpose: catch the silent worker-load regressions that hit compiled
 * binaries (issues #1011 and #1027). Version/help paths do not spawn worker
 * modules on a fresh install, so this probe is the minimal end-to-end test
 * that proves `new Worker(...)` resolves and bundled worker modules evaluate.
 * Wired into `scripts/install-tests/run-ci.sh` so binary / source-link /
 * tarball installs all exercise it on every CI run.
 */
async function runSmokeTest(): Promise<void> {
	const { smokeTestSyncWorker } = await import("@oh-my-pi/omp-stats");
	const { smokeTestTinyTitleWorker } = await import("./tiny/title-client");
	await smokeTestSyncWorker();
	await smokeTestTinyTitleWorker();
	process.stdout.write("smoke-test: ok\n");
}

/**
 * Hidden subcommand that boots the tiny-model worker inside this process
 * over the parent's IPC channel. The agent's main process spawns the same
 * binary with this flag so `onnxruntime-node` (loaded transitively by
 * `@huggingface/transformers`) lives in a child address space. The parent
 * `SIGKILL`s the child on shutdown so the NAPI finalizer never runs in
 * either process — that finalizer segfaults Bun on Windows (issue #1606).
 */
async function runTinyWorker(): Promise<void> {
	const { startTinyTitleWorker } = await import("./tiny/worker");
	const { promise: shuttingDown, resolve: shutdown } = Promise.withResolvers<void>();
	const send = (message: unknown): void => {
		// `process.send` only exists when spawned with an IPC channel; the
		// parent always spawns us that way. If it's missing, the parent
		// vanished and there's no one to talk to.
		const sender = (process as NodeJS.Process & { send?: (m: unknown) => boolean }).send;
		if (!sender) {
			shutdown();
			return;
		}
		try {
			sender.call(process, message);
		} catch {
			shutdown();
		}
	};
	startTinyTitleWorker({
		send,
		onMessage(handler) {
			const wrap = (data: unknown): void => handler(data as never);
			process.on("message", wrap);
			return () => {
				process.off("message", wrap);
			};
		},
	});
	// Parent went away (crashed, SIGKILL, etc.) — commit suicide so we don't
	// linger as an orphan. SIGKILL via `process.kill` keeps us symmetrical
	// with the parent's hard-kill on shutdown: skip every JS/native finalizer.
	process.on("disconnect", () => shutdown());
	await shuttingDown;
	process.kill(process.pid, "SIGKILL");
}

/** Run the CLI with the given argv (no `process.argv` prefix). */
export async function runCli(argv: string[]): Promise<void> {
	const rootSandbox = extractRootNoSandboxFlag(argv);
	if (rootSandbox.noSandbox) {
		disableMacOSSandboxForProcess();
	}
	argv = rootSandbox.argv;
	if (await reexecUnderMacOSSandboxIfNeeded(argv)) return;
	if (argv[0] === "--smoke-test") {
		await runSmokeTest();
		return;
	}
	if (argv[0] === "--tiny-worker") {
		await runTinyWorker();
		return;
	}
	// --help and --version are handled by run() directly, don't rewrite those.
	// Everything else that isn't a known subcommand routes to "launch".
	const first = argv[0];
	const runArgv =
		first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help"
			? argv
			: isSubcommand(first)
				? argv
				: ["launch", ...argv];
	return run({ bin: APP_NAME, version: VERSION, argv: runArgv, commands, help: showHelp });
}

try {
	await runCli(process.argv.slice(2));
} finally {
	disconnectMacOSSandboxSupervisor();
}
