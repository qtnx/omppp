import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import eagerTaskPrompt from "./prompts/system/eager-task.md" with { type: "text" };
import { buildSystemPrompt } from "./system-prompt";

interface ProbeRunResult {
	elapsedMs: number;
	childElapsedMs: number;
	cached: unknown;
	count: number;
}

async function runProbeScenario(options: {
	runs: number;
	sleepSeconds?: number;
	holdStdoutOpen?: boolean;
	descendantHoldsStdout?: boolean;
	validOutput?: string;
}): Promise<ProbeRunResult> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gpu-probe-"));
	try {
		const binDir = path.join(tempRoot, "bin");
		const cacheRoot = path.join(tempRoot, "cache");
		const probeCountPath = path.join(tempRoot, "probe-count");
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(path.join(cacheRoot, "omp"), { recursive: true });
		const lspciPath = path.join(binDir, "lspci");
		await Bun.write(
			lspciPath,
			'#!/usr/bin/env sh\nprintf x >> "$OMP_GPU_PROBE_COUNT"\nif [ -n "$OMP_GPU_PROBE_VALID_OUTPUT" ]; then printf "%s\\n" "$OMP_GPU_PROBE_VALID_OUTPUT"; fi\nif [ "$OMP_GPU_PROBE_DESCENDANT_HOLDS_STDOUT" = "true" ]; then sleep "$OMP_GPU_PROBE_SLEEP" & exit 0; fi\nif [ "$OMP_GPU_PROBE_HOLD_STDOUT_OPEN" = "true" ]; then sleep "$OMP_GPU_PROBE_SLEEP" & wait "$!"; fi\nif [ -n "$OMP_GPU_PROBE_SLEEP" ]; then exec sleep "$OMP_GPU_PROBE_SLEEP"; fi\nexit 0\n',
		);
		await fs.chmod(lspciPath, 0o755);

		const scenarioPath = path.join(tempRoot, "scenario.ts");
		await Bun.write(
			scenarioPath,
			`import { getGpuCachePath, refreshDirsFromEnv } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/index.ts"))};
import { buildSystemPrompt } from ${JSON.stringify(path.join(import.meta.dir, "system-prompt.ts"))};

refreshDirsFromEnv();
const buildOptions = {
	contextFiles: [],
	skills: [],
	toolNames: [],
	workspaceTree: {
		rootPath: process.cwd(),
		rendered: "",
		truncated: false,
		totalLines: 0,
		agentsMdFiles: [],
	},
	activeRepoContext: null,
};
const startedAt = performance.now();
for (let index = 0; index < Number(process.env.OMP_GPU_PROBE_RUNS ?? "1"); index += 1) {
	await buildSystemPrompt(buildOptions);
}
const cacheFile = Bun.file(getGpuCachePath());
const cached = await cacheFile.exists() ? await cacheFile.json() : null;
const countFile = Bun.file(process.env.OMP_GPU_PROBE_COUNT ?? "");
const count = await countFile.exists() ? (await countFile.text()).length : 0;
console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - startedAt), cached, count }));
`,
		);

		const env: Record<string, string | undefined> = {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			XDG_CACHE_HOME: cacheRoot,
			OMP_GPU_PROBE_COUNT: probeCountPath,
			OMP_GPU_PROBE_RUNS: String(options.runs),
		};
		// Strip inherited dirs-resolver overrides so XDG_CACHE_HOME above wins and
		// the test cannot touch the developer/CI profile's real gpu_cache.json.
		for (const key of ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"]) {
			delete env[key];
		}
		if (options.sleepSeconds === undefined) {
			delete env.OMP_GPU_PROBE_SLEEP;
		} else {
			env.OMP_GPU_PROBE_SLEEP = String(options.sleepSeconds);
		}
		if (options.holdStdoutOpen) {
			env.OMP_GPU_PROBE_HOLD_STDOUT_OPEN = "true";
		} else {
			delete env.OMP_GPU_PROBE_HOLD_STDOUT_OPEN;
		}
		if (options.descendantHoldsStdout) {
			env.OMP_GPU_PROBE_DESCENDANT_HOLDS_STDOUT = "true";
		} else {
			delete env.OMP_GPU_PROBE_DESCENDANT_HOLDS_STDOUT;
		}
		if (options.validOutput !== undefined) {
			env.OMP_GPU_PROBE_VALID_OUTPUT = options.validOutput;
		} else {
			delete env.OMP_GPU_PROBE_VALID_OUTPUT;
		}

		const childStartedAt = performance.now();
		const child = Bun.spawn([process.execPath, scenarioPath], { stdout: "pipe", stderr: "pipe", env });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const childElapsedMs = Math.round(performance.now() - childStartedAt);
		if (exitCode !== 0) {
			throw new Error(`GPU probe scenario failed with exit ${exitCode}: ${stderr}`);
		}
		return { ...JSON.parse(stdout.trim()), childElapsedMs };
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform !== "linux")("system prompt GPU probe", () => {
	it("caches empty GPU probe results", async () => {
		const result = await runProbeScenario({ runs: 2 });

		expect(result.cached).toEqual({ gpu: null });
		expect(result.count).toBe(1);
	}, 15_000);

	it("kills the GPU probe at the prep deadline", async () => {
		const result = await runProbeScenario({ runs: 1, sleepSeconds: 12, holdStdoutOpen: true });

		expect(result.cached).toEqual({ gpu: null });
		// Probe is SIGKILLed at ~4.5s and the drain wait is bounded, so in-child
		// time sits near the deadline; waiting on the descendant would push it
		// past the 12s sleep.
		expect(result.elapsedMs).toBeLessThan(6500);
		// Codex#3838: the child process MUST exit shortly after the deadline, not
		// linger until a descendant holding stdout (sleep 12) exits on its own.
		// The bound over in-child time budgets bun spawn/startup on loaded runners
		// while staying far below the descendant's 12s exit.
		expect(result.childElapsedMs).toBeLessThan(9000);
	}, 20_000);

	it("does not wait on stdout held by a descendant after a successful probe", async () => {
		const result = await runProbeScenario({ runs: 1, sleepSeconds: 8, descendantHoldsStdout: true });

		expect(result.cached).toEqual({ gpu: null });
		// Probe exits 0 immediately but leaves a backgrounded sleep holding the stdout
		// pipe. The success path MUST bound the drain wait, not block until sleep exits.
		expect(result.elapsedMs).toBeLessThan(2000);
		// Budgets bun spawn/startup overhead; blocking on the descendant would
		// take at least the 8s sleep.
		expect(result.childElapsedMs).toBeLessThan(5000);
	}, 20_000);

	it("keeps probe output captured before a descendant delays EOF", async () => {
		const result = await runProbeScenario({
			runs: 1,
			sleepSeconds: 8,
			descendantHoldsStdout: true,
			validOutput: "00:02.0 VGA compatible controller: NVIDIA TestGPU",
		});

		// Probe exited 0 with valid output before bg sleep held stdout open.
		// Captured stdout MUST be cached, not discarded as if the probe failed.
		expect(result.cached).toEqual({ gpu: "02.0 VGA compatible controller: NVIDIA TestGPU" });
		expect(result.elapsedMs).toBeLessThan(2000);
		// Budgets bun spawn/startup overhead; blocking on the descendant would
		// take at least the 8s sleep.
		expect(result.childElapsedMs).toBeLessThan(5000);
	}, 20_000);
});

describe.skipIf(process.platform !== "linux")("system prompt CPU model", () => {
	it("does not call os.cpus while building the workstation block", async () => {
		const cpus = spyOn(os, "cpus").mockImplementation(() => [
			{
				model: "Synthetic Slow CPU",
				speed: 0,
				times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
			},
		]);
		try {
			await buildSystemPrompt({
				resolvedCustomPrompt: "Base prompt",
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
			});

			expect(cpus).not.toHaveBeenCalled();
		} finally {
			cpus.mockRestore();
		}
	});
});

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

describe("normal system prompt delegation contract", () => {
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
				name: "keeps risky or load-bearing core work on heavy_task",
				satisfied:
					/heavy_task/i.test(rendered) &&
					/(?:risk|load-bearing|core)[\s\S]{0,180}(?:remain|stay|keep)[\s\S]{0,180}heavy_task|heavy_task[\s\S]{0,180}(?:remain|stay|keep)[\s\S]{0,180}(?:risk|load-bearing|core)|(?:keep|leave)[\s\S]{0,180}(?:risk|load-bearing|core)[\s\S]{0,180}heavy_task/i.test(
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
		expect(rendered).toContain(
			"Work alone for: a single-file edit under ~30 lines, a direct answer requiring no code changes, a command the user explicitly asked you to run, or when only ONE runnable slice exists — a lone subagent is a lossy handoff, not parallelism.",
		);
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
		expect(rendered).toContain(
			"Work alone for: a single-file edit under ~30 lines, a direct answer requiring no code changes, a command the user explicitly asked you to run, or when only ONE runnable slice exists — a lone subagent is a lossy handoff, not parallelism.",
		);
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

describe("non-Linux system prompt CPU model", () => {
	it("includes the model returned by os.cpus", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin" });
		const cpus = spyOn(os, "cpus").mockImplementation(() => [
			{
				model: "Synthetic Non-Linux CPU",
				speed: 0,
				times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
			},
		]);
		try {
			const systemPrompt = await buildSystemPrompt({
				resolvedCustomPrompt: "Base prompt",
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
			});

			expect(cpus).toHaveBeenCalledTimes(1);
			expect(systemPrompt.systemPrompt.join("\n")).toContain("- CPU: Synthetic Non-Linux CPU");
		} finally {
			cpus.mockRestore();
			Object.defineProperty(process, "platform", { value: originalPlatform });
		}
	});
});
