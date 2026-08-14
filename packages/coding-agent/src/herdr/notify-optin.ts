/**
 * Opt-in marker for Herdr peer-agent notifications.
 *
 * A session that runs `/herdr-notify on` publishes a descriptor under
 * `<configRoot>/run/notify`; the `ompx herdr watch` bridge treats that file as
 * the whole subscription list. Sessions that never opted in are simply absent.
 *
 * There is deliberately no server here. Delivery reuses the control socket the
 * session already serves (`session.prompt`), which is a unix socket at mode
 * 0600: the kernel enforces that only this user can connect, so there is no
 * port to bind, no token to manage, and nothing for the user to configure.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, logger, prompt } from "@oh-my-pi/pi-utils";
import { controlSocketPath } from "./control-server";
import settledTemplate from "./prompts/fleet-agent-settled.md" with { type: "text" };

export const NOTIFY_PROTOCOL_VERSION = 1;

/** Settled states herdr reports: `done` when the tab was unseen, `idle` when it was watched. */
export type HerdrSettledStatus = "done" | "idle";

/** What the bridge learned about a peer agent that just finished. */
export interface HerdrNotifyPayload {
	paneId: string;
	workspaceId?: string;
	agent?: string;
	/** Herdr named-agent name, when the pane hosts one. */
	name?: string;
	status: HerdrSettledStatus;
	workedMs?: number;
	title?: string;
}

/** Descriptor published by an opted-in session, consumed by the bridge. */
export interface NotifyDescriptor {
	version: number;
	sessionId: string;
	pid: number;
	/** Control socket to deliver through; already served by this session. */
	socket: string;
	cwd: string;
	startedAt: number;
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
}

export interface HerdrNotifyOptInOptions {
	sessionId: string;
	cwd: string;
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
	/** Test seam; defaults to `<configRoot>/run/notify`. */
	runDir?: string;
	/** Test seam; defaults to this session's control socket path. */
	socketPath?: string;
}

export interface HerdrNotifyStatus {
	enabled: boolean;
	descriptorPath?: string;
	socket?: string;
}

/** Directory holding one descriptor per opted-in session. */
export function notifyRunDir(): string {
	return path.join(getConfigRootDir(), "run", "notify");
}

export function notifyDescriptorPath(sessionId: string, runDir?: string): string {
	return path.join(runDir ?? notifyRunDir(), `${sessionId}.json`);
}

/** Render the follow-up message the session will receive for one settled peer. */
export function renderSettledNotification(payload: HerdrNotifyPayload): string {
	const workedSeconds = payload.workedMs && payload.workedMs > 0 ? Math.round(payload.workedMs / 1000) : undefined;
	return prompt.render(settledTemplate, {
		paneId: payload.paneId,
		name: payload.name,
		agent: payload.agent ?? "unknown",
		status: payload.status,
		title: payload.title,
		workedSeconds,
		// Herdr agent commands accept a unique agent name or the hosting pane id.
		readTarget: payload.name ?? payload.paneId,
	});
}

/** Descriptor path published by the live opt-in, when this session has one. */
let activeDescriptorPath: string | undefined;
let activeSocket: string | undefined;

export function herdrNotifyStatus(): HerdrNotifyStatus {
	if (!activeDescriptorPath) return { enabled: false };
	return { enabled: true, descriptorPath: activeDescriptorPath, socket: activeSocket };
}

/**
 * Publish this session's opt-in descriptor.
 *
 * Throws when the control socket is absent, because delivery has no other
 * route — `HERDR_CONTROL_SOCKET=0` disables it, and the caller surfaces that as
 * an actionable message rather than silently enabling a dead subscription.
 */
export async function enableHerdrNotify(options: HerdrNotifyOptInOptions): Promise<HerdrNotifyStatus> {
	const socket = options.socketPath ?? controlSocketPath(options.sessionId);
	// `Bun.file(...).exists()` answers false for a unix socket node, so presence
	// has to come from stat: the control socket is exactly the case we check for.
	try {
		await fs.stat(socket);
	} catch {
		throw new Error(`no control socket at ${socket}; unset HERDR_CONTROL_SOCKET=0 and restart the session`);
	}
	const descriptorPath = notifyDescriptorPath(options.sessionId, options.runDir);
	await fs.mkdir(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
	const descriptor: NotifyDescriptor = {
		version: NOTIFY_PROTOCOL_VERSION,
		sessionId: options.sessionId,
		pid: process.pid,
		socket,
		cwd: options.cwd,
		startedAt: Date.now(),
		...(options.paneId ? { paneId: options.paneId } : {}),
		...(options.tabId ? { tabId: options.tabId } : {}),
		...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
	};
	await Bun.write(descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
	// `Bun.write`'s mode only applies on create and is umask-filtered; chmod makes
	// the 0600 guarantee unconditional, including when overwriting an older file.
	await fs.chmod(descriptorPath, 0o600);
	activeDescriptorPath = descriptorPath;
	activeSocket = socket;
	return herdrNotifyStatus();
}

/** Withdraw the opt-in. Idempotent; never throws. */
export async function disableHerdrNotify(): Promise<void> {
	const descriptorPath = activeDescriptorPath;
	activeDescriptorPath = undefined;
	activeSocket = undefined;
	if (!descriptorPath) return;
	try {
		await fs.unlink(descriptorPath);
	} catch (error) {
		logger.debug("herdr-notify: descriptor removal failed", { descriptorPath, error: String(error) });
	}
}

/** Read every published descriptor. Malformed files are skipped, never fatal. */
export async function listNotifyDescriptors(runDir?: string): Promise<NotifyDescriptor[]> {
	const dir = runDir ?? notifyRunDir();
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return [];
	}
	const found: NotifyDescriptor[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const descriptorPath = path.join(dir, entry);
		try {
			const parsed: unknown = JSON.parse(await Bun.file(descriptorPath).text());
			if (typeof parsed !== "object" || parsed === null) continue;
			const descriptor = parsed as NotifyDescriptor;
			if (typeof descriptor.sessionId !== "string" || typeof descriptor.socket !== "string") continue;
			if (typeof descriptor.pid !== "number") continue;
			found.push(descriptor);
		} catch {
			// Half-written or corrupt descriptor: ignore this round.
		}
	}
	return found;
}

/** Remove a descriptor whose session is gone. */
export async function pruneNotifyDescriptor(sessionId: string, runDir?: string): Promise<void> {
	try {
		await fs.unlink(notifyDescriptorPath(sessionId, runDir));
	} catch {
		// Already gone.
	}
}
