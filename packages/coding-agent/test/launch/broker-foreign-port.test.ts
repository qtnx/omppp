import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

describe("daemon broker port readiness", () => {
	// Regression: a foreign listener already bound to `ready.port` satisfied the
	// port probe, so a daemon whose own bind failed (EADDRINUSE) was reported
	// ready and the agent claimed the foreign server as its own.
	it("refuses to start when ready.port is already served by another process", async () => {
		using tempDir = TempDir.createSync("@omp-launch-foreign-port-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const foreign = net.createServer(socket => socket.end());
		await new Promise<void>(resolve => foreign.listen(0, "127.0.0.1", resolve));
		const address = foreign.address();
		if (!address || typeof address === "string") throw new Error("foreign listener has no port");
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(scriptPath, `process.stdin.resume();\n`);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			let failure: unknown;
			try {
				await client.request({
					op: "start",
					spec: {
						name: "foreign-port",
						application: process.execPath,
						args: [scriptPath],
						env: {},
						cwd: projectDir,
						pty: false,
						ready: { port: address.port, timeoutMs: 5_000 },
						restart: "no",
						persist: false,
						detached: false,
					},
				});
			} catch (error) {
				failure = error;
			}
			expect(String(failure)).toMatch(/already accepting connections from another process/);
			const listed = await client.request({ op: "list" });
			if (listed.op !== "list") throw new Error("unexpected list result");
			expect(listed.daemons.some(daemon => daemon.name === "foreign-port")).toBeFalse();
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			await new Promise<void>(resolve => foreign.close(() => resolve()));
			setProcessName(previousTitle);
		}
	}, 20_000);
});
