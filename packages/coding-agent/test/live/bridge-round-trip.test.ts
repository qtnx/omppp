import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BridgeAgentEndpoint } from "../../src/live/bridge-agent-endpoint";
import { LiveBridgeServer } from "../../src/live/bridge-server";
import type { LiveAgentEndpoint, LiveAgentIdentity } from "../../src/live/endpoints";

const IDENTITY: LiveAgentIdentity = {
	sessionId: "sess-round-trip",
	username: "remoteuser",
	firstName: "Remote",
	cwd: "/srv/project",
};

/** Stand-in for `LocalAgentEndpoint`: records delegations and replays scripted output. */
class FakeAgentEndpoint implements LiveAgentEndpoint {
	readonly delegations: Array<{ id: string; request: string }> = [];
	readonly received = Promise.withResolvers<{ id: string; request: string }>();
	#context: ((delegationId: string, text: string, kind?: "commentary") => void) | undefined;
	#end: ((delegationId: string) => void) | undefined;

	onContext(handler: (delegationId: string, text: string, kind?: "commentary") => void): void {
		this.#context = handler;
	}

	onDelegationEnd(handler: (delegationId: string) => void): void {
		this.#end = handler;
	}

	startDelegation(id: string, request: string): void {
		this.delegations.push({ id, request });
		this.received.resolve({ id, request });
	}

	emitContext(id: string, text: string, kind?: "commentary"): void {
		this.#context?.(id, text, kind);
	}

	emitEnd(id: string): void {
		this.#end?.(id);
	}

	async close(): Promise<void> {}
}

interface Wired {
	client: BridgeAgentEndpoint;
	agent: FakeAgentEndpoint;
	/** Resolves with the first host-reported error, if one arrives. */
	error: Promise<string>;
	/** Resolves with the first forwarded credential, if one arrives. */
	credential: Promise<{ accessToken: string; accountId?: string; expiresAt: number }>;
	dispose: () => Promise<void>;
}

const wired: Wired[] = [];

async function connectBridge(options: { forwardCredential?: boolean } = {}): Promise<Wired> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-live-bridge-"));
	const agent = new FakeAgentEndpoint();
	const server = new LiveBridgeServer({
		agent,
		identity: IDENTITY,
		title: "round trip",
		socketPath: path.join(dir, "session.sock"),
		resolveCredential: options.forwardCredential
			? async () => ({ accessToken: "tok-abc", accountId: "acct-1", expiresAt: 4_102_444_800_000 })
			: undefined,
	});
	const socketPath = await server.start();

	const error = Promise.withResolvers<string>();
	const credential = Promise.withResolvers<{ accessToken: string; accountId?: string; expiresAt: number }>();
	let client!: BridgeAgentEndpoint;
	const socket = await Bun.connect<undefined>({
		unix: socketPath,
		socket: {
			data: (_sock, chunk) => client.push(chunk),
			error: (_sock, cause) => client.fail(cause.message),
		},
	});
	client = new BridgeAgentEndpoint({
		writer: { write: text => socket.write(text), end: () => socket.end() },
		onError: message => error.resolve(message),
		onCredential: grant => credential.resolve(grant),
	});

	const entry: Wired = {
		client,
		agent,
		error: error.promise,
		credential: credential.promise,
		dispose: async () => {
			socket.end();
			await server.stop();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
	wired.push(entry);
	return entry;
}

afterEach(async () => {
	for (const entry of wired.splice(0)) await entry.dispose().catch(() => {});
});

describe("live bridge round trip", () => {
	it("reports the remote host's identity so the client stops describing itself", async () => {
		const { client } = await connectBridge();

		const welcome = await client.waitForWelcome();

		expect(welcome).toMatchObject({
			sessionId: IDENTITY.sessionId,
			username: "remoteuser",
			firstName: "Remote",
			cwd: "/srv/project",
		});
	});

	it("carries a delegation to the remote agent and streams its context back", async () => {
		const { client, agent } = await connectBridge();
		await client.waitForWelcome();

		const chunks: Array<{ id: string; text: string; kind?: string }> = [];
		const ended = Promise.withResolvers<string>();
		client.onContext((id, text, kind) => chunks.push({ id, text, kind }));
		client.onDelegationEnd(id => ended.resolve(id));

		client.startDelegation("del-1", "list the files in this repo");
		await expect(agent.received.promise).resolves.toEqual({
			id: "del-1",
			request: "list the files in this repo",
		});

		agent.emitContext("del-1", "looking around", "commentary");
		agent.emitContext("del-1", "there are 12 files");
		agent.emitEnd("del-1");

		await expect(ended.promise).resolves.toBe("del-1");
		expect(chunks).toEqual([
			{ id: "del-1", text: "looking around", kind: "commentary" },
			{ id: "del-1", text: "there are 12 files", kind: undefined },
		]);
	});

	it("forwards a credential only when the host opted in", async () => {
		const granting = await connectBridge({ forwardCredential: true });
		await granting.client.waitForWelcome();
		granting.client.requestCredential();
		await expect(granting.credential).resolves.toMatchObject({ accessToken: "tok-abc", accountId: "acct-1" });

		const refusing = await connectBridge({ forwardCredential: false });
		await refusing.client.waitForWelcome();
		refusing.client.requestCredential();
		await expect(refusing.error).resolves.toContain("does not forward credentials");
	});
});
