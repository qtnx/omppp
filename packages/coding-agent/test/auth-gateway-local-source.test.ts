import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type FetchSnapshotOptions,
	type FetchSnapshotResult,
	type SnapshotResponse,
} from "@oh-my-pi/pi-ai/auth-broker";
import type { AuthGatewayBootOptions, AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway";
import * as authGatewayServer from "@oh-my-pi/pi-ai/auth-gateway";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import * as authGatewayCli from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
import { runAuthGatewayCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
import AuthGateway from "@oh-my-pi/pi-coding-agent/commands/auth-gateway";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as theme from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getAgentDbPath, getAgentDir, getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import * as loggerModule from "@oh-my-pi/pi-utils/logger";

const ENV_KEYS = ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const;
const BROKER_URL = "http://127.0.0.1:48765";
const BROKER_TOKEN = "test-broker-token";
const TEST_CONFIG: CliConfig = { bin: "ompx", version: "0.0.0-test", commands: new Map() };

const originalAgentDir = getAgentDir();
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let agentDir = "";
let capturedStdout = "";
let originalStdoutWrite: typeof process.stdout.write;
let originalExitCode: typeof process.exitCode;

function makeSnapshot(provider: string, key: string): SnapshotResponse {
	return {
		generation: 1,
		generatedAt: 1,
		serverNowMs: 1,
		refresher: {
			enabled: false,
			intervalMs: 60_000,
			skewMs: 300_000,
			nextSweepInMs: Number.MAX_SAFE_INTEGER,
		},
		credentials: [
			{
				id: 101,
				provider,
				credential: { type: "api_key", key },
				identityKey: null,
				rotatesInMs: null,
			},
		],
	};
}

async function seedLocalCredential(provider: string, key: string): Promise<void> {
	const storage = await AuthStorage.create(getAgentDbPath());
	try {
		storage.upsertCredential(provider, { type: "api_key", key });
	} finally {
		storage.close();
	}
}

async function seedLocalProviderApiKey(provider: string, key: string): Promise<void> {
	await fs.writeFile(path.join(agentDir, "models.yml"), `providers:\n  ${provider}:\n    apiKey: ${key}\n`);
}

async function seedLocalProviderAuthHeader(provider: string, key: string): Promise<void> {
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  ${provider}:\n    apiKey: ${key}\n    authHeader: true\n`,
	);
}

async function seedLocalAuthGatewayModelAliases(modelAliases: Record<string, string>): Promise<void> {
	const yaml = [
		"providers:",
		"  anthropic:",
		"    apiKey: local-config-anthropic-key",
		"authGateway:",
		"  modelAliases:",
		...Object.entries(modelAliases).map(([alias, target]) => `    "${alias}": "${target}"`),
		"",
	].join("\n");
	await fs.writeFile(path.join(agentDir, "models.yml"), yaml);
}

async function seedOpenAIAuthGatewayModelAliases(modelAliases: Record<string, string>): Promise<void> {
	const yaml = [
		"providers:",
		"  openai:",
		"    apiKey: local-config-openai-key",
		"authGateway:",
		"  modelAliases:",
		...Object.entries(modelAliases).map(([alias, target]) => `    "${alias}": "${target}"`),
		"",
	].join("\n");
	await fs.writeFile(path.join(agentDir, "models.yml"), yaml);
}

function routeModelsConfigToTestAgentDir(): void {
	// The shared config-file singleton is created before beforeEach sets agentDir;
	// route this test's ModelRegistry load to the isolated local models.yml.
	const originalRelocate = ModelsConfigFile.relocate.bind(ModelsConfigFile);
	spyOn(ModelsConfigFile, "relocate").mockImplementation((modelsPath?: string) =>
		originalRelocate(modelsPath ?? path.join(agentDir, "models.yml")),
	);
}

function captureStdout(): void {
	originalStdoutWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
	capturedStdout = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		capturedStdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
}

function restoreStdout(): void {
	if (originalStdoutWrite) process.stdout.write = originalStdoutWrite;
}

function stubGatewayServerForModule(serverModule: typeof authGatewayServer, captured: AuthGatewayBootOptions[]): void {
	let stopWithSigterm: (() => void) | undefined;
	spyOn(process, "once").mockImplementation(((eventName: string | symbol, listener: (...args: unknown[]) => void) => {
		if (eventName === "SIGTERM") {
			stopWithSigterm = () => {
				listener("SIGTERM");
			};
		}
		return process;
	}) as typeof process.once);
	spyOn(process, "off").mockImplementation((() => process) as typeof process.off);
	spyOn(serverModule, "startAuthGateway").mockImplementation(
		(opts: AuthGatewayBootOptions): AuthGatewayServerHandle => {
			captured.push(opts);
			let shutdownScheduled = false;
			return {
				get url() {
					if (!shutdownScheduled) {
						shutdownScheduled = true;
						queueMicrotask(() => {
							stopWithSigterm?.();
						});
					}
					return "http://127.0.0.1:49000";
				},
				port: 49_000,
				hostname: "127.0.0.1",
				close: async () => {},
			};
		},
	);
}

function stubGatewayServer(captured: AuthGatewayBootOptions[]): void {
	stubGatewayServerForModule(authGatewayServer, captured);
}

function stubBrokerSnapshotForClient(BrokerClient: typeof AuthBrokerClient, snapshot: SnapshotResponse): void {
	spyOn(BrokerClient.prototype, "fetchSnapshot").mockImplementation(
		async (opts: FetchSnapshotOptions = {}): Promise<FetchSnapshotResult> => {
			if (opts.ifGenerationGt !== undefined) return { status: 304, generation: snapshot.generation };
			return { status: 200, snapshot, generation: snapshot.generation };
		},
	);
	spyOn(BrokerClient.prototype, "openSnapshotStream").mockImplementation(async function* (opts = {}) {
		const done = Promise.withResolvers<void>();
		if (opts.signal?.aborted) {
			done.resolve();
		} else {
			opts.signal?.addEventListener("abort", () => done.resolve(), { once: true });
		}
		await done.promise;
	});
}

function stubBrokerSnapshot(snapshot: SnapshotResponse): void {
	stubBrokerSnapshotForClient(AuthBrokerClient, snapshot);
}

function stubBrokerSnapshotFailure(message: string): void {
	spyOn(AuthBrokerClient.prototype, "fetchSnapshot").mockRejectedValue(new Error(message));
}

function configuredBrokerEnv(): void {
	process.env.OMP_AUTH_BROKER_URL = BROKER_URL;
	process.env.OMP_AUTH_BROKER_TOKEN = BROKER_TOKEN;
}

function modelProviders(opts: AuthGatewayBootOptions): Set<string> {
	return new Set(Array.from(opts.listModels?.() ?? []).map(model => model.provider));
}

function exposedModelIds(opts: AuthGatewayBootOptions): Set<string> {
	return new Set(Array.from(opts.listModels?.() ?? []).flatMap(model => [model.id, `${model.provider}/${model.id}`]));
}

function stubCredentialHealthFromStorage(): void {
	spyOn(AuthStorage.prototype, "checkCredentials").mockImplementation(async function (this: AuthStorage) {
		return this.exportSnapshot().credentials.map(credential => ({
			id: credential.id,
			provider: credential.provider,
			type: credential.credential.type,
			ok: true,
		}));
	});
}

beforeEach(async () => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	originalExitCode = process.exitCode;
	await fs.mkdir(os.tmpdir(), { recursive: true });
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-auth-gateway-local-"));
	setAgentDir(agentDir);
	for (const key of ENV_KEYS) delete process.env[key];
	captureStdout();
	resetSettingsForTest();
});

afterEach(async () => {
	restoreStdout();
	vi.restoreAllMocks();
	resetSettingsForTest();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	process.exitCode = originalExitCode ?? 0;
	setAgentDir(originalAgentDir);
	if (agentDir) await removeWithRetries(agentDir);
});

describe("auth-gateway modelAliases config", () => {
	it("exposes a configured alias that resolves to the target model", async () => {
		await seedLocalAuthGatewayModelAliases({ "tnx/super": "anthropic/claude-sonnet-4-5" });
		routeModelsConfigToTestAgentDir();
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { bind: "127.0.0.1:0", noAuth: true } }),
		).resolves.toBeUndefined();

		expect(starts).toHaveLength(1);
		expect(exposedModelIds(starts[0])).toContain("tnx/super");
		const aliasModel = starts[0].resolveModel("tnx/super");
		expect(aliasModel?.provider).toBe("anthropic");
		expect(aliasModel?.id).toBe("claude-sonnet-4-5");
	});

	it("resolves a configured provider-prefixed alias by its short model id", async () => {
		await seedLocalAuthGatewayModelAliases({ "tnx/super": "anthropic/claude-opus-4-8" });
		routeModelsConfigToTestAgentDir();
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { bind: "127.0.0.1:0", noAuth: true } }),
		).resolves.toBeUndefined();

		expect(starts).toHaveLength(1);
		const aliasModel = starts[0].resolveModel("super");
		expect(aliasModel?.provider).toBe("anthropic");
		expect(aliasModel?.id).toBe("claude-opus-4-8");
	});

	it("rejects a provider-prefixed alias whose short id collides with an existing model", async () => {
		await seedLocalAuthGatewayModelAliases({ "tnx/claude-opus-4-8": "anthropic/claude-sonnet-4-5" });
		routeModelsConfigToTestAgentDir();
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { bind: "127.0.0.1:0", noAuth: true } }),
		).rejects.toThrow(/auth-gateway model alias "tnx\/claude-opus-4-8".*short.*claude-opus-4-8|ambiguous|collision/i);
		expect(starts).toHaveLength(0);
	});

	it("rejects aliases whose target model is not available", async () => {
		await seedLocalAuthGatewayModelAliases({ "tnx/missing-target": "anthropic/not-a-real-model" });
		routeModelsConfigToTestAgentDir();
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { bind: "127.0.0.1:0", noAuth: true } }),
		).rejects.toThrow(/auth-gateway model alias "tnx\/missing-target".*target "anthropic\/not-a-real-model"/i);
		expect(starts).toHaveLength(0);
	});

	it("rejects an image-capable alias key targeting a text-only model", async () => {
		await seedOpenAIAuthGatewayModelAliases({ "tnx/designer": "openai/gpt-4" });
		routeModelsConfigToTestAgentDir();
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { bind: "127.0.0.1:0", noAuth: true } }),
		).rejects.toThrow(/auth-gateway model alias "tnx\/designer".*target "openai\/gpt-4".*image/i);
		expect(starts).toHaveLength(0);
	});
});

describe("auth-gateway serve credential source selection", () => {
	it("uses the local auth store when no broker is configured", async () => {
		await seedLocalCredential("anthropic", "local-anthropic-key");
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		try {
			await runAuthGatewayCommand({ action: "serve", flags: { bind: "127.0.0.1:0", noAuth: true } });
		} catch (error) {
			throw new Error(
				`serve should start from local auth storage when no broker is configured; rejected with: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		expect(starts).toHaveLength(1);
		expect(modelProviders(starts[0])).toContain("anthropic");
		expect(starts[0].storage.describeCredentialSource("anthropic")).toContain(`local ${getAgentDbPath()}`);
		expect(capturedStdout).toContain("auth-gateway listening on http://127.0.0.1:49000");
	});

	it("enables console request logs while preserving rotating file logs in verbose foreground mode", async () => {
		await seedLocalCredential("anthropic", "local-anthropic-key");
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);
		const transportSpy = spyOn(loggerModule, "setTransports").mockImplementation(() => undefined);

		await expect(
			runAuthGatewayCommand({
				action: "serve",
				flags: { bind: "127.0.0.1:0", noAuth: true, verbose: true },
			}),
		).resolves.toBeUndefined();

		expect(starts).toHaveLength(1);
		expect(transportSpy).toHaveBeenCalledWith({ console: true, file: true });
	});

	it("keeps broker-backed credentials as the default when a broker is configured", async () => {
		await seedLocalCredential("anthropic", "local-anthropic-key");
		configuredBrokerEnv();
		stubBrokerSnapshot(makeSnapshot("openai", "broker-openai-key"));
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { bind: "127.0.0.1:0", noAuth: true } }),
		).resolves.toBeUndefined();

		expect(starts).toHaveLength(1);
		expect(modelProviders(starts[0])).toContain("openai");
		expect(modelProviders(starts[0])).not.toContain("anthropic");
		expect(starts[0].storage.describeCredentialSource("openai")).toContain(`broker ${BROKER_URL}`);
	});

	it("ignores local models.yml provider apiKeys when serving broker snapshot credentials by default", async () => {
		await seedLocalProviderApiKey("anthropic", "local-config-anthropic-key");
		configuredBrokerEnv();
		routeModelsConfigToTestAgentDir();
		stubBrokerSnapshot(makeSnapshot("openai", "broker-openai-key"));
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { bind: "127.0.0.1:0", noAuth: true } }),
		).resolves.toBeUndefined();

		expect(starts).toHaveLength(1);
		const providers = modelProviders(starts[0]);
		expect(providers).toContain("openai");
		expect(providers).not.toContain("anthropic");
		expect(starts[0].storage.describeCredentialSource("openai")).toContain(`broker ${BROKER_URL}`);
		expect(starts[0].storage.getCredentialOrigin("anthropic")).toBeUndefined();
	});

	it("ignores local disabled-provider settings when serving broker snapshot credentials", async () => {
		await Settings.init({ inMemory: true, overrides: { disabledProviders: ["openai"] } });
		configuredBrokerEnv();
		stubBrokerSnapshot(makeSnapshot("openai", "broker-openai-key"));
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { bind: "127.0.0.1:0", noAuth: true } }),
		).resolves.toBeUndefined();

		expect(starts).toHaveLength(1);
		expect(modelProviders(starts[0])).toContain("openai");
	});

	it("ignores local disabled-provider settings for broker implicit discovery models", async () => {
		await Settings.init({ inMemory: true, overrides: { disabledProviders: ["ollama"] } });
		configuredBrokerEnv();
		writeModelCache(
			"ollama",
			Date.now(),
			[
				buildModel({
					id: "ompx-test-ollama-broker-cache",
					name: "OMPx Test Ollama Broker Cache",
					provider: "ollama",
					api: "openai-responses",
					baseUrl: "http://127.0.0.1:11434/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				}),
			],
			true,
			"",
		);
		stubBrokerSnapshot(makeSnapshot("ollama", "broker-ollama-key"));
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { bind: "127.0.0.1:0", noAuth: true } }),
		).resolves.toBeUndefined();

		expect(starts).toHaveLength(1);
		expect(Array.from(starts[0].listModels?.() ?? []).map(model => model.id)).toContain(
			"ompx-test-ollama-broker-cache",
		);
	});

	it("does not apply same-provider local config auth headers to broker-served models", async () => {
		await seedLocalProviderAuthHeader("openai", "local-config-openai-key");
		configuredBrokerEnv();
		routeModelsConfigToTestAgentDir();
		stubBrokerSnapshot(makeSnapshot("openai", "broker-openai-key"));
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		await expect(
			runAuthGatewayCommand({ action: "serve", flags: { bind: "127.0.0.1:0", noAuth: true } }),
		).resolves.toBeUndefined();

		expect(starts).toHaveLength(1);
		const openaiModel = Array.from(starts[0].listModels?.() ?? []).find(model => model.provider === "openai");
		expect(openaiModel).toBeDefined();
		expect(openaiModel?.headers?.Authorization).not.toBe("Bearer local-config-openai-key");
		expect(starts[0].storage.getCredentialOrigin("openai")).toEqual({ kind: "api_key" });
	});

	it("--local bypasses configured broker credentials and serves the local auth store", async () => {
		await seedLocalCredential("anthropic", "local-anthropic-key");
		configuredBrokerEnv();
		stubBrokerSnapshot(makeSnapshot("openai", "broker-openai-key"));
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);

		await expect(
			runAuthGatewayCommand({
				action: "serve",
				flags: { bind: "127.0.0.1:0", noAuth: true, local: true },
			}),
		).resolves.toBeUndefined();

		expect(starts).toHaveLength(1);
		expect(modelProviders(starts[0])).toContain("anthropic");
		expect(modelProviders(starts[0])).not.toContain("openai");
		expect(starts[0].storage.describeCredentialSource("anthropic")).toContain(`local ${getAgentDbPath()}`);
	});
});

describe("auth-gateway check credential source selection", () => {
	it("checks the local auth store when no broker is configured", async () => {
		await seedLocalCredential("anthropic", "local-anthropic-key");
		stubCredentialHealthFromStorage();

		try {
			await runAuthGatewayCommand({ action: "check", flags: { json: true } });
		} catch (error) {
			throw new Error(
				`check should inspect local auth storage when no broker is configured; rejected with: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		const output = JSON.parse(capturedStdout) as Record<string, unknown>;
		expect(output.source).toBe("local");
		expect(output.credentialSource).toContain(`local ${getAgentDbPath()}`);
		expect(output.broker).toBeNull();
		expect(output.credentials).toEqual([
			expect.objectContaining({
				provider: "anthropic",
				type: "api_key",
				ok: true,
			}),
		]);
	});

	it("--local checks local credentials instead of a configured broker snapshot", async () => {
		await seedLocalCredential("anthropic", "local-anthropic-key");
		configuredBrokerEnv();
		stubBrokerSnapshot(makeSnapshot("openai", "broker-openai-key"));
		stubCredentialHealthFromStorage();

		await expect(
			runAuthGatewayCommand({
				action: "check",
				flags: { json: true, local: true },
			}),
		).resolves.toBeUndefined();

		const output = JSON.parse(capturedStdout) as Record<string, unknown>;
		expect(output.source).toBe("local");
		expect(output.credentialSource).toContain(`local ${getAgentDbPath()}`);
		expect(output.broker).toBeNull();
		expect(output.credentials).toEqual([
			expect.objectContaining({
				provider: "anthropic",
				type: "api_key",
				ok: true,
			}),
		]);
		expect(output.credentials).not.toEqual([
			expect.objectContaining({
				provider: "openai",
			}),
		]);
	});
	it("--local reports local models.yml api keys as selected-source credentials", async () => {
		await seedLocalProviderApiKey("anthropic", "local-config-anthropic-key");
		routeModelsConfigToTestAgentDir();

		await expect(
			runAuthGatewayCommand({
				action: "check",
				flags: { json: true, local: true },
			}),
		).resolves.toBeUndefined();

		const output = JSON.parse(capturedStdout) as Record<string, unknown>;
		expect(output.source).toBe("local");
		expect(output.credentialSource).toContain(`local ${getAgentDbPath()}`);
		expect(output.credentials).toEqual([
			expect.objectContaining({
				provider: "anthropic",
				type: "api_key",
				ok: null,
			}),
		]);
	});
});

type CapturedSpawnOptions = {
	detached?: boolean;
	stdin?: unknown;
	stdout?: unknown;
	stderr?: unknown;
};

describe("auth-gateway serve daemon", () => {
	it("spawns a detached serve child, waits for health, and writes daemon state", async () => {
		await seedLocalCredential("anthropic", "local-anthropic-key");
		const starts: AuthGatewayBootOptions[] = [];
		stubGatewayServer(starts);
		const unref = vi.fn();
		const spawnCalls: Array<{ cmd: string[]; options: CapturedSpawnOptions }> = [];
		spyOn(Bun, "spawn").mockImplementation(((cmd: unknown, options: unknown) => {
			spawnCalls.push({ cmd: cmd as string[], options: options as CapturedSpawnOptions });
			return {
				pid: 43_210,
				unref,
				exited: new Promise<number>(() => {}),
			};
		}) as unknown as typeof Bun.spawn);
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

		await expect(
			runAuthGatewayCommand({
				action: "serve",
				flags: { bind: "127.0.0.1:49011", noAuth: true, daemon: true },
			}),
		).resolves.toBeUndefined();

		expect(starts).toHaveLength(0);
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cmd).toContain("auth-gateway");
		expect(spawnCalls[0]?.cmd).toContain("serve");
		expect(spawnCalls[0]?.cmd).not.toContain("--daemon");
		expect(spawnCalls[0]?.options.detached).toBe(true);
		expect(spawnCalls[0]?.options.stdin).toBe("ignore");
		expect(spawnCalls[0]?.options.stdout).toBe("ignore");
		expect(spawnCalls[0]?.options.stderr).toBe("ignore");
		expect(unref).toHaveBeenCalled();
		expect(globalThis.fetch).toHaveBeenCalledWith("http://127.0.0.1:49011/healthz", expect.any(Object));

		const configRoot = getConfigRootDir();
		const state = JSON.parse(await Bun.file(path.join(configRoot, "auth-gateway.daemon.json")).text()) as {
			pid: number;
			url: string;
			logFile: string;
		};
		expect(state.pid).toBe(43_210);
		expect(state.url).toBe("http://127.0.0.1:49011");
		expect(state.logFile).toBe(path.join(configRoot, "auth-gateway.log"));
		expect(await Bun.file(path.join(configRoot, "auth-gateway.pid")).text()).toBe("43210\n");
		expect(capturedStdout).toContain("pid: 43210");
	});

	it("rejects daemon mode for non-serve actions", async () => {
		await expect(runAuthGatewayCommand({ action: "status", flags: { daemon: true } })).rejects.toThrow(
			/only supported with `auth-gateway serve`/,
		);
	});

	it("rejects verbose logging outside foreground serve mode", async () => {
		await expect(runAuthGatewayCommand({ action: "status", flags: { verbose: true } })).rejects.toThrow(
			/only supported with `auth-gateway serve`/,
		);
		await expect(runAuthGatewayCommand({ action: "serve", flags: { daemon: true, verbose: true } })).rejects.toThrow(
			/cannot be combined with `--daemon`/,
		);
	});
});

describe("auth-gateway status broker failure metadata", () => {
	it("preserves configured broker metadata when the broker snapshot is unavailable", async () => {
		configuredBrokerEnv();
		stubBrokerSnapshotFailure("snapshot unavailable");

		await expect(runAuthGatewayCommand({ action: "status", flags: { json: true } })).resolves.toBeUndefined();

		const output = JSON.parse(capturedStdout) as Record<string, unknown>;
		expect(output.ready).toBe(false);
		expect(output.reason).toBe("credential_source_unavailable");
		expect(output.broker).toBe(BROKER_URL);
		expect(output.brokerConfigured).toBe(true);
		expect(output.brokerAuthenticated).toBe(false);
		expect(output.source).toBe("broker");
		expect(output.error).toContain("snapshot unavailable");
		expect(process.exitCode).toBe(1);
	});
});

describe("auth-gateway command parser", () => {
	it("forwards --local, --daemon, and --verbose into AuthGatewayCommandArgs flags", async () => {
		const runSpy = spyOn(authGatewayCli, "runAuthGatewayCommand").mockResolvedValue(undefined);
		spyOn(theme, "initTheme").mockResolvedValue(undefined);

		const command = new AuthGateway(["serve", "--local", "--daemon", "--verbose"], TEST_CONFIG);
		await command.run();

		expect(runSpy).toHaveBeenCalledWith({
			action: "serve",
			flags: {
				json: undefined,
				bind: undefined,
				regenerate: undefined,
				noAuth: undefined,
				strict: undefined,
				local: true,
				daemon: true,
				verbose: true,
			},
		});
	});
});
