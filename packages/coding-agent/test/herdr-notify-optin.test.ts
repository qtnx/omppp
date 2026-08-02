import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	disableHerdrNotify,
	enableHerdrNotify,
	herdrNotifyStatus,
	listNotifyDescriptors,
	notifyDescriptorPath,
	pruneNotifyDescriptor,
	renderSettledNotification,
} from "../src/herdr/notify-optin";

describe("herdr notify opt-in", () => {
	let runDir: string | undefined;

	afterEach(async () => {
		await disableHerdrNotify();
		if (runDir) await fs.rm(runDir, { recursive: true, force: true });
		runDir = undefined;
	});

	async function tempRunDir(): Promise<string> {
		runDir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-notify-optin-"));
		return runDir;
	}

	test("publishes a 0600 descriptor pointing at the session control socket", async () => {
		const dir = await tempRunDir();
		const socketPath = path.join(dir, "session-1.sock");
		await Bun.write(socketPath, "");

		const status = await enableHerdrNotify({
			sessionId: "session-1",
			cwd: "/tmp/project",
			paneId: "w1:p1",
			runDir: dir,
			socketPath,
		});

		expect(status.enabled).toBe(true);
		expect(status.socket).toBe(socketPath);
		expect(herdrNotifyStatus().enabled).toBe(true);

		const descriptorPath = notifyDescriptorPath("session-1", dir);
		const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8")) as Record<string, unknown>;
		expect(descriptor.socket).toBe(socketPath);
		expect(descriptor.sessionId).toBe("session-1");
		expect(descriptor.paneId).toBe("w1:p1");
		expect(descriptor.pid).toBe(process.pid);
		// No secret is published: the unix socket's own mode is the access control.
		expect(descriptor.token).toBeUndefined();
		expect(descriptor.url).toBeUndefined();

		const stat = await fs.stat(descriptorPath);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	test("refuses to enable when the session serves no control socket", async () => {
		const dir = await tempRunDir();
		await expect(
			enableHerdrNotify({
				sessionId: "session-2",
				cwd: "/tmp/project",
				runDir: dir,
				socketPath: path.join(dir, "missing.sock"),
			}),
		).rejects.toThrow(/no control socket/);
		expect(herdrNotifyStatus().enabled).toBe(false);
		expect(await listNotifyDescriptors(dir)).toHaveLength(0);
	});

	test("disable removes the descriptor so the bridge stops seeing the session", async () => {
		const dir = await tempRunDir();
		const socketPath = path.join(dir, "session-3.sock");
		await Bun.write(socketPath, "");
		await enableHerdrNotify({ sessionId: "session-3", cwd: "/tmp/project", runDir: dir, socketPath });
		expect(await listNotifyDescriptors(dir)).toHaveLength(1);

		await disableHerdrNotify();

		expect(herdrNotifyStatus().enabled).toBe(false);
		expect(await listNotifyDescriptors(dir)).toHaveLength(0);
	});

	test("listing skips corrupt descriptors instead of failing the whole round", async () => {
		const dir = await tempRunDir();
		const socketPath = path.join(dir, "good.sock");
		await Bun.write(socketPath, "");
		await enableHerdrNotify({ sessionId: "good", cwd: "/tmp/project", runDir: dir, socketPath });
		await Bun.write(path.join(dir, "broken.json"), "{ not json");
		await Bun.write(path.join(dir, "incomplete.json"), JSON.stringify({ sessionId: "x" }));

		const descriptors = await listNotifyDescriptors(dir);

		expect(descriptors.map(d => d.sessionId)).toEqual(["good"]);
	});

	test("prune removes a named descriptor and tolerates an absent one", async () => {
		const dir = await tempRunDir();
		const socketPath = path.join(dir, "session-4.sock");
		await Bun.write(socketPath, "");
		await enableHerdrNotify({ sessionId: "session-4", cwd: "/tmp/project", runDir: dir, socketPath });

		await pruneNotifyDescriptor("session-4", dir);
		await pruneNotifyDescriptor("never-existed", dir);

		expect(await listNotifyDescriptors(dir)).toHaveLength(0);
	});

	test("rendered notification names the pane, state and how to read the peer", () => {
		const text = renderSettledNotification({
			paneId: "w1:p7",
			agent: "codex",
			name: "reviewer",
			status: "done",
			workedMs: 48_000,
			title: "Review the diff",
		});

		expect(text).toContain("w1:p7");
		expect(text).toContain("codex");
		expect(text).toContain("done");
		expect(text).toContain("Review the diff");
		expect(text).toContain("~48s");
		// A named agent is the better herdr target than its pane id.
		expect(text).toContain("herdr agent read reviewer");
	});

	test("an unnamed agent falls back to the pane id as the read target", () => {
		const text = renderSettledNotification({ paneId: "w1:p9", status: "idle" });

		expect(text).toContain("herdr agent read w1:p9");
		expect(text).not.toContain("named agent");
	});
});
