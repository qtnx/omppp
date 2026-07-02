import * as net from "node:net";
import { isUsageLimit } from "@oh-my-pi/pi-ai/error/flags";
import { isUnexpectedSocketCloseMessage, logger } from "@oh-my-pi/pi-utils";
import { ASYNC_JOB_LIFECYCLE_CHANNEL } from "../../async";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../task";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "./types";

export const HERDR_AGENT_STATE_LABEL = "Herdr Agent State";
export const HERDR_NATIVE_AGENT_STATE_ENV = "OMP_NATIVE_HERDR_AGENT_STATE";
export const HERDR_MANAGED_FALLBACK_SENTINEL = "HERDR_OMP_MANAGED_FALLBACK_V3";

const SOURCE = "herdr:omp";
const AGENT = "omp";
const DEFAULT_IDLE_DEBOUNCE_MS = 250;
const DEFAULT_RETRY_GRACE_MS = 2_500;
const SOCKET_TIMEOUT_MS = 500;

const retryableErrorPattern =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|upstream.?request.?failed|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay|stream stall|no error details in response|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)/i;

function isRetryableErrorMessage(errorMessage: string): boolean {
	return (
		isUsageLimit(errorMessage) ||
		isUnexpectedSocketCloseMessage(errorMessage) ||
		(/anthropic stream envelope error:/i.test(errorMessage) && /before message_start/i.test(errorMessage)) ||
		retryableErrorPattern.test(errorMessage)
	);
}

type HerdrAgentState = "working" | "blocked" | "idle";
type HerdrMethod = "pane.report_agent" | "pane.release_agent";

type HerdrRequest = {
	id: string;
	method: HerdrMethod;
	params: Record<string, unknown>;
};

export type HerdrAgentStateTransport = (request: HerdrRequest) => Promise<void>;

export interface HerdrAgentStateExtensionOptions {
	env?: NodeJS.ProcessEnv;
	transport?: HerdrAgentStateTransport;
}

type QueuedState = {
	state: HerdrAgentState;
	message?: string;
	customStatus?: string;
	seq: number;
};

type AssistantLike = {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
};

type DesiredState = {
	state: HerdrAgentState;
	customStatus?: string;
	message?: string;
};

function parseDurationEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function isEnabledEnv(env: NodeJS.ProcessEnv): boolean {
	return env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH && !!env.HERDR_PANE_ID;
}

export function isNativeHerdrAgentStateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[HERDR_NATIVE_AGENT_STATE_ENV] !== "0" && isEnabledEnv(env);
}

export function markNativeHerdrAgentStateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!isNativeHerdrAgentStateEnabled(env)) return false;
	env[HERDR_NATIVE_AGENT_STATE_ENV] = "1";
	return true;
}

function createSocketTransport(env: NodeJS.ProcessEnv): HerdrAgentStateTransport {
	let firstReportDelivered = false;
	return async request => {
		const socketPath = env.HERDR_SOCKET_PATH;
		if (!socketPath) return;

		const deferred = Promise.withResolvers<void>();
		let done = false;
		let timedOut = false;
		let timeout: NodeJS.Timeout | undefined;
		let socket: net.Socket | undefined;
		const finish = (delivered = false): void => {
			if (done) return;
			done = true;
			clearTimeout(timeout);
			if (timedOut) {
				logger.debug("herdr-agent-state: transport timeout", { paneId: env.HERDR_PANE_ID });
			} else if (delivered && !firstReportDelivered && request.method === "pane.report_agent") {
				firstReportDelivered = true;
				logger.debug("herdr-agent-state: first report delivered");
			}
			socket?.destroy();
			deferred.resolve();
		};

		try {
			socket = net.createConnection(socketPath);
		} catch {
			return;
		}

		socket.on("error", err => {
			logger.debug("herdr-agent-state: transport error", { error: String(err) });
			finish();
		});
		socket.on("connect", () => socket?.write(`${JSON.stringify(request)}\n`));
		socket.on("data", () => finish(true));
		socket.on("end", () => finish(true));
		timeout = setTimeout(() => {
			timedOut = true;
			finish();
		}, SOCKET_TIMEOUT_MS);
		timeout.unref?.();
		await deferred.promise;
	};
}

function lastAssistantMessage(messages: unknown): AssistantLike | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (isRecord(message) && message.role === "assistant") return message;
	}
	return undefined;
}

function hasSnapshotWork(ctx: ExtensionContext | undefined, includePromptState: boolean): boolean {
	if (!ctx) return false;
	const snapshot = ctx.getAsyncJobSnapshot({ recentLimit: 0 });
	return (
		(includePromptState && !ctx.isIdle()) ||
		(ctx.hasPendingAgentWork?.() ?? ctx.hasPendingMessages()) ||
		(snapshot?.running.length ?? 0) > 0 ||
		(snapshot?.delivery.queued ?? 0) > 0 ||
		snapshot?.delivery.delivering === true
	);
}

function payloadId(data: unknown): string | undefined {
	if (!isRecord(data)) return undefined;
	return readString(data.id) ?? readString(data.jobId);
}

function payloadStatus(data: unknown): string | undefined {
	return isRecord(data) ? readString(data.status) : undefined;
}

function blockedPayload(data: unknown): { active: boolean; label?: string } | undefined {
	if (!isRecord(data)) return undefined;
	const active = boolValue(data.active);
	if (active === undefined) return undefined;
	return { active, label: readString(data.label) };
}

export function createHerdrAgentStateExtension(options: HerdrAgentStateExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const env = options.env ?? process.env;
		if (!isNativeHerdrAgentStateEnabled(env)) {
			logger.debug("herdr-agent-state: native reporter disabled", {
				herdrEnv: env.HERDR_ENV,
				hasSocket: !!env.HERDR_SOCKET_PATH,
				hasPane: !!env.HERDR_PANE_ID,
				marker: env.OMP_NATIVE_HERDR_AGENT_STATE,
			});
			return;
		}

		pi.setLabel(HERDR_AGENT_STATE_LABEL);

		const transport = options.transport ?? createSocketTransport(env);
		const paneId = env.HERDR_PANE_ID;
		if (!paneId) return;

		// Herdr tombstones a (pane, source) pair once that source sends
		// pane.release_agent: every later pane.report_agent from the same source
		// is silently ignored (regardless of seq or session re-registration), so
		// a respawned process reusing a static source can never report again.
		// A unique per-instance source lets every new session claim the pane.
		const source = `${SOURCE}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

		const idleDebounceMs = parseDurationEnv(env, "HERDR_OMP_IDLE_DEBOUNCE_MS", DEFAULT_IDLE_DEBOUNCE_MS);
		const retryGraceMs = parseDurationEnv(env, "HERDR_OMP_RETRY_GRACE_MS", DEFAULT_RETRY_GRACE_MS);
		let reportSeq = Date.now() * 1000;
		let agentActive = false;
		let turnActive = false;
		let compactionDepth = 0;
		let retryHoldActive = false;
		let failureBlocked = false;
		let failureMessage: string | undefined;
		let blockedCount = 0;
		let blockedMessage: string | undefined;
		let lastState: HerdrAgentState | undefined;
		let lastMessage: string | undefined;
		let lastCustomStatus: string | undefined;
		let idleTimer: NodeJS.Timeout | undefined;
		let retryTimer: NodeJS.Timeout | undefined;
		let queuedState: QueuedState | undefined;
		let drainPromise: Promise<void> | undefined;
		let lastContext: ExtensionContext | undefined;
		let runCompleted = false;
		const reviewWaits = new Map<string, string | undefined>();
		let closed = false;
		const activeTools = new Set<string>();
		const activeSubagents = new Set<string>();
		const activeAsyncJobs = new Set<string>();

		const nextReportSeq = (): number => {
			reportSeq += 1;
			return reportSeq;
		};

		const clearIdleTimer = (): void => {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		};

		const clearRetryTimer = (): void => {
			clearTimeout(retryTimer);
			retryTimer = undefined;
		};

		const clearPendingTimers = (): void => {
			clearIdleTimer();
			clearRetryTimer();
		};

		const clearFailureState = (): void => {
			clearRetryTimer();
			retryHoldActive = false;
			failureBlocked = false;
			failureMessage = undefined;
		};

		const hasTrackedWork = (): boolean =>
			agentActive ||
			turnActive ||
			compactionDepth > 0 ||
			retryHoldActive ||
			activeTools.size > 0 ||
			activeSubagents.size > 0 ||
			activeAsyncJobs.size > 0;

		const desiredState = (ctx?: ExtensionContext, options: { includePromptState?: boolean } = {}): DesiredState => {
			if (blockedCount > 0) return { state: "blocked", customStatus: "need review", message: blockedMessage };
			if (reviewWaits.size > 0) {
				const reviewWaitMessage = reviewWaits.values().next().value;
				return { state: "blocked", customStatus: "need review", message: reviewWaitMessage };
			}
			if (failureBlocked) return { state: "blocked", customStatus: "need review", message: failureMessage };
			if (hasTrackedWork() || hasSnapshotWork(ctx ?? lastContext, options.includePromptState !== false)) {
				return { state: "working", customStatus: "running" };
			}
			if (runCompleted) return { state: "idle", customStatus: "done" };
			return { state: "idle" };
		};

		const buildReportRequest = (
			state: HerdrAgentState,
			message: string | undefined,
			customStatus: string | undefined,
			seq: number,
		): HerdrRequest => ({
			id: `${source}:${Date.now()}:${seq}`,
			method: "pane.report_agent",
			params: {
				pane_id: paneId,
				source,
				agent: AGENT,
				state,
				message,
				custom_status: customStatus,
				seq,
			},
		});

		const buildReleaseRequest = (): HerdrRequest => {
			const seq = nextReportSeq();
			return {
				id: `${source}:release:${Date.now()}:${seq}`,
				method: "pane.release_agent",
				params: {
					pane_id: paneId,
					source,
					agent: AGENT,
					seq,
				},
			};
		};

		const drainStateQueue = async (): Promise<void> => {
			try {
				while (queuedState) {
					const next = queuedState;
					queuedState = undefined;
					try {
						await transport(buildReportRequest(next.state, next.message, next.customStatus, next.seq));
					} catch {
						// Herdr status is best-effort; a failed injected transport must not
						// break the agent loop or strand later coalesced state updates.
					}
				}
			} finally {
				drainPromise = undefined;
				if (queuedState) {
					drainPromise = drainStateQueue();
					void drainPromise;
				}
			}
		};

		const queueState = (state: HerdrAgentState, message?: string, customStatus?: string): void => {
			if (closed) return;
			queuedState = { state, message, customStatus, seq: nextReportSeq() };
			if (!drainPromise) {
				drainPromise = drainStateQueue();
				void drainPromise;
			}
		};

		const publishState = (ctx?: ExtensionContext, options?: { includePromptState?: boolean }): void => {
			if (closed) return;
			if (ctx) lastContext = ctx;
			const next = desiredState(ctx, options);
			if (next.state === lastState && next.message === lastMessage && next.customStatus === lastCustomStatus) return;
			lastState = next.state;
			lastMessage = next.message;
			lastCustomStatus = next.customStatus;
			queueState(next.state, next.message, next.customStatus);
		};

		const scheduleIdle = (ctx?: ExtensionContext): void => {
			if (ctx) lastContext = ctx;
			clearTimeout(idleTimer);
			if (idleDebounceMs === 0) {
				idleTimer = undefined;
				publishState(undefined, { includePromptState: false });
				return;
			}
			idleTimer = setTimeout(() => {
				idleTimer = undefined;
				publishState(undefined, { includePromptState: false });
			}, idleDebounceMs);
			idleTimer.unref?.();
		};

		const recheckTerminalState = (): void => {
			publishState(undefined, { includePromptState: false });
			const next = desiredState(undefined, { includePromptState: false });
			if (runCompleted && next.state === "working" && !hasTrackedWork()) {
				scheduleTerminalRecheck();
			}
		};

		const scheduleTerminalRecheck = (ctx?: ExtensionContext): void => {
			if (ctx) lastContext = ctx;
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				idleTimer = undefined;
				recheckTerminalState();
			}, idleDebounceMs);
			idleTimer.unref?.();
		};

		const holdForRetry = (message: string): void => {
			clearPendingTimers();
			retryHoldActive = true;
			failureBlocked = false;
			failureMessage = message;
			publishState();

			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				retryHoldActive = false;
				failureBlocked = true;
				publishState();
			}, retryGraceMs);
			retryTimer.unref?.();
		};

		const markWorkStarted = (ctx?: ExtensionContext, options: { clearFailure?: boolean } = {}): void => {
			clearIdleTimer();
			if (options.clearFailure) {
				clearFailureState();
			}
			publishState(ctx);
		};

		const completeMaybeIdle = (ctx?: ExtensionContext): void => {
			const next = desiredState(ctx, { includePromptState: false });
			if (next.state === "idle") {
				scheduleIdle(ctx);
				return;
			}
			publishState(ctx, { includePromptState: false });
			if (runCompleted && next.state === "working" && !hasTrackedWork()) {
				scheduleTerminalRecheck(ctx);
			}
		};

		pi.events.on("herdr:blocked", data => {
			const payload = blockedPayload(data);
			if (!payload) return;
			if (!payload.active) {
				blockedCount = Math.max(0, blockedCount - 1);
				if (blockedCount === 0) blockedMessage = undefined;
				completeMaybeIdle();
				return;
			}

			clearIdleTimer();
			blockedCount += 1;
			blockedMessage = payload.label;
			publishState();
		});

		pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
			const id = payloadId(data);
			const status = payloadStatus(data);
			if (!id || !status) return;
			if (status === "started") {
				activeSubagents.add(id);
				markWorkStarted();
				return;
			}
			if (status === "completed" || status === "failed" || status === "aborted") {
				activeSubagents.delete(id);
				completeMaybeIdle();
			}
		});

		pi.events.on(ASYNC_JOB_LIFECYCLE_CHANNEL, data => {
			const id = payloadId(data);
			const status = payloadStatus(data);
			if (!id || !status) return;
			if (status === "running") {
				activeAsyncJobs.add(id);
				markWorkStarted();
				return;
			}
			if (status === "completed" || status === "failed" || status === "cancelled") {
				activeAsyncJobs.delete(id);
				completeMaybeIdle();
			}
		});

		pi.on("session_start", (_event, ctx) => {
			runCompleted = false;
			publishState(ctx);
		});

		pi.on("session_switch", (_event, ctx) => {
			// Run-scoped state: guaranteed re-established by start events on the next run.
			// Subagent/async-job sets stay — jobs survive session switches and drain via
			// their lifecycle events.
			agentActive = false;
			turnActive = false;
			compactionDepth = 0;
			activeTools.clear();
			runCompleted = false;
			reviewWaits.clear();
			clearFailureState();
			clearIdleTimer();
			publishState(ctx, { includePromptState: false });
		});

		pi.on("input", (_event, ctx) => {
			runCompleted = false;
			// User responded: a stranded non-retryable failure no longer needs review.
			// Keep retry holds and pending approval/ask waits — those are still live.
			if (failureBlocked) {
				failureBlocked = false;
				failureMessage = undefined;
			}
			scheduleIdle(ctx);
		});

		pi.on("before_agent_start", (_event, ctx) => {
			runCompleted = false;
			markWorkStarted(ctx, { clearFailure: true });
		});

		pi.on("agent_start", (_event, ctx) => {
			runCompleted = false;
			agentActive = true;
			markWorkStarted(ctx, { clearFailure: true });
		});

		pi.on("turn_start", (_event, ctx) => {
			turnActive = true;
			markWorkStarted(ctx, { clearFailure: true });
		});

		pi.on("tool_execution_start", (event, ctx) => {
			activeTools.add(event.toolCallId);
			if (event.toolName === "ask") {
				reviewWaits.set(event.toolCallId, event.intent);
			}
			markWorkStarted(ctx);
		});

		pi.on("tool_execution_end", (event, ctx) => {
			activeTools.delete(event.toolCallId);
			reviewWaits.delete(event.toolCallId);
			completeMaybeIdle(ctx);
		});

		pi.on("tool_approval_requested", (event, ctx) => {
			reviewWaits.set(event.toolCallId, event.reason ?? `approval: ${event.toolName}`);
			clearIdleTimer();
			publishState(ctx);
		});

		pi.on("tool_approval_resolved", (event, ctx) => {
			reviewWaits.delete(event.toolCallId);
			completeMaybeIdle(ctx);
		});

		pi.on("auto_compaction_start", (_event, ctx) => {
			compactionDepth += 1;
			markWorkStarted(ctx);
		});

		pi.on("auto_compaction_end", (event, ctx) => {
			compactionDepth = Math.max(0, compactionDepth - 1);
			if (event.willRetry) {
				holdForRetry("compaction retry did not start");
				return;
			}
			completeMaybeIdle(ctx);
		});

		pi.on("auto_retry_start", (_event, ctx) => {
			clearPendingTimers();
			retryHoldActive = true;
			failureBlocked = false;
			failureMessage = undefined;
			publishState(ctx);
		});

		pi.on("auto_retry_end", (event, ctx) => {
			clearRetryTimer();
			retryHoldActive = false;
			if (!event.success && event.finalError) {
				failureBlocked = true;
				failureMessage = event.finalError;
				publishState(ctx);
				return;
			}
			failureBlocked = false;
			failureMessage = undefined;
			completeMaybeIdle(ctx);
		});

		pi.on("turn_end", (_event, ctx) => {
			turnActive = false;
			completeMaybeIdle(ctx);
		});

		pi.on("agent_end", (event, ctx) => {
			const reviewWaitToolCallIds = Array.from(reviewWaits.keys());
			reviewWaits.clear();
			for (const toolCallId of reviewWaitToolCallIds) {
				activeTools.delete(toolCallId);
			}
			agentActive = false;

			const assistant = lastAssistantMessage(event.messages);
			if (assistant?.stopReason === "error") {
				const errorMessage = readString(assistant.errorMessage) ?? "agent error";
				if (isRetryableErrorMessage(errorMessage)) {
					holdForRetry(errorMessage);
					return;
				}
				clearPendingTimers();
				retryHoldActive = false;
				failureBlocked = true;
				failureMessage = errorMessage;
				publishState(ctx);
				return;
			}

			if (
				assistant &&
				(assistant.stopReason === "stop" || assistant.stopReason === "toolUse" || assistant.stopReason === "length")
			) {
				runCompleted = true;
			}

			completeMaybeIdle(ctx);
		});

		pi.on("session_shutdown", async () => {
			closed = true;
			clearPendingTimers();
			queuedState = undefined;
			if (drainPromise) await drainPromise;
			try {
				await transport(buildReleaseRequest());
			} catch {
				// Herdr release is best-effort like state reports; shutdown must not fail.
			}
		});

		markNativeHerdrAgentStateEnabled(env);
		logger.debug("herdr-agent-state: native reporter active", { paneId });
		publishState(undefined, { includePromptState: false });
	};
}
