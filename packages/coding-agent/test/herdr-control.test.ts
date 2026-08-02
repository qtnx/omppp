import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import PromptCommand from "../src/commands/prompt";
import { listControlSessions, sendControlPrompt } from "../src/herdr/control-client";
import {
	type ControlDeliverMode,
	controlDescriptorPath,
	controlSocketPath,
	HerdrControlServer,
} from "../src/herdr/control-server";

describe("herdr control socket", () => {
	let runDir: string | undefined;
	let server: HerdrControlServer | undefined;

	afterEach(async () => {
		await server?.close();
		server = undefined;
		if (runDir) await fs.rm(runDir, { recursive: true, force: true });
		runDir = undefined;
	});

	async function makeRunDir(): Promise<string> {
		runDir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-control-"));
		return runDir;
	}

	test("delivers multi-line unicode payload byte-exact as one submit call", async () => {
		const dir = await makeRunDir();
		const calls: Array<{ text: string; deliverAs?: ControlDeliverMode }> = [];
		server = new HerdrControlServer({
			sessionId: "sess-1",
			cwd: "/tmp/project",
			paneId: "pane-9",
			submit: (text, options) => {
				calls.push({ text, deliverAs: options.deliverAs });
				return { mode: "steer" };
			},
			isIdle: () => true,
			runDir: dir,
		});
		await server.start();

		const payload =
			"/plan line one\nsecond `line` with $VAR and 'single' \"double\"\nthird π 🚀\n\ntrailing blank above";
		const result = await sendControlPrompt(payload, { sessionId: "sess-1" }, { deliverAs: "steer", runDir: dir });

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mode).toBe("steer");
			expect(result.sessionId).toBe("sess-1");
			expect(result.paneId).toBe("pane-9");
		}
		expect(calls.length).toBe(1);
		expect(calls[0].text).toBe(payload);
		expect(calls[0].deliverAs).toBe("steer");
	});

	test("requireIdle against a busy session returns busy and never submits", async () => {
		const dir = await makeRunDir();
		let submitted = 0;
		server = new HerdrControlServer({
			sessionId: "sess-busy",
			cwd: "/tmp/project",
			submit: () => {
				submitted++;
				return { mode: "turn" };
			},
			isIdle: () => false,
			runDir: dir,
		});
		await server.start();

		const result = await sendControlPrompt("hello", { sessionId: "sess-busy" }, { requireIdle: true, runDir: dir });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("busy");
			expect(result.message).toBe("session is busy");
		}
		expect(submitted).toBe(0);
	});

	test("listControlSessions finds the live session; close() removes socket+descriptor", async () => {
		const dir = await makeRunDir();
		server = new HerdrControlServer({
			sessionId: "sess-list",
			cwd: "/tmp/elsewhere",
			submit: () => ({ mode: "turn" }),
			isIdle: () => true,
			runDir: dir,
		});
		await server.start();

		const live = await listControlSessions(dir);
		expect(live.length).toBe(1);
		expect(live[0].sessionId).toBe("sess-list");
		expect(live[0].pid).toBe(process.pid);
		expect(live[0].cwd).toBe("/tmp/elsewhere");
		expect(live[0].socket).toBe(controlSocketPath("sess-list", dir));

		const socketFile = controlSocketPath("sess-list", dir);
		const descriptorFile = controlDescriptorPath("sess-list", dir);
		await server.close();

		expect(await fs.exists(socketFile)).toBe(false);
		expect(await fs.exists(descriptorFile)).toBe(false);
		expect(await listControlSessions(dir)).toEqual([]);

		const afterClose = await sendControlPrompt("hi", { sessionId: "sess-list" }, { runDir: dir });
		expect(afterClose.ok).toBe(false);
		if (!afterClose.ok) expect(afterClose.code).toBe("no_session");

		const targeted = await sendControlPrompt("hi", { socketPath: socketFile }, { runDir: dir });
		expect(targeted.ok).toBe(false);
		if (!targeted.ok) expect(targeted.code).toBe("gone");
	});
});

describe("ompx prompt command module", () => {
	test("imports and exposes a Command with a description", () => {
		expect(typeof PromptCommand.description).toBe("string");
		expect(PromptCommand.description.length).toBeGreaterThan(0);
	});
});
