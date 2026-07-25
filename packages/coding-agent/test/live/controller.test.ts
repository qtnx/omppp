import { describe, expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import {
	LiveSessionController,
	type LiveSessionControllerOptions,
	type LiveTranscript,
} from "../../src/live/controller";
import type { LiveAgentEndpoint, LiveAgentIdentity, LiveMediaEndpoint } from "../../src/live/endpoints";
import { LiveInputDeviceError } from "../../src/live/local-endpoints";
import { buildDelegationContextAppend, type LiveClientMessage, type LiveServerEvent } from "../../src/live/protocol";
import type { LivePhase } from "../../src/live/visualizer";

// Drain the queued microtasks that serialize the controller's send chain (no wall clock).
const flush = async (): Promise<void> => {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

class FakeMedia implements LiveMediaEndpoint {
	readonly calls: string[] = [];
	#outputLevel: ((level: number) => void) | undefined;
	#failure: ((message: string) => void) | undefined;

	async createOffer(): Promise<string> {
		this.calls.push("createOffer");
		return "offer-sdp";
	}
	async acceptAnswer(_sdp: string): Promise<void> {
		this.calls.push("acceptAnswer");
	}
	async waitForOpen(_timeoutMs?: number): Promise<void> {
		this.calls.push("waitForOpen");
	}
	async setMuted(muted: boolean): Promise<void> {
		this.calls.push(`setMuted:${muted}`);
	}
	onOutputLevel(handler: (level: number) => void): void {
		this.#outputLevel = handler;
	}
	onFailure(handler: (message: string) => void): void {
		this.#failure = handler;
	}
	async close(): Promise<void> {
		this.calls.push("close");
	}
	emitOutputLevel(level: number): void {
		this.#outputLevel?.(level);
	}
	emitFailure(message: string): void {
		this.#failure?.(message);
	}
}

class FakeAgent implements LiveAgentEndpoint {
	readonly delegations: Array<{ id: string; request: string }> = [];
	closed = false;
	#context: ((delegationId: string, text: string, kind?: "commentary") => void) | undefined;
	#end: ((delegationId: string) => void) | undefined;

	startDelegation(id: string, request: string): void {
		this.delegations.push({ id, request });
	}
	onContext(handler: (delegationId: string, text: string, kind?: "commentary") => void): void {
		this.#context = handler;
	}
	onDelegationEnd(handler: (delegationId: string) => void): void {
		this.#end = handler;
	}
	async close(): Promise<void> {
		this.closed = true;
	}
	emitContext(delegationId: string, text: string, kind?: "commentary"): void {
		this.#context?.(delegationId, text, kind);
	}
	emitDelegationEnd(delegationId: string): void {
		this.#end?.(delegationId);
	}
}

interface Harness {
	controller: LiveSessionController;
	media: FakeMedia;
	agent: FakeAgent;
	transportCalls: string[];
	sentTypes: string[];
	sent: LiveClientMessage[];
	emit: (event: LiveServerEvent) => void;
	phases: LivePhase[];
	transcripts: Array<LiveTranscript | undefined>;
	terminals: Array<Error | undefined>;
	connectError?: Error;
}

function makeHarness(options?: { connectError?: Error }): Harness {
	const media = new FakeMedia();
	const agent = new FakeAgent();
	const transportCalls: string[] = [];
	const sentTypes: string[] = [];
	const sent: LiveClientMessage[] = [];
	const phases: LivePhase[] = [];
	const transcripts: Array<LiveTranscript | undefined> = [];
	const terminals: Array<Error | undefined> = [];
	let emit: (event: LiveServerEvent) => void = () => {};

	const identity: LiveAgentIdentity = { sessionId: "s1", username: "tester", firstName: "Test", cwd: "/tmp" };
	const controllerOptions: LiveSessionControllerOptions = {
		media,
		agent,
		identity,
		authStorage: {} as AuthStorage,
		callbacks: {
			onPhase: phase => phases.push(phase),
			onTranscript: transcript => transcripts.push(transcript),
			onTerminal: error => terminals.push(error),
		},
		createTransport: transportOptions => {
			emit = event => transportOptions.callbacks.onEvent(event);
			return {
				connect: async () => {
					transportCalls.push("connect");
					if (options?.connectError) throw options.connectError;
				},
				send: async message => {
					transportCalls.push(`send:${message.type}`);
					sentTypes.push(message.type);
					sent.push(message);
				},
				close: async () => {
					transportCalls.push("close");
				},
			};
		},
	};

	return {
		controller: new LiveSessionController(controllerOptions),
		media,
		agent,
		transportCalls,
		sentTypes,
		sent,
		emit: event => emit(event),
		phases,
		transcripts,
		terminals,
	};
}

function delegationEvent(id: string, text: string): LiveServerEvent {
	return {
		type: "delegation.created",
		item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
	};
}

describe("LiveSessionController", () => {
	test("drives a full connect → delegation → context → teardown cycle", async () => {
		const h = makeHarness();
		await h.controller.start();

		expect(h.transportCalls).toContain("connect");
		expect(h.phases[0]).toBe("connecting");
		expect(h.controller.phase).toBe("listening");

		h.emit({ type: "session.started", session: { id: "sess" } });
		h.emit(delegationEvent("d1", "list the files"));
		expect(h.agent.delegations).toEqual([{ id: "d1", request: "list the files" }]);
		expect(h.controller.phase).toBe("working");

		h.agent.emitContext("d1", "working on it", "commentary");
		h.agent.emitContext("d1", "all done");
		await flush();
		expect(h.sent).toContainEqual(buildDelegationContextAppend("d1", "working on it", "commentary"));
		expect(h.sent).toContainEqual(buildDelegationContextAppend("d1", "all done"));

		h.agent.emitDelegationEnd("d1");
		expect(h.controller.phase).toBe("listening");

		await h.controller.stop();
		expect(h.agent.closed).toBe(true);
		expect(h.media.calls).toContain("close");
		expect(h.sentTypes).toContain("session.close");
		// session.close MUST be sent before the transport is closed.
		expect(h.transportCalls.indexOf("send:session.close")).toBeLessThan(h.transportCalls.indexOf("close"));
		expect(h.terminals).toEqual([undefined]);
	});

	test("output level drives the speaking phase when no delegation is active", async () => {
		const h = makeHarness();
		await h.controller.start();
		expect(h.controller.phase).toBe("listening");

		h.media.emitOutputLevel(0.5);
		expect(h.controller.phase).toBe("speaking");

		h.media.emitOutputLevel(0);
		expect(h.controller.phase).toBe("listening");
	});

	test("a media failure emits exactly one terminal callback", async () => {
		const h = makeHarness();
		await h.controller.start();

		h.media.emitFailure("peer exploded");
		await flush();

		expect(h.terminals).toHaveLength(1);
		expect(h.terminals[0]?.message).toBe("peer exploded");
	});

	test("device-failure path surfaces the guidance message and one terminal callback", async () => {
		const guidance = new LiveInputDeviceError(new Error("cpal: no default input device"));
		const h = makeHarness({ connectError: guidance });

		await expect(h.controller.start()).rejects.toBe(guidance);
		await flush();

		expect(h.terminals).toHaveLength(1);
		expect(h.terminals[0]?.message).toContain("ompx live --attach");
		expect(h.media.calls).toContain("close");
	});
});
