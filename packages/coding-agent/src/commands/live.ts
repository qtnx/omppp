/**
 * `ompx live --attach <ssh-target>` — the laptop half of the SSH live bridge
 * (deployment B).
 *
 * The microphone, speaker, WebRTC peer, Codex signaling, and the realtime
 * sideband all stay on this machine, so audio never crosses SSH. Only delegated
 * coding requests and their results travel, as newline-delimited JSON, through
 * `ssh <target> ompx live-agent --session <id>`.
 */

import { $which } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { BridgeAgentEndpoint, type BridgeWelcome } from "../live/bridge-agent-endpoint";
import { LiveSessionController, type LiveTranscript } from "../live/controller";
import { LiveInputDeviceError, LocalMediaEndpoint } from "../live/local-endpoints";
import type { LivePhase } from "../live/visualizer";
import { discoverAuthStorage } from "../session/auth-broker-config";

const PHASE_LABEL: Record<LivePhase, string> = {
	connecting: "connecting",
	listening: "listening",
	speaking: "speaking",
	working: "working on it",
	muted: "muted",
	error: "error",
};

export interface LiveAttachOptions {
	/** SSH destination, optionally `target:sessionId`. */
	target: string;
	/** Session id override; otherwise taken from the target suffix or `latest`. */
	session?: string;
	/** Ask the host to forward a Codex credential when this machine has none. */
	forwardCredentials?: boolean;
	/** Realtime output voice (timbre id). */
	voice?: string;
	/** BCP-47 spoken language for the call; defaults to `vi-VN`. */
	language?: string;
	/** Diagnostic sink; defaults to stdout. */
	write?: (text: string) => void;
	/** Abort signal wired to SIGINT/SIGTERM by the command. */
	signal?: AbortSignal;
}

/** Split `host:session` into its parts, tolerating IPv6 and plain hostnames. */
function splitTarget(target: string): { host: string; session?: string } {
	const lastColon = target.lastIndexOf(":");
	if (lastColon <= 0) return { host: target };
	const suffix = target.slice(lastColon + 1);
	// A bare `user@host` has no colon; `[::1]:sess` and `host:sess` do. Anything
	// that is not a plausible session id is treated as part of the host.
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suffix)) return { host: target };
	return { host: target.slice(0, lastColon), session: suffix };
}

/**
 * Run one attached live session. Resolves with a process exit code; never throws
 * for an expected failure (missing ssh, remote refusal, absent credential).
 */
export async function runLiveAttach(options: LiveAttachOptions): Promise<number> {
	const write = options.write ?? ((text: string) => process.stdout.write(text));
	const sshBin = $which("ssh");
	if (!sshBin) {
		write("Cannot attach: `ssh` was not found on PATH.\n");
		return 1;
	}
	const { host, session: targetSession } = splitTarget(options.target);
	const session = options.session ?? targetSession ?? "latest";

	const child = Bun.spawn([sshBin, "-T", host, "ompx", "live-agent", "--session", session], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});

	const writer = child.stdin;
	// Before `welcome` lands, a host error is already surfaced by the attach
	// failure below; printing it here too would double up on one cause.
	let attached = false;
	const agent = new BridgeAgentEndpoint({
		writer: {
			write: text => writer.write(text),
			end: () => writer.end(),
		},
		onError: message => {
			if (attached) write(`Remote: ${message}\n`);
		},
	});

	const stdout = child.stdout as ReadableStream<Uint8Array>;
	const pump = (async () => {
		for await (const chunk of stdout) agent.push(chunk);
		agent.fail("The remote live bridge closed the connection.");
	})();

	let welcome: BridgeWelcome;
	try {
		welcome = await agent.waitForWelcome();
	} catch (cause) {
		child.kill();
		await pump.catch(() => {});
		write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
		return 1;
	}
	attached = true;

	write(`Attached to ${host} — session ${welcome.sessionId} in ${welcome.cwd}\n`);
	write("Speak to the assistant; press Ctrl+C to end the call.\n");

	const media = new LocalMediaEndpoint();
	const controller = new LiveSessionController({
		media,
		agent,
		identity: welcome,
		authStorage: await discoverAuthStorage(),
		voice: options.voice,
		language: options.language,
		callbacks: {
			onPhase: phase => {
				write(`[${PHASE_LABEL[phase]}]\n`);
				agent.reportPhase(phase);
			},
			onTranscript: (transcript: LiveTranscript | undefined) => {
				if (!transcript?.final) return;
				write(`${transcript.role === "user" ? "you" : "omp"}: ${transcript.text}\n`);
				agent.reportTranscript(transcript.role, transcript.turn, transcript.text, transcript.final);
			},
			onTerminal: error => {
				if (error) write(`Live session ended: ${error.message}\n`);
			},
		},
	});

	const stop = async (): Promise<void> => {
		await controller.stop();
		await agent.close();
		child.kill();
		await pump.catch(() => {});
	};
	options.signal?.addEventListener("abort", () => void stop(), { once: true });

	try {
		await controller.start();
	} catch (cause) {
		await stop();
		if (cause instanceof LiveInputDeviceError) {
			write(`${cause.message}\n`);
			return 1;
		}
		write(`Could not start the live session: ${cause instanceof Error ? cause.message : String(cause)}\n`);
		return 1;
	}

	await pump.catch(() => {});
	await stop();
	return 0;
}

/** `ompx live --attach <target>` */
export default class Live extends Command {
	static description = "Run live voice on this machine against a remote ompx session over SSH";
	static examples = ["ompx live --attach codemc", "ompx live --attach codemc:01JABC --forward-credentials"];
	static flags = {
		attach: Flags.string({ description: "SSH target running ompx, optionally host:sessionId" }),
		session: Flags.string({ description: "Remote session id, or `latest`" }),
		"forward-credentials": Flags.boolean({
			description: "Ask the host to forward a Codex credential when this machine has none",
		}),
		voice: Flags.string({ description: "Realtime output voice (timbre id, e.g. sol)" }),
		language: Flags.string({ description: "Spoken language as a BCP-47 tag (default vi-VN)" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Live);
		const target = typeof flags.attach === "string" ? flags.attach.trim() : "";
		if (!target) {
			process.stdout.write("Usage: ompx live --attach <ssh-target>[:<sessionId>]\n");
			process.exitCode = 1;
			return;
		}
		const abort = new AbortController();
		const onSignal = (): void => abort.abort();
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
		try {
			process.exitCode = await runLiveAttach({
				target,
				session: typeof flags.session === "string" ? flags.session : undefined,
				forwardCredentials: flags["forward-credentials"] === true,
				voice: typeof flags.voice === "string" ? flags.voice : undefined,
				language: typeof flags.language === "string" ? flags.language : undefined,
				signal: abort.signal,
			});
		} finally {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
		}
	}
}
