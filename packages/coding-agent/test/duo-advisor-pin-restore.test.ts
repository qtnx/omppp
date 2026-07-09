import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { DuoStateSnapshot } from "../src/duo";

interface DuoSnapshotDetails extends DuoStateSnapshot {
	advisorModelId?: string;
	duoOwnsAdvisor?: boolean;
}

const plannerId = "anthropic/claude-fable-5";
const executorId = "anthropic/claude-opus-4-8";
const standaloneAdvisorId = "anthropic/claude-sonnet-4-5";

function modelOrThrow(provider: "anthropic", id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

function activeSnapshot(
	phase: DuoStateSnapshot["phase"],
	extras: Partial<DuoSnapshotDetails> = {},
): DuoSnapshotDetails {
	return {
		phase,
		plannerId,
		executorId,
		takeoverCount: 0,
		consecutiveTakeovers: 0,
		cooldownRemaining: 0,
		...extras,
	};
}

describe("AgentSession duo advisor pin restore", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let plannerModel: Model;
	let executorModel: Model;
	let standaloneAdvisorModel: Model;
	let tempDir: TempDir | undefined;
	let sessions: AgentSession[];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-duo-advisor-pin-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		plannerModel = modelOrThrow("anthropic", "claude-fable-5");
		executorModel = modelOrThrow("anthropic", "claude-opus-4-8");
		standaloneAdvisorModel = modelOrThrow("anthropic", "claude-sonnet-4-5");
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	beforeEach(() => {
		sessions = [];
	});
	afterEach(async () => {
		for (const session of sessions) await session.dispose();
		sessions = [];
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined;
		}
	});

	function settings() {
		const s = Settings.isolated({
			"advisor.enabled": true,
			"compaction.enabled": false,
			"duo.mode": "on",
			"duo.plannerModel": plannerId,
			"duo.executorModel": executorId,
		});
		s.override("duo.advisorModel", "");
		s.setModelRole("advisor", standaloneAdvisorId);
		return s;
	}

	function createSession(options?: {
		sessionManager?: SessionManager;
		initialModel?: Model;
		settings?: Settings;
	}): AgentSession {
		const agent = new Agent({
			initialState: {
				model: options?.initialModel ?? plannerModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: options?.sessionManager ?? SessionManager.inMemory(tempDir?.path()),
			settings: options?.settings ?? settings(),
			modelRegistry,
			advisorTools: [],
		});
		sessions.push(session);
		return session;
	}

	function createSessionManager(): SessionManager {
		tempDir = TempDir.createSync("@pi-duo-advisor-pin-");
		return SessionManager.inMemory(tempDir.path());
	}

	function appendSnapshot(sessionManager: SessionManager, snapshot: DuoSnapshotDetails): void {
		sessionManager.appendCustomMessageEntry("duo_state", "", false, snapshot, "agent");
	}

	function advisorModelId(session: AgentSession): string | undefined {
		const model = session.getAdvisorAgent()?.state.model;
		return model ? `${model.provider}/${model.id}` : undefined;
	}

	function latestDuoSnapshot(sessionManager: SessionManager): DuoSnapshotDetails | undefined {
		for (const entry of sessionManager.getBranch().toReversed()) {
			if (entry.type === "custom_message" && entry.customType === "duo_state") {
				return entry.details as DuoSnapshotDetails;
			}
		}
		return undefined;
	}

	it("persists the duo advisor pin and restores it on the next session", async () => {
		const sessionManager = createSessionManager();
		appendSnapshot(sessionManager, activeSnapshot("planning"));

		const first = createSession({ sessionManager, initialModel: plannerModel });
		const persisted = latestDuoSnapshot(sessionManager);
		expect(persisted?.advisorModelId).toBe(plannerId);
		expect(persisted?.duoOwnsAdvisor).toBe(true);
		expect(advisorModelId(first)).toBe(plannerId);

		await first.dispose();
		sessions = sessions.filter(session => session !== first);

		const restored = createSession({ sessionManager, initialModel: plannerModel });
		expect(advisorModelId(restored)).toBe(plannerId);
	});

	it("restores an active duo snapshot before building the advisor runtime", () => {
		const sessionManager = createSessionManager();
		appendSnapshot(sessionManager, activeSnapshot("planning", { advisorModelId: plannerId, duoOwnsAdvisor: true }));

		const restored = createSession({ sessionManager, initialModel: plannerModel });

		expect(advisorModelId(restored)).toBe(plannerId);
		expect(advisorModelId(restored)).not.toBe(standaloneAdvisorId);
	});

	it("restores duo takeover support with the pinned advisor", async () => {
		const sessionManager = createSessionManager();
		appendSnapshot(sessionManager, activeSnapshot("executing", { advisorModelId: plannerId, duoOwnsAdvisor: true }));

		const restored = createSession({ sessionManager, initialModel: executorModel });
		const advisor = restored.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");
		const takeoverTool = advisor.state.tools.find(tool => tool.name === "request_takeover");
		expect(takeoverTool).toBeDefined();

		const result = await takeoverTool?.execute("takeover-test", {
			purpose: "recover",
			reason: "executor is blocked",
			directive: "verify the blocker and hand back",
		});

		expect(result?.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("Takeover scheduled") }),
		]);
	});

	it("pins legacy active duo snapshots to plannerId when advisor fields are missing", () => {
		const sessionManager = createSessionManager();
		appendSnapshot(sessionManager, activeSnapshot("planning"));

		const restored = createSession({ sessionManager, initialModel: plannerModel });

		expect(advisorModelId(restored)).toBe(plannerId);
		expect(advisorModelId(restored)).not.toBe(standaloneAdvisorId);
	});

	it("leaves standalone advisor role selection unchanged when restored duo is inactive", () => {
		const sessionManager = createSessionManager();
		const inactiveSettings = settings();
		inactiveSettings.override("duo.mode", "off");
		appendSnapshot(sessionManager, activeSnapshot("inactive", { advisorModelId: plannerId, duoOwnsAdvisor: true }));

		const restored = createSession({
			sessionManager,
			initialModel: standaloneAdvisorModel,
			settings: inactiveSettings,
		});

		expect(advisorModelId(restored)).toBe(standaloneAdvisorId);
	});
});
