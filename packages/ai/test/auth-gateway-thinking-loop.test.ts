import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { THINKING_LOOP_ERROR_MARKER } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { logger } from "@oh-my-pi/pi-utils";

/** A degenerate near-duplicate reasoning loop (the gemini-3.5-flash shape). */
function loopThinking(): string {
	const variants = [
		"I am now verifying the test module to guarantee there are no compile errors and the code is completely safe.",
		"I am now verifying the test module once more to ensure there are no compile errors and the code stays completely safe.",
		"I am now re-verifying the test module to confirm there are no compile errors and the code remains completely safe.",
	];
	const out: string[] = [];
	for (let i = 0; i < 12; i++) out.push(`**Confirming Safety ${i}**\n\n${variants[i % variants.length]}`);
	return out.join("\n\n\n");
}

afterEach(() => {
	clearCustomApis();
});

describe("auth-gateway non-streaming thinking-loop cook", () => {
	it("returns 200 with cooked output instead of a 502 when the model loops", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-thinking-loop-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
		// Three guarded attempts stall on the thinking loop; the fourth (cook) pass
		// runs with the guard disabled and returns the visible answer.
		for (let i = 0; i < 4; i++) {
			mock.push({ content: [{ type: "thinking", thinking: loopThinking() }, "Final answer after cooking."] });
		}
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "google/gemini-3.5-flash",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			const body = (await res.json()) as {
				error?: unknown;
				choices?: Array<{ message?: { content?: string | null } }>;
			};

			expect(res.status).toBe(200);
			expect(body.error).toBeUndefined();
			expect(body.choices?.[0]?.message?.content).toContain("Final answer after cooking.");
			// Three guarded stalls + one unguarded cook pass.
			expect(mock.calls).toHaveLength(4);
			expect(mock.calls[0]?.options?.loopGuard?.enabled).toBeUndefined();
			expect(mock.calls[3]?.options?.loopGuard?.enabled).toBe(false);
		} finally {
			waitSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("still surfaces a non-loop upstream error as a 502", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-thinking-loop-err-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
		mock.push({ throw: "upstream exploded" });
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "google/gemini-3.5-flash",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});

			// A genuine error is never a loop stall, so the cook fallback must not mask it.
			expect(res.status).toBe(502);
			expect(mock.calls).toHaveLength(1);
			expect(THINKING_LOOP_ERROR_MARKER.length).toBeGreaterThan(0);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("logs credential origin and auth type without exposing the token", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-credential-log-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const token = "sk-ant-oat-test-token";
		storage.setRuntimeApiKey("anthropic", token);
		const mock = createMockModel({ provider: "anthropic", id: "claude-test" });
		mock.push({ content: ["ok"] });
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "claude-test",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});

			expect(res.status).toBe(200);
			const requestLog = infoSpy.mock.calls.find(([message]) => message === "auth-gateway request");
			expect(requestLog?.[1]).toMatchObject({
				resolvedProvider: "anthropic",
				resolvedModel: "claude-test",
				credentialOrigin: "runtime",
				credentialAuthType: "oauth",
			});
			expect(JSON.stringify(requestLog)).not.toContain(token);
		} finally {
			infoSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("logs credential origin and auth type on pi-native requests", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-credential-log-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const token = "sk-ant-oat-pi-native-test-token";
		storage.setRuntimeApiKey("anthropic", token);
		const mock = createMockModel({ provider: "anthropic", id: "claude-test" });
		mock.push({ content: ["ok"] });
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					modelId: "claude-test",
					context: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
					stream: false,
				}),
			});

			expect(res.status).toBe(200);
			const requestLog = infoSpy.mock.calls.find(([message]) => message === "auth-gateway request");
			expect(requestLog?.[1]).toMatchObject({
				format: "pi-native",
				resolvedProvider: "anthropic",
				resolvedModel: "claude-test",
				credentialOrigin: "runtime",
				credentialAuthType: "oauth",
			});
			expect(JSON.stringify(requestLog)).not.toContain(token);
		} finally {
			infoSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
