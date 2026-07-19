#!/usr/bin/env bun
/**
 * Test fixture: well-behaved stdio MCP server for sleepAll/wake tests.
 *
 * Supports initialize + tools/list + tools/call so a real MCPTool.execute can
 * complete end-to-end. When `$OMP_TEST_SPAWN_LOG` is set, each process start
 * appends one line so the test can assert spawn counts (initial + lazy wake).
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

export const TOOL_NAME = "ping";

const spawnLog = Bun.env.OMP_TEST_SPAWN_LOG;
if (spawnLog) {
	fs.appendFileSync(spawnLog, `${process.pid} ${Date.now()}\n`);
}

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

function buildResult(method: string, params?: Record<string, unknown>): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "sleep-wake-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: TOOL_NAME,
						description: "Fixture ping tool for sleep/wake reconnect tests.",
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			};
		case "tools/call": {
			const name = typeof params?.name === "string" ? params.name : "";
			if (name !== TOOL_NAME) {
				return {
					isError: true,
					content: [{ type: "text", text: `Unknown tool: ${name}` }],
				};
			}
			return {
				content: [{ type: "text", text: "pong" }],
			};
		}
		default:
			return {};
	}
}

function startServer(): void {
	const delayIndex = process.argv.indexOf("--delay");
	const initializeDelayMs = delayIndex >= 0 ? Number(process.argv[delayIndex + 1]) || 0 : 0;
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		void (async () => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			let msg: JsonRpcRequest;
			try {
				msg = JSON.parse(trimmed) as JsonRpcRequest;
			} catch {
				return;
			}
			if (msg.id === undefined || msg.id === null) return;
			if (msg.method === "initialize" && initializeDelayMs > 0) {
				await Bun.sleep(initializeDelayMs);
			}
			const response = {
				jsonrpc: "2.0" as const,
				id: msg.id,
				result: buildResult(msg.method, msg.params),
			};
			process.stdout.write(`${JSON.stringify(response)}\n`);
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
