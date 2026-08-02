/**
 * Manage this session's integration with the Herdr terminal multiplexer.
 *
 * `install` creates the `omp`-named entrypoint herdr's built-in `omp` agent
 * kind needs in order to keep driving this pane (`herdr agent prompt`,
 * `herdr agent send-keys`); see `src/herdr/entrypoint.ts` for why the process
 * name — not the reported agent label — is what herdr checks.
 */
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isCompiledBinary, logger, workerHostEntry } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import chalk from "chalk";
import { sendControlPrompt } from "../herdr/control-client";
import {
	HERDR_OMP_ENTRYPOINT_NAME,
	inspectHerdrEntrypoint,
	installHerdrEntrypoint,
	uninstallHerdrEntrypoint,
} from "../herdr/entrypoint";
import { type FleetAgentSettled, HerdrFleetWatcher } from "../herdr/fleet-watcher";
import {
	type HerdrNotifyPayload,
	listNotifyDescriptors,
	type NotifyDescriptor,
	notifyRunDir,
	pruneNotifyDescriptor,
	renderSettledNotification,
} from "../herdr/notify-optin";
import { herdrSocketPath, isHerdrPane } from "../herdr/socket";

const ACTIONS = ["status", "install", "uninstall", "watch"] as const;

const DEFAULT_MIN_WORK_MS = 5_000;
const NOTIFY_TIMEOUT_MS = 5_000;

export interface HerdrWatchFanoutOptions {
	/** Test seam; defaults to {@link notifyRunDir}. */
	runDir?: string;
}

interface WatchCommandOptions {
	minWorkMs: number;
	detach?: boolean;
	status?: boolean;
	stop?: boolean;
}

interface WatchLock {
	handle: fs.FileHandle;
	path: string;
}

interface RunningWatch {
	pid: number;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = errorCode(error);
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

function settledNotificationPayload(settled: FleetAgentSettled): HerdrNotifyPayload {
	return {
		paneId: settled.paneId,
		status: settled.status,
		...(settled.workspaceId !== undefined ? { workspaceId: settled.workspaceId } : {}),
		...(settled.agent !== undefined ? { agent: settled.agent } : {}),
		...(settled.name !== undefined ? { name: settled.name } : {}),
		...(settled.workedMs !== undefined ? { workedMs: settled.workedMs } : {}),
		...(settled.title !== undefined ? { title: settled.title } : {}),
	};
}

async function notifyOneSession(
	descriptor: NotifyDescriptor,
	settled: FleetAgentSettled,
	text: string,
	runDir: string | undefined,
): Promise<void> {
	// A pane never gets told about itself.
	if (descriptor.paneId === settled.paneId) return;
	// A descriptor outliving its session is the normal stale case (crash, kill).
	if (!pidAlive(descriptor.pid)) {
		await pruneNotifyDescriptor(descriptor.sessionId, runDir);
		return;
	}
	// `followUp` queues behind the session's current turn instead of interrupting it.
	const result = await sendControlPrompt(
		text,
		{ socketPath: descriptor.socket },
		{ deliverAs: "followUp", timeoutMs: NOTIFY_TIMEOUT_MS },
	);
	if (result.ok) return;
	logger.debug("herdr watch: notification not delivered", {
		sessionId: descriptor.sessionId,
		code: result.code,
		message: result.message,
	});
	if (result.code === "gone" && !pidAlive(descriptor.pid)) {
		await pruneNotifyDescriptor(descriptor.sessionId, runDir);
	}
}

/**
 * Deliver one settled-agent event to every opted-in local session.
 *
 * Delivery rides the session's own control socket (unix, mode 0600), so the
 * kernel is the access control: no port, no token, nothing to configure.
 */
export async function fanoutHerdrSettled(
	settled: FleetAgentSettled,
	options: HerdrWatchFanoutOptions = {},
): Promise<void> {
	const descriptors = await listNotifyDescriptors(options.runDir);
	if (descriptors.length === 0) return;
	const text = renderSettledNotification(settledNotificationPayload(settled));
	await Promise.allSettled(descriptors.map(d => notifyOneSession(d, settled, text, options.runDir)));
}

async function readWatchLockPid(lockPath: string): Promise<number | undefined> {
	try {
		const lockText = await Bun.file(lockPath).text();
		const pid = Number.parseInt(lockText.split(/\r?\n/, 1)[0] ?? "", 10);
		return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
	} catch (error) {
		if (errorCode(error) !== "ENOENT") {
			logger.debug("herdr watch: could not read lock", { lockPath, error: String(error) });
		}
		return undefined;
	}
}

async function acquireWatchLock(lockPath: string): Promise<WatchLock | RunningWatch> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const handle = await fs.open(lockPath, "wx", 0o600);
			try {
				await handle.writeFile(`${process.pid}\n`);
				return { handle, path: lockPath };
			} catch (error) {
				await handle.close().catch(() => undefined);
				await fs.unlink(lockPath).catch(() => undefined);
				throw error;
			}
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}

		const pid = await readWatchLockPid(lockPath);
		if (pid !== undefined && pidAlive(pid)) return { pid };
		try {
			await fs.unlink(lockPath);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
	throw new Error(`could not acquire watch lock: ${lockPath}`);
}

/**
 * Release the lock synchronously.
 *
 * This runs from the SIGINT/SIGTERM path, and by then the watcher has already
 * closed its socket — with no handles left, the runtime exits before an awaited
 * `fs.promises.unlink` resolves, which strands the lock file and makes the next
 * start take a stale-lock recovery path. Sync calls are the only ones guaranteed
 * to complete during shutdown.
 */
function releaseWatchLock(lock: WatchLock): void {
	try {
		fsSync.closeSync(lock.handle.fd);
	} catch (error) {
		logger.debug("herdr watch: lock close failed", { lockPath: lock.path, error: String(error) });
	}
	try {
		fsSync.unlinkSync(lock.path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") {
			logger.debug("herdr watch: lock removal failed", { lockPath: lock.path, error: String(error) });
		}
	}
}

function watchChildCommand(minWorkMs: number): string[] {
	const args = ["herdr", "watch", "--min-work-ms", String(minWorkMs)];
	if (isCompiledBinary()) return [process.execPath, ...args];
	return [process.execPath, workerHostEntry() ?? Bun.main, ...args];
}

async function reportWatchStatus(lockPath: string): Promise<void> {
	const pid = await readWatchLockPid(lockPath);
	if (pid !== undefined && pidAlive(pid)) {
		process.stdout.write(`running (pid ${pid})\n`);
		return;
	}
	process.stdout.write("not running\n");
}

async function stopWatch(lockPath: string): Promise<void> {
	const pid = await readWatchLockPid(lockPath);
	if (pid === undefined || !pidAlive(pid)) {
		process.stdout.write("not running\n");
		return;
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		if (errorCode(error) === "ESRCH") {
			process.stdout.write("not running\n");
			return;
		}
		throw error;
	}
	process.stdout.write(`sent SIGTERM to pid ${pid}\n`);
}

async function runWatch(options: WatchCommandOptions): Promise<void> {
	const lockPath = path.join(getConfigRootDir(), "run", "herdr-watch.lock");
	if (options.status && options.stop) throw new Error("--status and --stop are mutually exclusive");
	if (options.detach && (options.status || options.stop)) {
		throw new Error("--detach cannot be used with --status or --stop");
	}
	if (options.status) {
		await reportWatchStatus(lockPath);
		return;
	}
	if (options.stop) {
		await stopWatch(lockPath);
		return;
	}
	if (!Number.isSafeInteger(options.minWorkMs) || options.minWorkMs < 0) {
		throw new Error("--min-work-ms must be a non-negative integer");
	}

	const socketPath = herdrSocketPath();
	if (!socketPath) {
		throw new Error("HERDR_SOCKET_PATH is not set; run `ompx herdr watch` from a herdr pane");
	}
	if (options.detach) {
		const child = Bun.spawn(watchChildCommand(options.minWorkMs), {
			stdio: ["ignore", "ignore", "ignore"],
			detached: true,
		});
		if (child.pid === undefined) throw new Error("watch bridge did not expose a process id");
		child.unref();
		process.stdout.write(`started watch bridge (pid ${child.pid})\n`);
		return;
	}

	const lock = await acquireWatchLock(lockPath);
	if ("pid" in lock) {
		process.stdout.write(`already running (pid ${lock.pid})\n`);
		return;
	}

	const watcher = new HerdrFleetWatcher({
		socketPath,
		minWorkMs: options.minWorkMs,
		onSettled: settled => {
			void fanoutHerdrSettled(settled);
		},
	});
	const stopped = Promise.withResolvers<void>();
	let stopping = false;
	const stop = async (): Promise<void> => {
		if (stopping) return stopped.promise;
		stopping = true;
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		try {
			await watcher.stop();
		} catch (error) {
			logger.debug("herdr watch: watcher stop failed", { error: String(error) });
		}
		releaseWatchLock(lock);
		stopped.resolve();
	};
	const onSignal = (signal: NodeJS.Signals): void => {
		logger.debug("herdr watch: received shutdown signal", { signal });
		void stop();
	};

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		await watcher.start();
		logger.debug("herdr watch: started", { socketPath, minWorkMs: options.minWorkMs });
		process.stdout.write("watching herdr events\n");
		await stopped.promise;
	} finally {
		await stop();
	}
}

export default class Herdr extends Command {
	static description = "Manage the Herdr integration (install the `omp` entrypoint herdr control needs)";

	static args = {
		action: Args.string({ description: "Action to perform", required: false, options: [...ACTIONS] }),
	};

	static flags = {
		force: Flags.boolean({ description: "Replace an existing `omp` entrypoint that points elsewhere" }),
		dir: Flags.string({ description: "Directory for the entrypoint (default: next to the ompx executable)" }),
		target: Flags.string({ description: "ompx executable to link (default: the running one)" }),
		json: Flags.boolean({ description: "Output JSON" }),
		"min-work-ms": Flags.integer({
			description: "Minimum milliseconds a pane must work before notification",
			default: DEFAULT_MIN_WORK_MS,
		}),
		detach: Flags.boolean({ description: "Run the watch bridge in a detached process" }),
		status: Flags.boolean({ description: "Show whether the watch bridge is running (watch only)" }),
		stop: Flags.boolean({ description: "Send SIGTERM to the watch bridge (watch only)" }),
	};

	static examples = [
		"ompx herdr status",
		"ompx herdr install",
		"ompx herdr uninstall",
		"ompx herdr watch",
		"ompx herdr watch --detach",
		"ompx herdr watch --status",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Herdr);
		const action = (args.action ?? "status") as (typeof ACTIONS)[number];
		const options = { dir: flags.dir, target: flags.target };

		try {
			if (action === "watch") {
				await runWatch({
					minWorkMs: flags["min-work-ms"] ?? DEFAULT_MIN_WORK_MS,
					detach: flags.detach,
					status: flags.status,
					stop: flags.stop,
				});
				return;
			}
			if (action === "uninstall") {
				const { removed, status } = await uninstallHerdrEntrypoint(options);
				if (flags.json) {
					process.stdout.write(`${JSON.stringify({ action, removed, ...status }, null, 2)}\n`);
					return;
				}
				process.stdout.write(
					removed
						? `removed ${status.linkPath}\n`
						: `nothing to remove: ${status.linkPath} is not an ompx entrypoint\n`,
				);
				return;
			}

			const status =
				action === "install"
					? await installHerdrEntrypoint({ ...options, force: flags.force })
					: await inspectHerdrEntrypoint(options);

			if (flags.json) {
				process.stdout.write(`${JSON.stringify({ action, inHerdrPane: isHerdrPane(), ...status }, null, 2)}\n`);
				return;
			}

			const mark = status.state === "linked" ? chalk.green("ok") : chalk.yellow(status.state);
			process.stdout.write(`entrypoint  ${mark}  ${status.linkPath} -> ${status.existingTarget ?? status.target}\n`);
			process.stdout.write(
				`pane        ${isHerdrPane() ? chalk.green("inside herdr") : chalk.dim("not in a herdr pane")}\n`,
			);
			if (status.state === "missing") {
				process.stdout.write(chalk.dim("run `ompx herdr install` so `herdr agent prompt` can drive this agent\n"));
			}
			for (const rcPath of status.shadowedBy) {
				process.stdout.write(
					chalk.yellow(
						`warning: ${rcPath} defines an \`alias ${HERDR_OMP_ENTRYPOINT_NAME}=…\` that shadows the entrypoint; ` +
							`remove it so herdr launches the ${HERDR_OMP_ENTRYPOINT_NAME} link\n`,
					),
				);
			}
		} catch (error) {
			process.stderr.write(chalk.red(`error: ${error instanceof Error ? error.message : String(error)}\n`));
			process.exit(1);
		}
	}
}
