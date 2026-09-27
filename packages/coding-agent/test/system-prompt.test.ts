import { describe, expect, it, spyOn } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import eagerTaskPrompt from "../src/prompts/system/eager-task.md" with { type: "text" };
import { buildSystemPromptWithOrchestratorOverlay } from "../src/session/session-tools";
import { buildSystemPrompt } from "../src/system-prompt";

// This helper defends the batch-schema behavior through rendered prompt output, not prompt source text.
function expectCompatibleSameAgentBatchWave(rendered: string): void {
	expect(rendered).toMatch(
		/(?:per\s+(?:agent|specialist)\s+type[\s\S]{0,60}partition|partition[\s\S]{0,60}(?:each|every)\s+group)[\s\S]{0,100}compatible\s+same[- ]agent\s+batches?/i,
	);
	expect(rendered).toMatch(
		/dispatch\s+(?:every|all)\s+(?:resulting\s+)?batch(?:es)?\s+concurrently[\s\S]{0,100}(?:in\s+)?(?:the\s+)?(?:(?:same|single)\s+)?(?:ready\s+)?wave/i,
	);
	expect(rendered).not.toMatch(
		/(?:incompatible|remaining|remainder|fallback)[\s\S]{0,120}flat[\s-]+(?:`?task`?[\s-]+)?calls?|flat[\s-]+(?:`?task`?[\s-]+)?calls?[\s\S]{0,120}(?:incompatible|remaining|remainder|fallback)/i,
	);
}

// The solo-work carve-out MUST survive in both batch modes: the reminder always names a
// do-it-yourself escape hatch and the single-runnable-slice case that makes spawning pointless.
function expectSoloWorkCarveOut(rendered: string): void {
	expect(rendered).toMatch(/work\s+alone/i);
	expect(rendered).toMatch(/one\s+runnable\s+slice/i);
}

async function renderDelegationPrompt(): Promise<string[]> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: import.meta.dir,
		toolNames: ["read", "bash", "edit", "write", "task"],
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: {
			rootPath: import.meta.dir,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		activeRepoContext: null,
		personality: "none",
		taskBatch: true,
	});
	return systemPrompt;
}

function planLockPolicy(rendered: string): string {
	const start = rendered.indexOf("PLAN LOCK & MOMENTUM");
	const end = rendered.indexOf("PRODUCTION STANCE", start);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return rendered.slice(start, end);
}

describe("normal system prompt delegation contract", () => {
	it("keeps terminal artifacts out of the implementation pipeline", async () => {
		const rendered = (await renderDelegationPrompt())[0] ?? "";
		const policy = planLockPolicy(rendered);

		expect(rendered).toMatch(
			/Terminal artifact verbs[\s\S]*RISK MAY increase[\s\S]*NEVER authorizes implementation, production edits, production-owner dispatch, QA, or deployment/i,
		);
		expect(policy).toMatch(
			/locked terminal-artifact plan ends with its requested plan, review, investigation, or recommendation; NEVER dispatch production owners, edit code, run QA, or deploy/i,
		);
		expect(policy).not.toMatch(/a locked plan[\s\S]{0,80}NEXT action implements/i);
	});

	it("keeps plan-and-implement dispatch conditional and intact", async () => {
		const rendered = (await renderDelegationPrompt())[0] ?? "";
		const policy = planLockPolicy(rendered);

		expect(rendered).toContain("|plan and implement|plan then code, same session|code verified against the plan|");
		expect(policy).toMatch(/locked implementation plan[\s\S]{0,180}NEXT action implements/i);
	});

	it("retains canonical terminal-artifact plan semantics in the orchestrator overlay", async () => {
		const rendered = buildSystemPromptWithOrchestratorOverlay(await renderDelegationPrompt())[0] ?? "";

		expect(rendered).toMatch(
			/Canonical plan semantics live in `system-prompt\.md`[\s\S]*terminal artifacts[\s\S]*NEVER authorizes implementation, production-owner dispatch, QA, or deployment/i,
		);
		expect(rendered).toMatch(/locked implementation plan[\s\S]{0,180}NEXT action implements/i);
	});

	it("minimizes latency without down-tiering load-bearing work", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: import.meta.dir,
			toolNames: ["read", "bash", "edit", "write", "task"],
			contextFiles: [],
			skills: [],
			rules: [],
			workspaceTree: {
				rootPath: import.meta.dir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			activeRepoContext: null,
			personality: "none",
			taskBatch: true,
		});
		const rendered = systemPrompt[0] ?? "";
		const contractChecks = [
			{
				name: "minimizes the dependency-graph critical path",
				satisfied:
					/critical[ -]path/i.test(rendered) &&
					/(?:minimi[sz]|shorten|reduce)[a-z]*/i.test(rendered) &&
					/(?:dependency[ -]graph|\bDAG\b)/i.test(rendered),
			},
			{
				name: "batches every ready independent package in one wave",
				satisfied:
					/batch(?:es|ing)?/i.test(rendered) &&
					/(?:every|all)[\s\S]{0,80}ready[\s\S]{0,80}independent[\s\S]{0,80}(?:package|work)[\s\S]{0,160}(?:ready[ -])?wave|(?:ready[ -])?wave[\s\S]{0,160}(?:every|all)[\s\S]{0,80}ready[\s\S]{0,80}independent[\s\S]{0,80}(?:package|work)/i.test(
						rendered,
					),
			},
			// A top-level task call selects one agent, so a mixed wave requires concurrent type-specific groups.
			{
				name: "groups heterogeneous ready waves by agent type, dispatches every group concurrently, batches only compatible same-agent packages, and preserves specialist/RISK routing over one-call minimization",
				satisfied:
					/(?:heterogeneous|mixed)[\s-]+(?:ready[\s-]+)?wave[\s\S]{0,180}(?:group|partition|split)[\s\S]{0,140}(?:agent|specialist)[\s-]+type|(?:group|partition|split)[\s\S]{0,140}(?:heterogeneous|mixed)[\s-]+(?:ready[\s-]+)?wave[\s\S]{0,140}(?:agent|specialist)[\s-]+type/i.test(
						rendered,
					) &&
					/(?:every|all)[\s-]+groups?[\s\S]{0,120}concurrent|concurrent[\s\S]{0,120}(?:every|all)[\s-]+groups?/i.test(
						rendered,
					) &&
					/(?:each|every)[\s\S]{0,80}(?:batch(?:ed)?|call)[\s\S]{0,160}(?:only[\s\S]{0,60})?(?:same[\s-]+agent|compatible[\s\S]{0,80}(?:agent|specialist))|(?:only[\s\S]{0,60})?(?:compatible[\s-]+)?same[\s-]+agent[\s\S]{0,100}(?:batch|call)/i.test(
						rendered,
					) &&
					/(?:never|must not|do not)[\s\S]{0,120}(?:sacrific|change|override|down[\s-]?tier)[\s\S]{0,160}(?:specialist|risk|routing)[\s\S]{0,180}(?:single|one)[\s-]+(?:batch|call)|(?:specialist|risk|routing)[\s\S]{0,160}(?:never|must not|do not)[\s\S]{0,120}(?:single|one)[\s-]+(?:batch|call)/i.test(
						rendered,
					),
			},
			{
				name: "forbids waterfall or one-agent-at-a-time dispatch",
				satisfied:
					/(?:avoid|never|must not|do not)[\s\S]{0,140}(?:waterfall|one[ -](?:agent|package|task)[ -]at[ -]a[ -]time)|(?:waterfall|one[ -](?:agent|package|task)[ -]at[ -]a[ -]time)[\s\S]{0,140}(?:avoid|never|must not|do not)/i.test(
						rendered,
					),
			},
			{
				name: "offers exactly two implementer tiers and splits oversized slices instead of up-tiering",
				satisfied:
					!/heavy_task/i.test(rendered) &&
					/(?:ten|10)[ -]minute[\s\S]{0,400}(?:two briefs|two packages|split)/i.test(rendered) &&
					/`task`[\s\S]{0,300}load-bearing[\s\S]{0,300}(?:no subagent self-review|you review every returned)/i.test(
						rendered,
					),
			},
			{
				name: "routes only independently ownable contained senior slices to task",
				satisfied:
					/(?:independent|ownable)[\s\S]{0,180}(?:contained|senior)[\s\S]{0,180}\btask\b|\btask\b[\s\S]{0,180}(?:contained|senior)[\s\S]{0,180}(?:independent|ownable)/i.test(
						rendered,
					),
			},
			{
				name: "routes only independently ownable locked mechanical slices to quick_task",
				satisfied:
					/(?:independent|ownable)[\s\S]{0,180}(?:locked|mechanical|perimeter)[\s\S]{0,180}quick_task|quick_task[\s\S]{0,180}(?:locked|mechanical|perimeter)[\s\S]{0,180}(?:independent|ownable)/i.test(
						rendered,
					),
			},
			{
				name: "preserves specialist routing and clear ownership",
				satisfied:
					/(?:specialist|specializ[a-z]*)[\s\S]{0,180}(?:route|routing|prefer)|(?:route|routing|prefer)[\s\S]{0,180}(?:specialist|specializ[a-z]*)/i.test(
						rendered,
					) && /clear file ownership/i.test(rendered),
			},
			{
				name: "makes sub-10-minute latency conditional on the DAG, never a risk downgrade",
				satisfied:
					/(?:sub[ -]?10|under 10|<\s*10)[ -]minute[\s\S]{0,160}(?:only[\s-]+)?when[\s\S]{0,100}(?:dependency[ -]graph|\bDAG\b)|(?:dependency[ -]graph|\bDAG\b)[\s\S]{0,100}(?:only[\s-]+)?when[\s\S]{0,160}(?:sub[ -]?10|under 10|<\s*10)[ -]minute/i.test(
						rendered,
					) &&
					/(?:never|must not|do not|not)[\s\S]{0,180}down[ -]?tier[\s\S]{0,180}(?:risk|load-bearing)|down[ -]?tier[\s\S]{0,180}(?:risk|load-bearing)[\s\S]{0,180}(?:never|must not|do not|not)/i.test(
						rendered,
					),
			},
		];

		expect(contractChecks.filter(check => !check.satisfied).map(check => check.name)).toEqual([]);
		// One batch per agent type or a flat fallback omits at least one required rendered clause.
		expectCompatibleSameAgentBatchWave(rendered);
	}, 15_000);

	it("uses concurrent flat task calls when task batching is disabled", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: import.meta.dir,
			toolNames: ["read", "bash", "edit", "write", "task"],
			contextFiles: [],
			skills: [],
			rules: [],
			workspaceTree: {
				rootPath: import.meta.dir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			activeRepoContext: null,
			personality: "none",
			taskBatch: false,
		});
		const rendered = systemPrompt.join("\n");

		// A flat schema still fans out ready work, but never receives the batch-only tasks array.
		expect(rendered).toMatch(
			/(?:every|all)[\s\S]{0,80}(?:ready|independent)[\s\S]{0,120}concurrent[\s\S]{0,120}(?:available[\s-]+)?`?task`?[\s-]+calls/i,
		);
		expect(rendered).not.toMatch(/`?tasks`?\s*(?:\[\s*\]|array\b|:)/i);
	}, 15_000);

	it("keeps eager task reminders partitioned into concurrent compatible batches", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: import.meta.dir,
			toolNames: ["read", "bash", "edit", "write", "task"],
			contextFiles: [],
			skills: [],
			rules: [],
			workspaceTree: {
				rootPath: import.meta.dir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			activeRepoContext: null,
			personality: "none",
			taskBatch: true,
			eagerTasks: true,
			eagerTasksAlways: true,
		});
		const rendered = systemPrompt.join("\n");

		expect(rendered).toMatch(
			/(?:heterogeneous|mixed)[\s-]+(?:ready[\s-]+)?wave[\s\S]{0,180}(?:group|partition|split)[\s\S]{0,140}(?:agent|specialist)[\s-]+type|(?:group|partition|split)[\s\S]{0,140}(?:heterogeneous|mixed)[\s-]+(?:ready[\s-]+)?wave[\s\S]{0,140}(?:agent|specialist)[\s-]+type/i,
		);
		expect(rendered).toMatch(
			/(?:every|all)[\s-]+groups?[\s\S]{0,120}concurrent|concurrent[\s\S]{0,120}(?:every|all)[\s-]+groups?/i,
		);
		expect(rendered).toMatch(
			/(?:each|every)[\s\S]{0,80}(?:batch(?:ed)?|call)[\s\S]{0,160}(?:only[\s\S]{0,60})?(?:same[\s-]+agent|compatible[\s\S]{0,80}(?:agent|specialist))|(?:only[\s\S]{0,60})?(?:compatible[\s-]+)?same[\s-]+agent[\s\S]{0,100}(?:batch|call)/i,
		);
		expectCompatibleSameAgentBatchWave(rendered);

		// A global one-call reminder overrides the type-specific grouping contract even when both are rendered.
		const globalOneCallReminder = rendered.match(
			/(?:batch|combine|dispatch|group|put|send)[\s\S]{0,80}(?:all|every|independent|ready)?[\s\S]{0,80}(?:slices?|packages?|tasks?|work)[\s\S]{0,80}(?:into|in|using|via)[\s\S]{0,40}(?:one|single)[\s-]+(?:parallel[\s-]+)?`?task`?[\s-]+call/i,
		)?.[0];
		expect(globalOneCallReminder).toBeUndefined();
	}, 15_000);
});

describe("eager task runtime reminder", () => {
	it("renders every compatible same-agent batch concurrently in one wave", () => {
		const rendered = prompt.render(eagerTaskPrompt, {
			toolRefs: { task: "task" },
			taskBatch: true,
		});

		// Semantic clauses survive harmless wording changes but reject one-batch-per-type and flat fallbacks.
		expectCompatibleSameAgentBatchWave(rendered);
		expectSoloWorkCarveOut(rendered);
	});

	it("renders every ready slice as a concurrent flat call when batching is disabled", () => {
		const rendered = prompt.render(eagerTaskPrompt, {
			toolRefs: { task: "task" },
			taskBatch: false,
		});

		expect(rendered).toContain(
			"Dispatch EVERY independent ready slice concurrently as flat `task` calls; NEVER dispatch one at a time.",
		);
		expect(rendered).not.toContain("batch ONLY compatible same-agent slices per `task` call");
		expectSoloWorkCarveOut(rendered);
	});
});

describe("loop engineering system prompt contract", () => {
	const emptyWorkspaceTree = {
		rootPath: import.meta.dir,
		rendered: "",
		truncated: false,
		totalLines: 0,
		agentsMdFiles: [] as [],
	};

	it("renders Loop Engineering when loop is available", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: import.meta.dir,
			toolNames: ["read", "bash", "edit", "write", "loop"],
			contextFiles: [],
			skills: [],
			rules: [],
			workspaceTree: emptyWorkspaceTree,
			activeRepoContext: null,
			personality: "none",
		});
		const rendered = systemPrompt.join("\n");

		expect(rendered).toContain("# Loop Engineering");
		expect(rendered).toMatch(/loop engineering = engineering the system that prompts you/i);
		expect(rendered).toMatch(/each iteration is a FRESH turn/i);
	}, 15_000);

	it("omits Loop Engineering when loop is unavailable", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: import.meta.dir,
			toolNames: ["read", "bash", "edit", "write", "task"],
			contextFiles: [],
			skills: [],
			rules: [],
			workspaceTree: emptyWorkspaceTree,
			activeRepoContext: null,
			personality: "none",
		});
		const rendered = systemPrompt.join("\n");

		expect(rendered).not.toContain("# Loop Engineering");
		expect(rendered).not.toMatch(/loop engineering = engineering the system that prompts you/i);
	}, 15_000);
});

describe("subagent model selection system prompt contract", () => {
	it("defers subagent model choice to configured defaults unless the user overrides", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: import.meta.dir,
			toolNames: ["read", "bash", "edit", "write", "task"],
			contextFiles: [],
			skills: [],
			rules: [],
			workspaceTree: {
				rootPath: import.meta.dir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			activeRepoContext: null,
			personality: "none",
		});
		const rendered = systemPrompt.join("\n");

		// Default: the parent omits `model` so the configured agent default/fallback chain wins.
		expect(rendered).toContain("# Subagent model selection");
		expect(rendered).toMatch(/Do NOT set or override a subagent's `model`/);
		expect(rendered).toMatch(/preconfigured default and fallback chain/i);

		// Exception: only an explicit user request may pin a model.
		expect(rendered).toMatch(/Set `model` ONLY when the user explicitly names a model/);
		expect(rendered).toMatch(/NEVER infer a model override from task size, complexity, cost, speed, risk/i);

		// The old size-based heuristic must be gone, not living beside the new rule.
		expect(rendered).not.toContain("# Small-model dispatch");
		expect(rendered).not.toMatch(/Give small models narrow, concrete/i);
	}, 15_000);
});
