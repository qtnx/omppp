import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CodeGraphManager, type CodeGraphState } from "@oh-my-pi/pi-coding-agent/codegraph/manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

interface StartupSeam {
	manager: CodeGraphManager;
	started: Promise<void>;
	emitReady(): void;
	resolveReady(): void;
}

function createStartupSeam(projectRoot: string): StartupSeam {
	const { promise: started, resolve: resolveStarted } = Promise.withResolvers<void>();
	const { promise: ready, resolve: resolveReady } = Promise.withResolvers<CodeGraphState>();
	const readyState: CodeGraphState = { status: "ready", projectRoot };
	let listener: ((state: CodeGraphState) => void) | undefined;
	const manager = {
		projectRoot,
		onReady(nextListener: (state: CodeGraphState) => void) {
			listener = nextListener;
			return () => {
				listener = undefined;
			};
		},
		start() {
			resolveStarted();
		},
		ensureReady: () => ready,
	} as unknown as CodeGraphManager;
	return {
		manager,
		started,
		emitReady() {
			listener?.(readyState);
			resolveReady(readyState);
		},
		resolveReady() {
			resolveReady(readyState);
		},
	};
}

describe("CodeGraph startup", () => {
	let root: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let seam: StartupSeam;
	let originalForProject: typeof CodeGraphManager.forProject;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-codegraph-startup-"));
		authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		originalForProject = CodeGraphManager.forProject;
		seam = createStartupSeam(root);
		Object.defineProperty(CodeGraphManager, "forProject", {
			configurable: true,
			value: async () => seam.manager,
		});
	});

	afterEach(async () => {
		Object.defineProperty(CodeGraphManager, "forProject", {
			configurable: true,
			value: originalForProject,
		});
		while (sessions.length > 0)
			await sessions
				.pop()
				?.dispose()
				.catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		fs.rmSync(root, { recursive: true, force: true });
	});

	async function createSession(
		cwd: string,
		settings: Settings,
		extra: Record<string, unknown> = {},
	): Promise<AgentSession> {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled test model");
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			agentId: `CodeGraphStartup-${path.basename(cwd)}`,
			modelRegistry,
			sessionManager: SessionManager.inMemory(cwd),
			settings,
			model,
			disableExtensionDiscovery: true,
			contextFiles: [],
			skills: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			enableLsp: false,
			...extra,
		});
		sessions.push(session);
		return session;
	}

	it("starts after construction and injects one hidden readiness message", async () => {
		const cwd = path.join(root, "top-level");
		fs.mkdirSync(cwd);
		const session = await createSession(cwd, Settings.isolated({ "codegraph.enabled": true }));
		const messages: Array<{ customType: string; content: string; display: boolean | undefined }> = [];
		const { promise: messageQueued, resolve: resolveMessageQueued } = Promise.withResolvers<void>();
		const sendCustomMessage = session.sendCustomMessage.bind(session);
		session.sendCustomMessage = async (message, options) => {
			if (typeof message === "string") throw new Error("Expected structured CodeGraph readiness guidance");
			messages.push({
				customType: message.customType ?? "",
				content: typeof message.content === "string" ? message.content : (JSON.stringify(message.content) ?? ""),
				display: message.display,
			});
			const delivered = await sendCustomMessage(message, options);
			resolveMessageQueued();
			return delivered;
		};

		await seam.started;
		expect(messages).toEqual([]);
		seam.emitReady();
		await messageQueued;
		expect(messages).toEqual([
			{
				customType: "codegraph-ready",
				content: expect.stringContaining("codegraph_explore"),
				display: false,
			},
		]);
		seam.emitReady();
		expect(messages).toHaveLength(1);
	});

	it("queues readiness guidance without triggering an agent turn", async () => {
		const cwd = path.join(root, "non-triggering-guidance");
		fs.mkdirSync(cwd);
		const session = await createSession(cwd, Settings.isolated({ "codegraph.enabled": true }));
		const { promise: deliveryObserved, resolve: resolveDeliveryObserved } = Promise.withResolvers<{
			method: "deferred" | "next-turn";
			options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean };
		}>();
		session.queueDeferredMessage = () => {
			resolveDeliveryObserved({ method: "deferred" });
		};
		session.sendCustomMessage = async (_message, options) => {
			resolveDeliveryObserved({ method: "next-turn", options });
			return false;
		};

		await seam.started;
		seam.emitReady();
		expect(await deliveryObserved).toEqual({
			method: "next-turn",
			options: { deliverAs: "nextTurn", triggerTurn: false },
		});
	});

	it("queues guidance when a shared manager is already ready", async () => {
		const cwd = path.join(root, "already-ready");
		fs.mkdirSync(cwd);
		const session = await createSession(cwd, Settings.isolated({ "codegraph.enabled": true }));
		const messages: Array<{ customType: string; content: string; display: boolean | undefined }> = [];
		const { promise: messageQueued, resolve: resolveMessageQueued } = Promise.withResolvers<void>();
		const sendCustomMessage = session.sendCustomMessage.bind(session);
		session.sendCustomMessage = async (message, options) => {
			if (typeof message === "string") throw new Error("Expected structured CodeGraph readiness guidance");
			messages.push({
				customType: message.customType ?? "",
				content: typeof message.content === "string" ? message.content : (JSON.stringify(message.content) ?? ""),
				display: message.display,
			});
			const delivered = await sendCustomMessage(message, options);
			resolveMessageQueued();
			return delivered;
		};

		await seam.started;
		seam.resolveReady();
		await messageQueued;
		expect(messages).toEqual([
			{
				customType: "codegraph-ready",
				content: expect.stringContaining("codegraph_explore"),
				display: false,
			},
		]);
	});

	it("does not auto-start in subagent, restricted, disabled, or auto-index-off sessions", async () => {
		const cases = [
			{ name: "subagent", extra: { taskDepth: 1 }, settings: { "codegraph.enabled": true } },
			{ name: "restricted", extra: { restrictToolNames: true }, settings: { "codegraph.enabled": true } },
			{ name: "disabled", extra: {}, settings: { "codegraph.enabled": false } },
			{
				name: "auto-index-off",
				extra: {},
				settings: { "codegraph.enabled": true, "codegraph.autoIndex": false },
			},
		] as const;

		for (const testCase of cases) {
			const cwd = path.join(root, testCase.name);
			fs.mkdirSync(cwd);
			await createSession(cwd, Settings.isolated(testCase.settings), testCase.extra);
		}
		await Promise.resolve();
		await Promise.resolve();
		expect(await Promise.race([seam.started.then(() => true), Promise.resolve(false)])).toBe(false);
	});
});
