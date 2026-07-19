/**
 * MCPManager.sleepAll() — idle low-memory sleep/wake contract.
 *
 * sleepAll closes live transports without clearing configs or registered tools.
 * The next tool call must revive the server through the existing reconnect path
 * (or the sanctioned asleep-names fallback), spawning the stdio server again.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { TOOL_NAME } from "../fixtures/sleep-wake-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "..", "fixtures", "sleep-wake-mcp.ts");
const BUN_EXEC = process.execPath;

function countSpawns(spawnLog: string): number {
	const text = fs.readFileSync(spawnLog, "utf8");
	return text.split("\n").filter(line => line.trim().length > 0).length;
}

function waitForServerTools(manager: MCPManager, serverName: string): Promise<void> {
	const toolPrefix = `mcp__${serverName}_`;
	if (manager.getTools().some(tool => tool.name.startsWith(toolPrefix))) return Promise.resolve();

	const { promise, resolve } = Promise.withResolvers<void>();
	manager.setOnToolsChanged(tools => {
		if (!tools.some(tool => tool.name.startsWith(toolPrefix))) return;
		manager.setOnToolsChanged(() => {});
		resolve();
	});
	return promise;
}

describe("MCPManager.sleepAll", () => {
	let workDir: string;
	let spawnLog: string;
	let manager: MCPManager;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-sleep-"));
		spawnLog = path.join(workDir, "spawns.log");
		fs.writeFileSync(spawnLog, "");
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	function stdioConfig(options?: { delayMs?: number }): MCPStdioServerConfig {
		const args = options?.delayMs !== undefined ? [FIXTURE_PATH, "--delay", String(options.delayMs)] : [FIXTURE_PATH];
		return {
			type: "stdio",
			command: BUN_EXEC,
			args,
			env: { OMP_TEST_SPAWN_LOG: spawnLog },
		};
	}

	it("closes transports, keeps tools/config, and reports sleeping", async () => {
		const toolsReady = waitForServerTools(manager, "sleeper");
		const config = stdioConfig();
		const result = await manager.connectServers({ sleeper: config }, {});
		await toolsReady;
		expect(result.errors.has("sleeper")).toBe(false);
		expect(manager.getConnectionStatus("sleeper")).toBe("connected");
		expect(countSpawns(spawnLog)).toBe(1);

		const toolsBefore = manager.getTools().filter(t => t.name.startsWith("mcp__sleeper_"));
		expect(toolsBefore.length).toBeGreaterThan(0);

		await manager.sleepAll();

		expect(manager.getConnectionStatus("sleeper")).toBe("disconnected");
		expect(manager.sleeping).toBe(true);
		expect(manager.getConnection("sleeper")).toBeUndefined();
		expect(manager.getServerConfig("sleeper")).toBeDefined();

		const toolsAfter = manager.getTools().filter(t => t.name.startsWith("mcp__sleeper_"));
		expect(toolsAfter.map(t => t.name).sort()).toEqual(toolsBefore.map(t => t.name).sort());

		// Deliberate sleep must not arm crash-storm reconnects (onClose detached).
		await Bun.sleep(200);
		expect(countSpawns(spawnLog)).toBe(1);
	}, 20_000);

	it("wakes on tool execute with exactly one respawn and no crash-storm", async () => {
		const toolsReady = waitForServerTools(manager, "sleeper");
		const config = stdioConfig();
		const result = await manager.connectServers({ sleeper: config }, {});
		expect(result.errors.has("sleeper")).toBe(false);
		expect(countSpawns(spawnLog)).toBe(1);
		await toolsReady;

		const tool = manager.getTools().find(t => t.name === `mcp__sleeper_${TOOL_NAME}`);
		expect(tool).toBeDefined();

		await manager.sleepAll();
		expect(manager.sleeping).toBe(true);
		expect(manager.getConnectionStatus("sleeper")).toBe("disconnected");

		// No auto-reconnect from the deliberate close.
		await Bun.sleep(200);
		expect(countSpawns(spawnLog)).toBe(1);

		const executeResult = await tool!.execute("call-wake-1", {}, () => {}, {} as never);
		expect(executeResult.details?.isError).toBeFalsy();
		expect(executeResult.content[0]).toEqual({ type: "text", text: "pong" });

		expect(countSpawns(spawnLog)).toBe(2);
		expect(manager.getConnectionStatus("sleeper")).toBe("connected");
		expect(manager.sleeping).toBe(false);

		// Still no storm after successful wake.
		await Bun.sleep(200);
		expect(countSpawns(spawnLog)).toBe(2);
	}, 30_000);

	it("settles a pending connection, closes it, and is idempotent", async () => {
		const config = stdioConfig({ delayMs: 400 });
		const connectPromise = manager.connectServers({ slow: config }, {});

		// sleep while initialize is still delayed
		await Bun.sleep(50);
		expect(manager.getConnectionStatus("slow")).toBe("connecting");

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await manager.sleepAll();
			const connectResult = await connectPromise;
			// Connection may have completed then been closed, or failed mid-way —
			// either way sleep must not leave a live transport or reject unhandled.
			expect(manager.getConnectionStatus("slow")).toBe("disconnected");
			expect(manager.getConnection("slow")).toBeUndefined();
			// Config preserved when connect registered the server before sleep closed it.
			if (!connectResult.errors.has("slow")) {
				expect(manager.getServerConfig("slow")).toBeDefined();
				expect(manager.sleeping).toBe(true);
			}

			// Second sleep is a no-op (no live connections).
			await manager.sleepAll();
			expect(manager.getConnectionStatus("slow")).toBe("disconnected");

			await Bun.sleep(50);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	}, 20_000);

	it("re-resolves OAuth auth config on reconnect without interactive OAuth", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();
		const credentialId = "mcp_oauth_sleep_wake";
		const tokenUrl = "https://example.com/oauth/token";
		await authStorage.set(credentialId, {
			type: "oauth",
			access: "stale-access",
			refresh: "stale-refresh",
			expires: Date.now() - 60_000,
		});
		manager.setAuthStorage(authStorage);

		const refreshSpy = vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});

		const config: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			env: { OMP_TEST_SPAWN_LOG: spawnLog },
			auth: {
				type: "oauth",
				credentialId,
				tokenUrl,
			},
		};

		try {
			const result = await manager.connectServers({ oauth_sleeper: config }, {});
			expect(result.errors.has("oauth_sleeper")).toBe(false);
			expect(refreshSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
			const callsAfterConnect = refreshSpy.mock.calls.length;

			await manager.sleepAll();
			expect(manager.sleeping).toBe(true);

			// Expire the credential again so reconnect's #resolveAuthConfig must
			// re-enter the refresh seam (fresh tokens from connect would skip it).
			await authStorage.set(credentialId, {
				type: "oauth",
				access: "mid-sleep-stale",
				refresh: "stale-refresh-2",
				expires: Date.now() - 60_000,
			});

			const reconnected = await manager.reconnectServer("oauth_sleeper");
			expect(reconnected).not.toBeNull();
			expect(refreshSpy.mock.calls.length).toBeGreaterThan(callsAfterConnect);
			// No interactive OAuth — only token refresh via the existing seam.
			expect(refreshSpy).toHaveBeenCalledWith(
				tokenUrl,
				"stale-refresh-2",
				undefined,
				undefined,
				undefined,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
		} finally {
			authStorage.close();
		}
	}, 30_000);
});
