import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fanoutHerdrSettled } from "../src/commands/herdr";
import type { NotifyDescriptor } from "../src/herdr/notify-optin";

interface FakeSession {
	socketPath: string;
	requests: Array<Record<string, unknown>>;
	stop(): void;
}

/** Stand in for a live session's control socket: accepts `session.prompt` NDJSON. */
async function fakeSession(socketPath: string): Promise<FakeSession> {
	const requests: Array<Record<string, unknown>> = [];
	const server = Bun.listen<undefined>({
		unix: socketPath,
		socket: {
			open: () => {},
			data: (socket, chunk) => {
				for (const line of chunk.toString().split("\n")) {
					if (!line.trim()) continue;
					const request = JSON.parse(line) as Record<string, unknown>;
					requests.push(request);
					socket.write(
						`${JSON.stringify({ v: 1, id: request.id, result: { accepted: true, mode: "followUp" } })}\n`,
					);
				}
			},
		},
	});
	return { socketPath, requests, stop: () => server.stop(true) };
}

function descriptorFor(overrides: Partial<NotifyDescriptor> & { sessionId: string; socket: string }): NotifyDescriptor {
	return {
		version: 1,
		pid: process.pid,
		cwd: "/tmp/project",
		startedAt: Date.now(),
		...overrides,
	};
}

describe("herdr watch bridge fan-out", () => {
	let runDir: string | undefined;
	const servers: FakeSession[] = [];

	afterEach(async () => {
		for (const server of servers.splice(0)) server.stop();
		if (runDir) await fs.rm(runDir, { recursive: true, force: true });
		runDir = undefined;
	});

	async function setup(): Promise<string> {
		runDir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-watch-bridge-"));
		return runDir;
	}

	test("delivers the notification as a follow-up prompt over the session control socket", async () => {
		const dir = await setup();
		const session = await fakeSession(path.join(dir, "live.sock"));
		servers.push(session);
		await Bun.write(
			path.join(dir, "live.json"),
			`${JSON.stringify(descriptorFor({ sessionId: "live", socket: session.socketPath, paneId: "w1:p1" }))}\n`,
		);

		await fanoutHerdrSettled(
			{ paneId: "w1:p7", workspaceId: "w1", agent: "codex", status: "done", workedMs: 42_000 },
			{ runDir: dir },
		);

		expect(session.requests).toHaveLength(1);
		const request = session.requests[0]!;
		expect(request.method).toBe("session.prompt");
		const params = request.params as Record<string, unknown>;
		// followUp is the whole point: a notification must never interrupt a live turn.
		expect(params.deliverAs).toBe("followUp");
		expect(String(params.text)).toContain("w1:p7");
		expect(String(params.text)).toContain("codex");
	});

	test("never notifies the pane that produced the event", async () => {
		const dir = await setup();
		const session = await fakeSession(path.join(dir, "self.sock"));
		servers.push(session);
		await Bun.write(
			path.join(dir, "self.json"),
			`${JSON.stringify(descriptorFor({ sessionId: "self", socket: session.socketPath, paneId: "w1:p7" }))}\n`,
		);

		await fanoutHerdrSettled({ paneId: "w1:p7", status: "done" }, { runDir: dir });

		expect(session.requests).toHaveLength(0);
	});

	test("prunes a descriptor whose session process is gone", async () => {
		const dir = await setup();
		const deadPath = path.join(dir, "dead.json");
		await Bun.write(
			deadPath,
			// pid 2^22 is above the usual pid_max and is never live in this sandbox.
			`${JSON.stringify(descriptorFor({ sessionId: "dead", socket: path.join(dir, "dead.sock"), pid: 4_194_303 }))}\n`,
		);

		await fanoutHerdrSettled({ paneId: "w1:p7", status: "done" }, { runDir: dir });

		await expect(fs.stat(deadPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("one unreachable session does not stop delivery to the others", async () => {
		const dir = await setup();
		const session = await fakeSession(path.join(dir, "live.sock"));
		servers.push(session);
		await Bun.write(
			path.join(dir, "live.json"),
			`${JSON.stringify(descriptorFor({ sessionId: "live", socket: session.socketPath }))}\n`,
		);
		// Live pid, but the socket path does not exist: transport fails, descriptor stays.
		const brokenPath = path.join(dir, "broken.json");
		await Bun.write(
			brokenPath,
			`${JSON.stringify(descriptorFor({ sessionId: "broken", socket: path.join(dir, "missing.sock") }))}\n`,
		);

		await fanoutHerdrSettled({ paneId: "w1:p7", status: "idle" }, { runDir: dir });

		expect(session.requests).toHaveLength(1);
		expect(await fs.stat(brokenPath)).toBeDefined();
	});
});
