import { afterEach, describe, expect, it, vi } from "bun:test";
import type { DaemonBrokerClient } from "../../launch/client";
import * as daemonClient from "../../launch/client";
import type { DaemonRpcResult } from "../../launch/protocol";
import type { ToolSession } from "..";
import { executeLaunch } from "./launch";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("launch broker protocol compatibility", () => {
	it("replays raw terminal text returned by an already-running legacy broker", async () => {
		const projectDir = process.cwd();
		const legacyResult = {
			op: "logs",
			name: "web",
			text: "ready",
			terminalText: "old\r\x1b[2K\x1b[1;32mready\x1b[0m",
			cursor: 42,
			timedOut: false,
			state: "running",
		} as unknown as DaemonRpcResult;
		const client = {
			projectDir,
			request: async () => legacyResult,
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const result = await executeLaunch({ cwd: projectDir } as ToolSession, {
			op: "logs",
			name: "web",
			lines: 10,
			head: false,
		});

		expect(result.details?.terminalRows).toEqual(["\x1b[0m\x1b[1;38;5;2mready"]);
	});
});
