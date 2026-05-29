# Workflow Orchestration (Claude-CLI parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Workflow` tool to omp that runs a deterministic JavaScript orchestration script in a `node:vm` sandbox, where the script fans out subagents via `agent()/parallel()/pipeline()/phase()/log()/workflow()` and `budget`, runs in the background with live `/workflows` progress, and supports journal-based resume — matching Claude Code's Workflow feature.

**Architecture:** A new `packages/coding-agent/src/workflow/` subsystem. The script is parsed for its pure-literal `meta`, syntax-validated, persisted, then executed inside a `node:vm` context whose globals are the orchestration helpers bound to a per-invocation `WorkflowRun`. Each `agent()` reuses the existing `runSubprocess(...)` subagent executor (same wiring as the `task` tool). Concurrency is bounded by a run-level semaphore (`min(16, cores-2)`), lifetime agent count by a 1000 backstop. The tool registers a background job via the existing `AsyncJobManager` and returns immediately. Resume replays a per-run journal keyed by chained `hash(prompt, opts, prevKey)`.

**Tech Stack:** TypeScript, Bun, `node:vm` (verified working on Bun 1.3.14 incl. `vm.Script` + `createContext`), `bun:test`, existing omp subagent/async/output-manager infrastructure.

---

## Background: how Claude's Workflow works (reverse-engineered, claude 2.1.154)

- **Tool** `Workflow({script?, scriptPath?, name?, args?, resumeFromRunId?})`. Runs in background, returns `{taskId, runId, scriptPath}` immediately; `<task-notification>` on completion; `/workflows` shows live progress.
- **Script** is plain JS beginning with a pure-literal `export const meta = { name, description, whenToUse?, phases? }`, then a body using injected helper globals.
- **Helpers (VM globals):**
  - `agent(prompt, opts?)` → final text string, or validated object when `opts.schema` set; `null` if skipped. `opts`: `{label, phase, schema, model, isolation:'worktree', agentType}`.
  - `parallel(thunks)` → **barrier**; thrown thunk → `null` (never rejects).
  - `pipeline(items, ...stages)` → **no barrier** between stages; each item flows independently; stage gets `(prev, item, index)`; throw → drops item to `null`.
  - `phase(title)` → groups subsequent agents in the progress tree.
  - `log(message)` → narrator line.
  - `budget` → `{total: number|null, spent(): number, remaining(): number}`; hard ceiling.
  - `workflow(nameOrRef, args?)` → run another workflow inline (one level nesting).
  - `args` → the passed args.
- **Caps:** concurrency `min(16, cores-2)`; lifetime agents 1000; stall 180s.
- **Determinism:** `Date.now()`/`new Date()` (no-arg)/`Math.random()` throw — required for sound resume.
- **Resume:** longest unchanged prefix of `agent()` calls (keyed by chained `hash(prompt, opts, prevKey)`) returns cached results; first changed call + everything after runs live.

## omp infrastructure reused (verified file:line)

- `runSubprocess(options: ExecutorOptions): Promise<SingleResult>` — `task/executor.ts:546`; `ExecutorOptions` — `task/executor.ts:142`. Exact option wiring to copy: `task/index.ts:989-1031`.
- `AgentOutputManager.allocate(id)` / `.allocateBatch(ids)` — `task/output-manager.ts:74-90`.
- `AsyncJobManager.register(type, label, run, options)` / `.instance()` — `async/job-manager.ts:71,113` (type union widened to add `"workflow"` in Task 9).
- `discoverAgents(cwd)` / `getAgent(agents, name)` — `task/discovery.ts:59,127`.
- Bundled agents `EMBEDDED_AGENT_DEFS` / `getBundledAgent` — `task/agents.ts:46,180`.
- `AgentDefinition`, `SingleResult`, `AgentProgress` — `task/types.ts:230,317,247`.
- `ToolSession` — `tools/index.ts:116`.
- `AgentTool` contract — `node_modules/@oh-my-pi/pi-agent-core/src/types.ts:405`.
- Tool factory registry + recursion gate — `tools/index.ts:279,472`.
- `Semaphore` (`acquire`/`release`) — `task/parallel.ts:89-116`.
- Settings block shape — `config/settings-schema.ts:2475`.
- Slash command registry — `slash-commands/builtin-registry.ts:601` (`BUILTIN_SLASH_COMMAND_REGISTRY` array of `SlashCommandSpec`).

## File structure (created/modified)

```
packages/coding-agent/src/workflow/
  types.ts      meta.ts      sandbox.ts    storage.ts    engine.ts
  runtime.ts    journal.ts   discovery.ts  render.ts     index.ts
  bundled/bugfix.js   bundled/investigate.js
packages/coding-agent/src/prompts/tools/workflow.md
packages/coding-agent/src/prompts/agents/workflow-subagent.md
packages/coding-agent/test/workflow/*.test.ts
```
Modified: `task/agents.ts`, `async/job-manager.ts`, `config/settings-schema.ts`, `tools/index.ts`, `slash-commands/builtin-registry.ts`.

---

# Phase 0 — Foundation: types, meta, sandbox

### Task 1: Workflow types

**Files:** Create `packages/coding-agent/src/workflow/types.ts`

- [ ] **Step 1: Write the file**

```typescript
/** Type definitions for the workflow orchestration subsystem. */
import { z } from "zod";
import type { AgentProgress, AgentSource } from "../task/types";

/** EventBus channel for live workflow progress frames. */
export const WORKFLOW_PROGRESS_CHANNEL = "workflow:progress";
/** Lifetime backstop on total agent() calls in a single run. */
export const MAX_WORKFLOW_AGENTS = 1000;
/** Per-agent stall timeout (ms) before a spawn is surfaced as stalled. */
export const WORKFLOW_AGENT_STALL_MS = 180_000;
/** Maximum persisted workflow script size (bytes). */
export const MAX_WORKFLOW_SCRIPT_BYTES = 524_288;

export interface WorkflowMeta {
	name: string;
	description: string;
	whenToUse?: string;
	phases?: Array<string | { title: string; model?: string }>;
}

export interface WorkflowAgentOpts {
	label?: string;
	phase?: string;
	/** JTD schema object (same format as the task tool's `schema`); forces structured output. */
	schema?: unknown;
	model?: string;
	/** Reserved for Phase 4; throws in earlier phases. */
	isolation?: "worktree";
	/** Named agent type from discovered agents; defaults to bundled `workflow-subagent`. */
	agentType?: string;
}

export const workflowSchema = z.object({
	script: z.string().optional().describe("Inline JavaScript workflow script."),
	scriptPath: z.string().optional().describe("Path to a persisted workflow script (overrides `script`)."),
	name: z.string().optional().describe("Name of a saved/bundled workflow to run."),
	args: z.unknown().optional().describe("Value exposed to the script as the `args` global."),
	resumeFromRunId: z.string().optional().describe("Resume from a previous run id (same session)."),
});
export type WorkflowParams = z.infer<typeof workflowSchema>;

export type WorkflowProgressFrame =
	| { kind: "phase"; runId: string; index: number; title: string }
	| { kind: "log"; runId: string; message: string }
	| {
			kind: "agent";
			runId: string;
			index: number;
			label: string;
			phaseTitle?: string;
			state: "start" | "done" | "error" | "cached";
			agentId?: string;
			model?: string;
			error?: string;
			tokens?: number;
			durationMs?: number;
			progress?: AgentProgress;
	  };

export interface WorkflowToolDetails {
	runId: string;
	scriptPath?: string;
	meta?: WorkflowMeta;
	async?: { state: "running" | "completed" | "failed"; jobId: string; type: "workflow" };
	phases: Array<{ index: number; title: string }>;
	agents: Array<{
		index: number;
		label: string;
		phaseTitle?: string;
		state: "start" | "done" | "error" | "cached";
		agentId?: string;
		error?: string;
		tokens?: number;
		durationMs?: number;
	}>;
	logs: string[];
}

export type WorkflowSource = AgentSource;
```

- [ ] **Step 2: Typecheck** — Run `bun check`. Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/src/workflow/types.ts
git commit -m "feat(workflow): foundation types for orchestration subsystem"
```

---

### Task 2: Meta extraction & validation

**Files:** Create `packages/coding-agent/src/workflow/meta.ts`; Test `packages/coding-agent/test/workflow/meta.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { extractMeta, validateMeta } from "../../src/workflow/meta";

describe("extractMeta", () => {
	it("extracts a pure-literal meta object", () => {
		const src = `export const meta = { name: "x", description: "does x", phases: ["a", "b"] };\nlog("hi");`;
		const { meta, metaError } = extractMeta(src);
		expect(metaError).toBeUndefined();
		expect(meta?.name).toBe("x");
		expect(meta?.phases).toEqual(["a", "b"]);
	});
	it("rejects a missing meta declaration", () => {
		expect(extractMeta(`log("no meta");`).metaError).toContain("must begin with");
	});
	it("rejects a non-literal meta (function call)", () => {
		expect(extractMeta(`export const meta = { name: makeName(), description: "d" };`).metaError).toContain("PURE LITERAL");
	});
	it("does not execute body side effects while extracting", () => {
		const src = `export const meta = { name: "x", description: "d" };\nthrow new Error("body ran");`;
		const { meta, metaError } = extractMeta(src);
		expect(metaError).toBeUndefined();
		expect(meta?.name).toBe("x");
	});
});

describe("validateMeta", () => {
	it("passes a valid meta", () => expect(validateMeta({ name: "x", description: "d" })).toBeNull());
	it("rejects an empty name", () => expect(validateMeta({ name: "  ", description: "d" })).toContain("meta.name"));
	it("rejects non-array phases", () =>
		expect(validateMeta({ name: "x", description: "d", phases: "nope" as unknown as [] })).toContain("phases"));
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test packages/coding-agent/test/workflow/meta.test.ts`. Expected: FAIL "Cannot find module ... meta".

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Parse and validate the `export const meta = {...}` header of a workflow script.
 * `meta` MUST be a pure object literal so it can be statically extracted without
 * running the body.
 */
import * as vm from "node:vm";
import type { WorkflowMeta } from "./types";

export interface ExtractMetaResult {
	meta?: WorkflowMeta;
	metaError?: string;
}

/** Find the balanced `{...}` literal starting at `start`. Returns end index (inclusive) or -1. */
function matchBalancedBraces(source: string, start: number): number {
	let depth = 0;
	let inStr: string | null = null;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (inStr) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === inStr) inStr = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inStr = ch;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return i;
	}
	return -1;
}

export function extractMeta(source: string): ExtractMetaResult {
	const decl = source.match(/export\s+const\s+meta\s*=\s*/);
	if (!decl || decl.index === undefined) {
		return { metaError: "Workflow script must begin with `export const meta = { name, description }` (a pure literal)." };
	}
	const braceStart = source.indexOf("{", decl.index + decl[0].length);
	if (braceStart === -1) return { metaError: "`meta` must be an object literal." };
	const braceEnd = matchBalancedBraces(source, braceStart);
	if (braceEnd === -1) return { metaError: "Unterminated `meta` object literal." };

	const literal = source.slice(braceStart, braceEnd + 1);
	try {
		// Evaluate ONLY the literal in a clean context. A pure literal cannot reference
		// identifiers; any variable/call throws → reported as a non-pure-literal error.
		const value = vm.runInContext(`(${literal})`, vm.createContext(Object.create(null)), {
			filename: "workflow-meta.js",
			timeout: 50,
		});
		if (!value || typeof value !== "object") return { metaError: "`meta` must be an object literal." };
		return { meta: value as WorkflowMeta };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { metaError: `\`meta\` must be a PURE LITERAL (no variables, calls, spreads, or interpolation): ${msg}` };
	}
}

export function validateMeta(meta: WorkflowMeta): string | null {
	if (typeof meta.name !== "string" || !meta.name.trim()) return "`meta.name` is required and must be a non-empty string.";
	if (typeof meta.description !== "string" || !meta.description.trim()) {
		return "`meta.description` is required and must be a non-empty string.";
	}
	if (meta.phases !== undefined && !Array.isArray(meta.phases)) return "`meta.phases` must be an array when present.";
	return null;
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test packages/coding-agent/test/workflow/meta.test.ts`. Expected: PASS (7 tests).
- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/workflow/meta.ts packages/coding-agent/test/workflow/meta.test.ts
git commit -m "feat(workflow): pure-literal meta extraction and validation"
```

---

### Task 3: VM sandbox (determinism + syntax validation + run)

**Files:** Create `packages/coding-agent/src/workflow/sandbox.ts`; Test `packages/coding-agent/test/workflow/sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { runWorkflowScript, validateSyntax } from "../../src/workflow/sandbox";

describe("validateSyntax", () => {
	it("accepts valid script with top-level await and export meta", () => {
		expect(validateSyntax(`export const meta = { name: "x", description: "d" };\nawait agent("hi");`).ok).toBe(true);
	});
	it("rejects a syntax error", () => {
		const r = validateSyntax(`export const meta = { name: "x" `);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("SyntaxError");
	});
});

describe("runWorkflowScript", () => {
	it("runs the body, exposes globals, returns the top-level return value", async () => {
		const calls: string[] = [];
		const result = await runWorkflowScript(
			`export const meta = { name: "x", description: "d" };\nconst a = await agent("one");\nlog(a);\nreturn a + "!";`,
			{ agent: async (p: string) => `ran:${p}`, log: (m: string) => calls.push(m) },
			{},
		);
		expect(result).toBe("ran:one!");
		expect(calls).toEqual(["ran:one"]);
	});
	it("blocks Date.now()", async () => {
		await expect(
			runWorkflowScript(`export const meta = { name: "x", description: "d" };\nreturn Date.now();`, {}, {}),
		).rejects.toThrow(/Date\.now\(\) is unavailable/);
	});
	it("blocks new Date() with no args but allows new Date(ts)", async () => {
		await expect(
			runWorkflowScript(`export const meta = { name: "x", description: "d" };\nreturn new Date();`, {}, {}),
		).rejects.toThrow(/new Date\(\) is unavailable/);
		expect(
			await runWorkflowScript(
				`export const meta = { name: "x", description: "d" };\nreturn new Date(0).getUTCFullYear();`,
				{},
				{},
			),
		).toBe(1970);
	});
	it("blocks Math.random()", async () => {
		await expect(
			runWorkflowScript(`export const meta = { name: "x", description: "d" };\nreturn Math.random();`, {}, {}),
		).rejects.toThrow(/Math\.random\(\) is unavailable/);
	});
	it("exposes args as a global", async () => {
		expect(
			await runWorkflowScript(`export const meta = { name: "x", description: "d" };\nreturn args.n * 2;`, {}, { n: 21 }),
		).toBe(42);
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test packages/coding-agent/test/workflow/sandbox.test.ts`. Expected: FAIL "Cannot find module ... sandbox".

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * node:vm sandbox for deterministic workflow scripts.
 *
 * The script begins with `export const meta = {...}` then a body using injected
 * helper globals. We strip the `export` keyword(s), wrap the body in an async IIFE
 * (enabling top-level `await` and a top-level `return`), and run it in a context
 * whose Date/Math.random are shimmed to throw — Claude's determinism contract that
 * makes journal-based resume sound.
 */
import * as vm from "node:vm";

export type SyntaxResult = { ok: true } | { ok: false; error: string };

export function transformSource(source: string): string {
	const stripped = source.replace(/^\s*export\s+(?=(const|let|var|function|class)\b)/gm, "");
	return `(async () => {\n${stripped}\n})()`;
}

export function validateSyntax(source: string): SyntaxResult {
	try {
		// Compile (not run) — catches syntax errors, including stray top-level `import`.
		new vm.Script(transformSource(source), { filename: "workflow.js" });
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
	}
}

const DETERMINISM_INIT = `
"use strict";
Math.random = () => {
	throw new Error("Math.random() is unavailable in workflow scripts (it breaks deterministic resume). Pass random values via args.");
};
const __OrigDate = Date;
class ShimDate extends __OrigDate {
	constructor(...a) {
		if (a.length === 0) {
			throw new Error("new Date() is unavailable in workflow scripts (it breaks deterministic resume). Pass timestamps via args.");
		}
		super(...a);
	}
	static now() {
		throw new Error("Date.now() is unavailable in workflow scripts (it breaks deterministic resume). Pass timestamps via args.");
	}
}
globalThis.Date = ShimDate;
try { delete globalThis.WebAssembly; } catch (_) {}
try { delete globalThis.ShadowRealm; } catch (_) {}
`;

export function createWorkflowContext(globals: Record<string, unknown>): vm.Context {
	const sandbox: Record<string, unknown> = { ...globals };
	if (!("console" in sandbox)) sandbox.console = console;
	const ctx = vm.createContext(sandbox);
	vm.runInContext(DETERMINISM_INIT, ctx, { filename: "workflow-init.js" });
	return ctx;
}

/** Transform, contextualize, and run. Resolves to the script's top-level return value. */
export async function runWorkflowScript(
	source: string,
	globals: Record<string, unknown>,
	args: unknown,
	options: { filename?: string } = {},
): Promise<unknown> {
	const ctx = createWorkflowContext({ ...globals, args });
	return await vm.runInContext(transformSource(source), ctx, { filename: options.filename ?? "workflow.js" });
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test packages/coding-agent/test/workflow/sandbox.test.ts`. Expected: PASS (6 tests).
- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/workflow/sandbox.ts packages/coding-agent/test/workflow/sandbox.test.ts
git commit -m "feat(workflow): vm sandbox with determinism shims and syntax validation"
```

---

# Phase 1 — Engine, runtime API, subagent

### Task 4: Workflow storage paths

**Files:** Create `packages/coding-agent/src/workflow/storage.ts`; Test `packages/coding-agent/test/workflow/storage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { persistWorkflowScript, readWorkflowScript, slugify, workflowDir } from "../../src/workflow/storage";

describe("slugify", () => {
	it("normalizes names, falls back to 'workflow'", () => {
		expect(slugify("Bug Fix #1")).toBe("bug-fix-1");
		expect(slugify("***")).toBe("workflow");
	});
});

describe("persist + read", () => {
	it("round-trips a script under the workflows dir", async () => {
		await using dir = await TempDir.create("wf-storage");
		const p = await persistWorkflowScript(dir.path, "My Flow", "run-1", "export const meta={name:'x',description:'d'};");
		expect(p.startsWith(path.join(workflowDir(dir.path), "scripts"))).toBe(true);
		const read = await readWorkflowScript(p);
		expect(read.error).toBeUndefined();
		expect(read.script).toContain("meta");
	});
	it("reports an oversize script", async () => {
		await using dir = await TempDir.create("wf-storage2");
		const big = path.join(dir.path, "big.js");
		await Bun.write(big, "x".repeat(524_289));
		expect((await readWorkflowScript(big)).error).toContain("exceeds");
	});
	it("reports a missing script", async () => {
		expect((await readWorkflowScript("/nonexistent/x.js")).error).toContain("not found");
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test packages/coding-agent/test/workflow/storage.test.ts`. Expected: FAIL "Cannot find module ... storage".

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Filesystem layout:
 *   <artifactsDir>/workflows/scripts/<slug>-<runId>.js  persisted script
 *   <artifactsDir>/workflows/<runId>/                   subagent transcripts
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { MAX_WORKFLOW_SCRIPT_BYTES } from "./types";

export function slugify(name: string): string {
	const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return s || "workflow";
}
export function workflowDir(artifactsDir: string): string {
	return path.join(artifactsDir, "workflows");
}
export function subagentTranscriptDir(artifactsDir: string, runId: string): string {
	return path.join(workflowDir(artifactsDir), runId);
}

export async function persistWorkflowScript(
	artifactsDir: string,
	name: string,
	runId: string,
	source: string,
): Promise<string> {
	const dir = path.join(workflowDir(artifactsDir), "scripts");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${slugify(name)}-${runId}.js`);
	await Bun.write(file, source);
	return file;
}

export interface ReadScriptResult {
	script?: string;
	error?: string;
}

export async function readWorkflowScript(scriptPath: string): Promise<ReadScriptResult> {
	try {
		const file = Bun.file(scriptPath);
		if (file.size > MAX_WORKFLOW_SCRIPT_BYTES) {
			return { error: `Workflow script file ${scriptPath} exceeds ${MAX_WORKFLOW_SCRIPT_BYTES} bytes.` };
		}
		return { script: await file.text() };
	} catch (error) {
		if (isEnoent(error)) return { error: `Workflow script file not found: ${scriptPath}` };
		return { error: `Failed to read workflow script file ${scriptPath}: ${error}` };
	}
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test packages/coding-agent/test/workflow/storage.test.ts`. Expected: PASS. If `TempDir`/`isEnoent` are not exported from `@oh-my-pi/pi-utils` in this tree, run `bun check` and adjust to the actual export name (both are referenced in repo: `TempDir` in `eval/__tests__/shared-executors.test.ts:5`, `isEnoent` in `AGENTS.md`).
- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/workflow/storage.ts packages/coding-agent/test/workflow/storage.test.ts
git commit -m "feat(workflow): script + transcript storage layout"
```

---

### Task 5: WorkflowRun engine (caps, semaphore, counters, spawn)

**Files:** Create `packages/coding-agent/src/workflow/engine.ts`; Test `packages/coding-agent/test/workflow/engine.test.ts`

This is the chokepoint every `agent()` call funnels through: it enforces caps, acquires the run-level semaphore, allocates an `agent://` id, calls the injected `runSubprocess`, accounts tokens, and emits progress frames.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import { WorkflowRun, workflowConcurrency } from "../../src/workflow/engine";
import { MAX_WORKFLOW_AGENTS } from "../../src/workflow/types";

function makeRun(opts: {
	concurrency?: number;
	budgetTotal?: number | null;
	runSubprocess: (task: string) => Promise<Partial<SingleResult>>;
}) {
	return new WorkflowRun({
		runId: "t1",
		cwd: process.cwd(),
		concurrency: opts.concurrency ?? 2,
		budgetTotal: opts.budgetTotal ?? null,
		signal: new AbortController().signal,
		allocateId: async (label) => `0-${label}`,
		emit: () => {},
		resolveAgent: () => ({ name: "workflow-subagent" }) as AgentDefinition,
		runSubprocess: async (o) => ({ index: o.index, id: o.id, ...(await opts.runSubprocess(o.task)) }) as SingleResult,
	});
}

describe("workflowConcurrency", () => {
	it("is clamped to [2,16]", () => {
		const c = workflowConcurrency();
		expect(c).toBeGreaterThanOrEqual(2);
		expect(c).toBeLessThanOrEqual(16);
	});
});

describe("WorkflowRun.spawn", () => {
	it("returns subagent output text", async () => {
		const run = makeRun({ runSubprocess: async (p) => ({ output: `out:${p}`, usage: { output: 10 } as never }) });
		expect(await run.spawn("hello", {})).toBe("out:hello");
	});
	it("limits concurrency to the configured cap", async () => {
		let active = 0;
		let peak = 0;
		const run = makeRun({
			concurrency: 2,
			runSubprocess: async () => {
				active++;
				peak = Math.max(peak, active);
				await Bun.sleep(10);
				active--;
				return { output: "ok" };
			},
		});
		await Promise.all(Array.from({ length: 6 }, () => run.spawn("x", {})));
		expect(peak).toBeLessThanOrEqual(2);
	});
	it("throws once the lifetime agent cap is exceeded", async () => {
		const run = makeRun({ runSubprocess: async () => ({ output: "ok" }) });
		run.forceAgentCountForTest(MAX_WORKFLOW_AGENTS);
		await expect(run.spawn("x", {})).rejects.toThrow(/agent\(\) call cap/);
	});
	it("enforces the token budget as a hard ceiling", async () => {
		const run = makeRun({ budgetTotal: 5, runSubprocess: async () => ({ output: "ok", usage: { output: 10 } as never }) });
		expect(await run.spawn("first", {})).toBe("ok"); // spent → 10 (over 5)
		await expect(run.spawn("second", {})).rejects.toThrow(/budget/i);
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test packages/coding-agent/test/workflow/engine.test.ts`. Expected: FAIL "Cannot find module ... engine".

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * WorkflowRun — orchestrates one execution of a workflow script. Every agent()
 * funnels through spawn(): caps → semaphore → allocate id → runSubprocess →
 * token accounting → progress frames. parallel()/pipeline() build on spawn().
 */
import * as os from "node:os";
import type { ExecutorOptions } from "../task/executor";
import { Semaphore } from "../task/parallel";
import type { AgentDefinition, SingleResult } from "../task/types";
import { MAX_WORKFLOW_AGENTS, type WorkflowAgentOpts, type WorkflowProgressFrame } from "./types";

/** Concurrent agent() cap per workflow: min(16, cores-2), floored at 2. */
export function workflowConcurrency(): number {
	return Math.min(16, Math.max(2, os.cpus().length - 2));
}

export interface WorkflowRunBudget {
	total: number | null;
	spent(): number;
	remaining(): number;
}

export interface WorkflowRunOptions {
	runId: string;
	cwd: string;
	concurrency: number;
	budgetTotal: number | null;
	signal: AbortSignal;
	allocateId: (label: string) => Promise<string>;
	emit: (frame: WorkflowProgressFrame) => void;
	resolveAgent: (agentType: string | undefined) => AgentDefinition;
	/** Build per-spawn executor options and run the subagent. Injected for testability. */
	runSubprocess: (options: ExecutorOptions) => Promise<SingleResult>;
}

export class WorkflowAgentCapError extends Error {
	constructor() {
		super(
			`Workflow agent() call cap reached (${MAX_WORKFLOW_AGENTS}). This usually means a budget.remaining() loop never terminates (remaining() is Infinity with no budget). Add a hard iteration cap or set a budget.`,
		);
		this.name = "WorkflowAgentCapError";
	}
}
export class WorkflowBudgetError extends Error {
	constructor(spent: number, total: number) {
		super(`Workflow token budget exhausted: spent ${spent} >= budget ${total}. Further agent() calls are blocked.`);
		this.name = "WorkflowBudgetError";
	}
}

export class WorkflowRun {
	readonly runId: string;
	readonly cwd: string;
	readonly signal: AbortSignal;
	readonly budget: WorkflowRunBudget;
	#agentCount = 0;
	#spawnIndex = 0;
	#phaseIndex = 0;
	#currentPhase: string | undefined;
	#tokensSpent = 0;
	readonly #semaphore: Semaphore;
	readonly #opts: WorkflowRunOptions;

	constructor(opts: WorkflowRunOptions) {
		this.#opts = opts;
		this.runId = opts.runId;
		this.cwd = opts.cwd;
		this.signal = opts.signal;
		this.#semaphore = new Semaphore(opts.concurrency);
		this.budget = {
			total: opts.budgetTotal,
			spent: () => this.#tokensSpent,
			remaining: () =>
				opts.budgetTotal == null ? Number.POSITIVE_INFINITY : Math.max(0, opts.budgetTotal - this.#tokensSpent),
		};
	}

	/** Test-only: pre-set the agent counter to exercise the cap. */
	forceAgentCountForTest(n: number): void {
		this.#agentCount = n;
	}

	nextPhase(title: string): void {
		this.#currentPhase = title;
		this.#phaseIndex += 1;
		this.#opts.emit({ kind: "phase", runId: this.runId, index: this.#phaseIndex, title });
	}
	log(message: string): void {
		this.#opts.emit({ kind: "log", runId: this.runId, message });
	}

	#checkCaps(): void {
		if (this.#agentCount >= MAX_WORKFLOW_AGENTS) throw new WorkflowAgentCapError();
		if (this.budget.total != null && this.#tokensSpent >= this.budget.total) {
			throw new WorkflowBudgetError(this.#tokensSpent, this.budget.total);
		}
	}

	async spawn(prompt: string, opts: WorkflowAgentOpts): Promise<string | null> {
		if (this.signal.aborted) return null;
		if (opts.isolation === ("remote" as unknown)) throw new Error("agent({isolation:'remote'}) is not available.");
		this.#checkCaps();

		const index = ++this.#spawnIndex;
		this.#agentCount += 1;
		const label = (opts.label ?? prompt.slice(0, 60)).replace(/\s+/g, " ").trim() || "agent";
		const phaseTitle = opts.phase ?? this.#currentPhase;

		await this.#semaphore.acquire();
		if (this.signal.aborted) {
			this.#semaphore.release();
			return null;
		}
		const agentId = await this.#opts.allocateId(label);
		const startedAt = Date.now();
		const agent = this.#opts.resolveAgent(opts.agentType);
		this.#opts.emit({ kind: "agent", runId: this.runId, index, label, phaseTitle, state: "start", agentId, model: opts.model });

		try {
			const result = await this.#opts.runSubprocess({
				cwd: this.cwd,
				agent,
				task: prompt,
				index,
				id: agentId,
				modelOverride: opts.model,
				outputSchema: opts.schema,
				signal: this.signal,
			} as ExecutorOptions);

			const tokens = result.usage?.output ?? 0;
			this.#tokensSpent += tokens;
			if (result.aborted) {
				this.#opts.emit({ kind: "agent", runId: this.runId, index, label, phaseTitle, state: "error", agentId, error: "aborted", durationMs: Date.now() - startedAt });
				return null;
			}
			this.#opts.emit({ kind: "agent", runId: this.runId, index, label, phaseTitle, state: "done", agentId, tokens, durationMs: Date.now() - startedAt });
			return result.output;
		} catch (error) {
			this.#opts.emit({
				kind: "agent",
				runId: this.runId,
				index,
				label,
				phaseTitle,
				state: "error",
				agentId,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startedAt,
			});
			throw error;
		} finally {
			this.#semaphore.release();
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test packages/coding-agent/test/workflow/engine.test.ts`. Expected: PASS. (The `("remote" as unknown)` guard avoids a TS narrowing error since `WorkflowAgentOpts.isolation` is `"worktree"`; keep it as the runtime guard for the not-yet-supported value.)
- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/workflow/engine.ts packages/coding-agent/test/workflow/engine.test.ts
git commit -m "feat(workflow): WorkflowRun engine with caps, semaphore, budget, spawn"
```

---

### Task 6: Runtime globals (agent/parallel/pipeline/phase/log/budget/workflow)

**Files:** Create `packages/coding-agent/src/workflow/runtime.ts`; Test `packages/coding-agent/test/workflow/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { createWorkflowGlobals } from "../../src/workflow/runtime";

function fakeGlobals(spawn: (p: string, o: unknown) => Promise<string | null>, args: unknown = {}) {
	const run = {
		spawn,
		nextPhase: () => {},
		log: () => {},
		budget: { total: null as number | null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
	};
	return createWorkflowGlobals(run as never, args, { runWorkflow: async () => "nested" });
}

describe("parallel", () => {
	it("is a barrier and maps thrown thunks to null", async () => {
		const g = fakeGlobals(async (p) => (p === "boom" ? Promise.reject(new Error("x")) : `ok:${p}`));
		expect(await g.parallel([() => g.agent("a"), () => g.agent("boom"), () => g.agent("b")])).toEqual(["ok:a", null, "ok:b"]);
	});
	it("rejects non-array input", async () => {
		await expect(fakeGlobals(async (p) => p).parallel("nope" as never)).rejects.toThrow(/array of functions/);
	});
});

describe("pipeline", () => {
	it("runs items through all stages, no barrier, passing (prev,item,index)", async () => {
		const seen: Array<[unknown, unknown, number]> = [];
		const g = fakeGlobals(async (p) => p);
		const out = await g.pipeline(
			["x", "y"],
			(item: string) => g.agent(`s1:${item}`),
			(prev: string, item: string, i: number) => {
				seen.push([prev, item, i]);
				return g.agent(`s2:${prev}`);
			},
		);
		expect(out).toEqual(["s2:s1:x", "s2:s1:y"]);
		expect(seen).toEqual([
			["s1:x", "x", 0],
			["s1:y", "y", 1],
		]);
	});
	it("drops a throwing item to null and skips remaining stages", async () => {
		const g = fakeGlobals(async (p) => (p.includes("y") ? Promise.reject(new Error("boom")) : p));
		const out = await g.pipeline(["x", "y"], (i: string) => g.agent(`s1:${i}`), (prev: string) => g.agent(`s2:${prev}`));
		expect(out[0]).toBe("s2:s1:x");
		expect(out[1]).toBeNull();
	});
	it("rejects non-array items", async () => {
		await expect(fakeGlobals(async (p) => p).pipeline("nope" as never)).rejects.toThrow(/array as the first argument/);
	});
});

describe("workflow()", () => {
	it("delegates to injected runWorkflow", async () => {
		expect(await fakeGlobals(async (p) => p).workflow("bugfix", { a: 1 })).toBe("nested");
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test packages/coding-agent/test/workflow/runtime.test.ts`. Expected: FAIL "Cannot find module ... runtime".

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Build the helper globals injected into a workflow script's VM context, bound to
 * a WorkflowRun. parallel() is a barrier; pipeline() runs each item through stages
 * with no barrier; both feed run.spawn() and inherit its concurrency/agent caps.
 */
import type { WorkflowRun } from "./engine";
import type { WorkflowAgentOpts } from "./types";

export interface WorkflowGlobalDeps {
	/** Run a sub-workflow inline (Phase 3 supplies the real impl; default throws). */
	runWorkflow?: (nameOrRef: string | { scriptPath: string }, args: unknown) => Promise<unknown>;
}

export interface WorkflowGlobals {
	agent: (prompt: string, opts?: WorkflowAgentOpts) => Promise<string | null>;
	parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<(T | null)[]>;
	pipeline: (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>) => Promise<unknown[]>;
	phase: (title: string) => void;
	log: (message: string) => void;
	budget: WorkflowRun["budget"];
	workflow: (nameOrRef: string | { scriptPath: string }, args?: unknown) => Promise<unknown>;
	args: unknown;
}

export function createWorkflowGlobals(run: WorkflowRun, args: unknown, deps: WorkflowGlobalDeps = {}): WorkflowGlobals {
	const agent = (prompt: string, opts: WorkflowAgentOpts = {}) => run.spawn(prompt, opts);

	const parallel = async <T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> => {
		if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
		const settled = await Promise.allSettled(thunks.map((t) => t()));
		return settled.map((r) => (r.status === "fulfilled" ? r.value : null));
	};

	const pipeline = async (
		items: unknown[],
		...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>
	): Promise<unknown[]> => {
		if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument.");
		// Each item flows through all stages independently — NO barrier between stages.
		const runItem = async (item: unknown, index: number): Promise<unknown> => {
			let acc: unknown = item;
			for (let s = 0; s < stages.length; s++) {
				try {
					acc = await stages[s](acc, item, index);
				} catch {
					return null; // drop this item; skip its remaining stages
				}
			}
			return acc;
		};
		return Promise.all(items.map(runItem));
	};

	const workflow = async (nameOrRef: string | { scriptPath: string }, subArgs?: unknown): Promise<unknown> => {
		if (!deps.runWorkflow) throw new Error("workflow() nesting is not available in this build.");
		return deps.runWorkflow(nameOrRef, subArgs);
	};

	return {
		agent,
		parallel,
		pipeline,
		phase: (title: string) => run.nextPhase(title),
		log: (message: string) => run.log(message),
		budget: run.budget,
		workflow,
		args,
	};
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test packages/coding-agent/test/workflow/runtime.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/workflow/runtime.ts packages/coding-agent/test/workflow/runtime.test.ts
git commit -m "feat(workflow): script API globals (agent/parallel/pipeline/phase/log/budget/workflow)"
```

---

### Task 7: Bundled `workflow-subagent` agent + system prompt

**Files:**
- Create: `packages/coding-agent/src/prompts/agents/workflow-subagent.md`
- Modify: `packages/coding-agent/src/task/agents.ts` (add to `EMBEDDED_AGENT_DEFS` at `:46-108`)
- Test: `packages/coding-agent/test/workflow/subagent-agent.test.ts`

- [ ] **Step 1: Write the system prompt file**

`packages/coding-agent/src/prompts/agents/workflow-subagent.md`:

```markdown
You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the assigned task precisely.

NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.

If a structured output schema is provided, you MUST return your final answer by calling the StructuredOutput/yield tool with data matching that schema, not as free text.
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { getBundledAgent } from "../../src/task/agents";

describe("workflow-subagent bundled agent", () => {
	it("is registered with a wide tool set and is not spawn-capable", () => {
		const agent = getBundledAgent("workflow-subagent");
		expect(agent).toBeDefined();
		expect(agent?.source).toBe("bundled");
		// Not spawn-capable → the `task` tool is NOT auto-added inside a workflow subagent.
		expect(agent?.spawns).toBeUndefined();
		expect(agent?.systemPrompt).toContain("workflow orchestration script");
	});
});
```

- [ ] **Step 3: Run test to verify it fails** — `bun test packages/coding-agent/test/workflow/subagent-agent.test.ts`. Expected: FAIL (agent undefined).

- [ ] **Step 4: Wire the bundled agent**

In `packages/coding-agent/src/task/agents.ts`, add the import near the other agent-prompt imports (after `:10`):

```typescript
import workflowSubagentMd from "../prompts/agents/workflow-subagent.md" with { type: "text" };
```

Append to the `EMBEDDED_AGENT_DEFS` array (before the closing `]` at `:108`):

```typescript
	{
		fileName: "workflow-subagent.md",
		frontmatter: {
			name: "workflow-subagent",
			description: "Internal subagent for workflow script orchestration.",
		},
		template: workflowSubagentMd,
	},
```

> `tools` is intentionally omitted so the subagent gets the default capable tool set (the same default the bundled implementer agents use). `spawns` is omitted so workflow subagents cannot spawn the `task` tool — nesting is governed by the workflow engine, not subagent recursion.

- [ ] **Step 5: Run test to verify it passes** — `bun test packages/coding-agent/test/workflow/subagent-agent.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/prompts/agents/workflow-subagent.md packages/coding-agent/src/task/agents.ts packages/coding-agent/test/workflow/subagent-agent.test.ts
git commit -m "feat(workflow): bundled workflow-subagent agent + system prompt"
```

---

# Phase 2 — Tool, background execution, settings, registration

### Task 8: Settings keys for the workflow subsystem

**Files:** Modify `packages/coding-agent/src/config/settings-schema.ts` (mirror the `task.*` block at `:2475`)

- [ ] **Step 1: Add the settings keys**

Insert next to the `task.*` keys (after `task.maxRecursionDepth` ends, near `:2521`):

```typescript
	"workflow.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			label: "Workflow Orchestration",
			description:
				"Enable the Workflow tool: deterministic multi-subagent orchestration scripts. Off by default — workflows can spawn many agents and consume significant tokens.",
		},
	},
	"workflow.maxConcurrency": {
		type: "number",
		default: 0,
		ui: {
			tab: "tasks",
			label: "Workflow Max Concurrency",
			description: "Concurrent agent() cap per workflow. 0 = auto (min(16, cores-2)).",
			options: [
				{ value: "0", label: "Auto" },
				{ value: "2", label: "2" },
				{ value: "4", label: "4" },
				{ value: "8", label: "8" },
				{ value: "16", label: "16" },
			],
		},
	},
	"workflow.tokenBudget": {
		type: "number",
		default: 0,
		ui: {
			tab: "tasks",
			label: "Workflow Token Budget",
			description: "Hard ceiling on subagent output tokens per workflow. 0 = no budget (budget.total is null).",
		},
	},
```

- [ ] **Step 2: Typecheck** — `bun check`. Expected: PASS (the settings schema validates literal shapes at compile time).
- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/src/config/settings-schema.ts
git commit -m "feat(workflow): settings keys (enabled, maxConcurrency, tokenBudget)"
```

---

### Task 9: Widen `AsyncJobManager` to accept `"workflow"` jobs

**Files:** Modify `packages/coding-agent/src/async/job-manager.ts` (`AsyncJob.type` at `:11`, `register(type, ...)` at `:113`)

- [ ] **Step 1: Update the type union**

At `:11`, change:

```typescript
	type: "bash" | "task";
```
to:
```typescript
	type: "bash" | "task" | "workflow";
```

At `:113-114`, change the `register` signature:

```typescript
	register(
		type: "bash" | "task" | "workflow",
```

- [ ] **Step 2: Typecheck** — `bun check`. Expected: PASS. Search for other places that narrow on `job.type === "bash" | "task"` and confirm they tolerate the new variant (most switch on `bash` vs everything-else; verify the stats/render paths do not assert exhaustiveness).

Run: `bun check`

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/src/async/job-manager.ts
git commit -m "feat(workflow): allow 'workflow' async job type"
```

---

### Task 10: Model-facing tool description

**Files:** Create `packages/coding-agent/src/prompts/tools/workflow.md`

- [ ] **Step 1: Write the prompt (Handlebars; the `{{#if}}`/`{{#each}}` blocks are rendered by `prompt.render` in Task 11)**

```markdown
Execute a deterministic JavaScript workflow that orchestrates multiple subagents. Runs in the background — returns immediately with a run id; a notification arrives on completion. Watch live progress with `/workflows`.

## When to use
Use ONLY when the user explicitly asks to "run a workflow", "orchestrate with subagents", "fan out agents", or names a saved workflow. Do not infer it for a task that would merely benefit from parallelism — workflows spawn many agents and consume significant tokens.

## Parameters
- `script`: inline JS workflow (see format below).
- `scriptPath`: path to a persisted script (overrides `script`) — used to resume/iterate.
- `name`: a saved/bundled workflow to run.{{#if namedWorkflows}}\n  Available: {{namedWorkflows}}.{{/if}}
- `args`: value exposed to the script as the `args` global.
- `resumeFromRunId`: resume a prior run; the longest unchanged prefix of `agent()` calls returns cached results.

## Script format
Begin with a PURE LITERAL `export const meta = { name, description }` (optional `whenToUse`, `phases`), then the body using these globals:

- `agent(prompt, opts?)` → subagent. Without `schema`, returns its final text (string). With `schema` (a JSON Schema object), the subagent is forced to return structured data and `agent()` returns the validated object. Returns `null` if skipped — filter with `.filter(Boolean)`. `opts`: `{ label, phase, schema, model, agentType }`.
- `parallel(thunks)` → BARRIER. Awaits an array of `() => Promise` thunks. A throwing thunk resolves to `null` (never rejects). Use ONLY when you need all results together.
- `pipeline(items, stage1, stage2, ...)` → NO barrier. Each item flows through all stages independently. Each stage gets `(prevResult, originalItem, index)`. A throwing stage drops that item to `null`. This is the DEFAULT for multi-stage work.
- `phase(title)` → start a new progress group.
- `log(message)` → narrator line shown above the progress tree.
- `budget` → `{ total, spent(), remaining() }`. `total` is null if no budget set; once `spent() >= total`, `agent()` throws. Guard loops: `while (budget.total && budget.remaining() > 50000) { ... }`.
- `args` → the `args` you passed.

## Constraints
- Concurrent `agent()` calls are capped at `min(16, cores-2)`; excess queue. Lifetime agent count is capped at 1000.
- `Date.now()`, `new Date()` (no args), and `Math.random()` are unavailable (they break resume). Pass timestamps/seeds via `args`.
- The script's top-level `return` value (if any) becomes the workflow's result.
```

- [ ] **Step 2: Commit**

```bash
git add packages/coding-agent/src/prompts/tools/workflow.md
git commit -m "feat(workflow): model-facing tool description prompt"
```

---

### Task 11: `WorkflowTool` (background execution)

**Files:** Create `packages/coding-agent/src/workflow/index.ts`; Test `packages/coding-agent/test/workflow/tool.test.ts`

The tool: validate inputs → resolve source → `validateSyntax` + `extractMeta`/`validateMeta` → persist script → allocate `runId` → register an async `"workflow"` job that builds the `WorkflowRun` and runs the script → return immediately with the run id.

- [ ] **Step 1: Write the failing test (synchronous validation paths, no real subagents)**

```typescript
import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { WorkflowTool } from "../../src/workflow";

function session(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "workflow.enabled": true }),
		...overrides,
	} as ToolSession;
}

describe("WorkflowTool input validation", () => {
	it("rejects when no source is provided", async () => {
		const tool = await WorkflowTool.create(session());
		const res = await tool.execute("id", {});
		expect(res.content[0]?.type).toBe("text");
		expect((res.content[0] as { text: string }).text).toContain("Provide one of");
	});
	it("rejects a script with a syntax error", async () => {
		const tool = await WorkflowTool.create(session());
		const res = await tool.execute("id", { script: "export const meta = { name: 'x' " });
		expect((res.content[0] as { text: string }).text).toContain("SyntaxError");
	});
	it("rejects a script with a non-literal meta", async () => {
		const tool = await WorkflowTool.create(session());
		const res = await tool.execute("id", { script: "export const meta = { name: makeName(), description: 'd' };\n" });
		expect((res.content[0] as { text: string }).text).toContain("PURE LITERAL");
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test packages/coding-agent/test/workflow/tool.test.ts`. Expected: FAIL "Cannot find module ... workflow".

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Workflow tool — runs a deterministic orchestration script in the background.
 */
import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async";
import { MCPManager } from "../mcp/manager";
import type { ToolSession } from "../tools";
import workflowDescription from "../prompts/tools/workflow.md" with { type: "text" };
import { getBundledAgent } from "../task/agents";
import { discoverAgents, getAgent } from "../task/discovery";
import { runSubprocess } from "../task/executor";
import { AgentOutputManager } from "../task/output-manager";
import type { AgentDefinition } from "../task/types";
import { WorkflowRun, workflowConcurrency } from "./engine";
import { extractMeta, validateMeta } from "./meta";
import { createWorkflowGlobals } from "./runtime";
import { runWorkflowScript, validateSyntax } from "./sandbox";
import { persistWorkflowScript, readWorkflowScript, subagentTranscriptDir } from "./storage";
import {
	type WorkflowMeta,
	type WorkflowParams,
	type WorkflowProgressFrame,
	WORKFLOW_PROGRESS_CHANNEL,
	type WorkflowToolDetails,
	workflowSchema,
} from "./types";

function textResult(text: string, details: WorkflowToolDetails): AgentToolResult<WorkflowToolDetails> {
	return { content: [{ type: "text", text }], details };
}
function emptyDetails(runId: string): WorkflowToolDetails {
	return { runId, phases: [], agents: [], logs: [] };
}

export class WorkflowTool implements AgentTool<typeof workflowSchema, WorkflowToolDetails> {
	readonly name = "Workflow";
	readonly approval = "exec" as const;
	readonly label = "Workflow";
	readonly summary = "Orchestrate subagents with a deterministic workflow script";
	readonly loadMode = "discoverable";
	readonly description: string;
	readonly parameters = workflowSchema;
	readonly strict = true;
	readonly #agents: AgentDefinition[];

	private constructor(
		private readonly session: ToolSession,
		agents: AgentDefinition[],
	) {
		this.#agents = agents;
		// Phase 3 enriches this with discovered named workflows.
		this.description = prompt.render(workflowDescription, { namedWorkflows: "" });
	}

	static async create(session: ToolSession): Promise<WorkflowTool> {
		const { agents } = await discoverAgents(session.cwd);
		return new WorkflowTool(session, agents);
	}

	/** Resolve the source for this invocation. */
	async #resolveSource(params: WorkflowParams): Promise<{ source?: string; error?: string }> {
		if (params.scriptPath) return readWorkflowScript(params.scriptPath);
		if (params.script) return { source: params.script };
		// Phase 3: resolve `name` via discoverWorkflows(); for now report unsupported.
		if (params.name) return { error: `Named workflows are not available yet: "${params.name}".` };
		return { error: "Provide one of `script`, `scriptPath`, or `name`." };
	}

	#resolveAgent = (agentType: string | undefined): AgentDefinition => {
		const fallback = getBundledAgent("workflow-subagent");
		if (!fallback) throw new Error("workflow-subagent agent is not registered.");
		if (!agentType) return fallback;
		const found = getAgent(this.#agents, agentType);
		if (!found) throw new Error(`agent({agentType}): '${agentType}' not found. Available: ${this.#agents.map((a) => a.name).join(", ")}`);
		return found;
	};

	async execute(
		_toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WorkflowToolDetails>,
	): Promise<AgentToolResult<WorkflowToolDetails>> {
		const params = rawParams as WorkflowParams;
		const runId = params.resumeFromRunId ?? randomUUID();

		const resolved = await this.#resolveSource(params);
		if (resolved.error || !resolved.source) return textResult(resolved.error ?? "No workflow source.", emptyDetails(runId));
		const source = resolved.source;

		const syntax = validateSyntax(source);
		if (!syntax.ok) return textResult(`Workflow script has a syntax error: ${syntax.error}`, emptyDetails(runId));

		const { meta, metaError } = extractMeta(source);
		if (metaError || !meta) return textResult(metaError ?? "Invalid meta.", emptyDetails(runId));
		const metaValidation = validateMeta(meta);
		if (metaValidation) return textResult(metaValidation, emptyDetails(runId));

		const artifactsDir = this.session.getArtifactsDir?.() ?? null;
		const scriptPath = artifactsDir ? await persistWorkflowScript(artifactsDir, meta.name, runId, source) : undefined;

		const manager = AsyncJobManager.instance();
		if (!manager) return textResult("No async job manager available; workflows require background execution.", { ...emptyDetails(runId), meta, scriptPath });

		const details: WorkflowToolDetails = { runId, scriptPath, meta, phases: [], agents: [], logs: [], async: { state: "running", jobId: runId, type: "workflow" } };

		const jobId = manager.register(
			"workflow",
			`workflow:${meta.name}`,
			async ({ signal: jobSignal }) => {
				return this.#runScript(source, runId, meta, params.args, jobSignal, artifactsDir);
			},
			{ id: runId, ownerId: this.session.getAgentId?.() ?? undefined },
		);
		details.async = { state: "running", jobId, type: "workflow" };

		const resumeNote = `\nTo resume after editing: Workflow({scriptPath: "${scriptPath ?? "<path>"}", resumeFromRunId: "${runId}"})`;
		return textResult(
			`Workflow "${meta.name}" launched in background. Run id: ${runId}. Watch progress with /workflows.${scriptPath ? `\nScript: ${scriptPath}${resumeNote}` : ""}`,
			details,
		);
	}

	/** Build a WorkflowRun and execute the script. Returns the final notification text. */
	async #runScript(
		source: string,
		runId: string,
		meta: WorkflowMeta,
		args: unknown,
		signal: AbortSignal,
		artifactsDir: string | null,
	): Promise<string> {
		const configured = this.session.settings.get("workflow.maxConcurrency") as number;
		const concurrency = configured && configured > 0 ? configured : workflowConcurrency();
		const budgetSetting = this.session.settings.get("workflow.tokenBudget") as number;
		const budgetTotal = budgetSetting && budgetSetting > 0 ? budgetSetting : null;

		const outputManager = this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		const emit = (frame: WorkflowProgressFrame) => this.session.eventBus?.emit(WORKFLOW_PROGRESS_CHANNEL, frame);

		const run = new WorkflowRun({
			runId,
			cwd: this.session.cwd,
			concurrency,
			budgetTotal,
			signal,
			allocateId: (label) => outputManager.allocate(label),
			emit,
			resolveAgent: this.#resolveAgent,
			runSubprocess: (options) =>
				runSubprocess({
					// Mirror task/index.ts:989-1031 — keep this wiring in sync with the task tool.
					...options,
					assignment: options.task,
					taskDepth: (this.session.taskDepth ?? 0) + 1,
					parentActiveModelPattern: this.session.getActiveModelString?.(),
					persistArtifacts: !!artifactsDir,
					artifactsDir: artifactsDir ? subagentTranscriptDir(artifactsDir, runId) : undefined,
					eventBus: this.session.eventBus,
					authStorage: this.session.authStorage,
					modelRegistry: this.session.modelRegistry,
					settings: this.session.settings,
					mcpManager: MCPManager.instance(),
					contextFiles: this.session.contextFiles,
					skills: this.session.skills,
					workspaceTree: this.session.workspaceTree,
					promptTemplates: this.session.promptTemplates,
					localProtocolOptions: {
						getArtifactsDir: this.session.getArtifactsDir ?? (() => null),
						getSessionId: this.session.getSessionId ?? (() => null),
					},
					parentArtifactManager: this.session.getArtifactManager?.() ?? undefined,
					parentHindsightSessionState: this.session.getHindsightSessionState?.(),
					parentEvalSessionId: this.session.getEvalSessionId?.() ?? undefined,
				}),
		});

		const globals = createWorkflowGlobals(run, args);
		try {
			const result = await runWorkflowScript(source, globals as unknown as Record<string, unknown>, args);
			const text = typeof result === "string" ? result : result === undefined ? "(workflow completed)" : JSON.stringify(result);
			return `Workflow "${meta.name}" (${runId}) completed.\n${text}`;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return `Workflow "${meta.name}" (${runId}) failed: ${msg}`;
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test packages/coding-agent/test/workflow/tool.test.ts`. Expected: PASS. If `AsyncJobManager` import path differs, confirm `../async` exports it (`async/index.ts:1`). If `MCPManager.instance()` is not the right accessor, confirm against `task/index.ts:1020`.
- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/workflow/index.ts packages/coding-agent/test/workflow/tool.test.ts
git commit -m "feat(workflow): WorkflowTool with background execution"
```

---

### Task 12: Register the tool + gate it

**Files:** Modify `packages/coding-agent/src/tools/index.ts` (registry at `:279`, gate at `:472`)

- [ ] **Step 1: Add the import + barrel export**

Near the other tool imports (after `:54`):

```typescript
import { WorkflowTool } from "../workflow";
```
Near the barrel exports (after `:65`):
```typescript
export * from "../workflow";
```

- [ ] **Step 2: Register in `BUILTIN_TOOLS`** (inside the object literal `:279-310`, after the `task` entry):

```typescript
	Workflow: s => WorkflowTool.create(s),
```

- [ ] **Step 3: Gate availability** — in the availability function near `:472` (where `task` recursion is gated), add before the final `return true;`:

```typescript
		if (name === "Workflow") {
			// Only top-level sessions may launch workflows; subagents cannot recurse into workflows.
			return session.settings.get("workflow.enabled") === true && (session.taskDepth ?? 0) === 0;
		}
```

- [ ] **Step 4: Typecheck + run all workflow tests** —

Run: `bun check`
Run: `bun test packages/coding-agent/test/workflow/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/tools/index.ts
git commit -m "feat(workflow): register Workflow tool and gate behind workflow.enabled"
```

---

### Task 13: End-to-end smoke (real subagents, real VM)

**Files:** Test `packages/coding-agent/test/workflow/e2e.test.ts`

This exercises the full path with the real `WorkflowRun` + `runWorkflowScript`, stubbing only `runSubprocess` via the engine's injection seam (so no network/model is hit), proving phase/agent/log frames and pipeline+parallel composition flow through the VM.

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from "bun:test";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import { WorkflowRun, workflowConcurrency } from "../../src/workflow/engine";
import { createWorkflowGlobals } from "../../src/workflow/runtime";
import { runWorkflowScript } from "../../src/workflow/sandbox";
import type { WorkflowProgressFrame } from "../../src/workflow/types";

describe("workflow end-to-end (stubbed subprocess)", () => {
	it("drives phases, pipeline, parallel, and returns a synthesis", async () => {
		const frames: WorkflowProgressFrame[] = [];
		let n = 0;
		const run = new WorkflowRun({
			runId: "e2e",
			cwd: process.cwd(),
			concurrency: workflowConcurrency(),
			budgetTotal: null,
			signal: new AbortController().signal,
			allocateId: async (l) => `${n++}-${l}`,
			emit: (f) => frames.push(f),
			resolveAgent: () => ({ name: "workflow-subagent" }) as AgentDefinition,
			runSubprocess: async (o) => ({ index: o.index, id: o.id, output: `R(${o.task})`, usage: { output: 5 } } as SingleResult),
		});
		const globals = createWorkflowGlobals(run, { topics: ["a", "b"] });

		const script = `
export const meta = { name: "demo", description: "demo", phases: ["scan", "synthesize"] };
phase("scan");
const scanned = await pipeline(args.topics, t => agent("scan:" + t), r => agent("verify:" + r));
phase("synthesize");
const merged = await parallel(scanned.map(s => () => agent("merge:" + s)));
return merged.filter(Boolean).join(" | ");
`;
		const result = await runWorkflowScript(script, globals as unknown as Record<string, unknown>, { topics: ["a", "b"] });
		expect(result).toBe("R(merge:R(verify:R(scan:a))) | R(merge:R(verify:R(scan:b)))");
		expect(frames.filter((f) => f.kind === "phase").map((f) => (f as { title: string }).title)).toEqual(["scan", "synthesize"]);
		expect(frames.filter((f) => f.kind === "agent" && f.state === "done").length).toBe(6); // 2 scan + 2 verify + 2 merge
	});
});
```

- [ ] **Step 2: Run test to verify it passes** — `bun test packages/coding-agent/test/workflow/e2e.test.ts`. Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/test/workflow/e2e.test.ts
git commit -m "test(workflow): end-to-end pipeline/parallel/phase composition"
```

---

# Phase 3 — Discovery, named/bundled workflows, `/workflows` UI

### Task 14: Workflow discovery (`.omp/workflows/*.js` + bundled)

**Files:** Create `packages/coding-agent/src/workflow/discovery.ts`; Create `packages/coding-agent/src/workflow/bundled/bugfix.js`, `.../investigate.js`; Test `packages/coding-agent/test/workflow/discovery.test.ts`

- [ ] **Step 1: Write the bundled scripts**

`packages/coding-agent/src/workflow/bundled/bugfix.js`:

```javascript
export const meta = {
	name: "bugfix",
	description: "Reproduce-first bug fixer: reproduce, root-cause, fix, regression-test.",
	whenToUse: "When the user asks to fix a specific bug and wants a thorough, verified fix.",
	phases: ["reproduce", "root-cause", "fix", "verify"],
};

const REPORT = {
	properties: { rootCause: { type: "string" }, plan: { type: "string" } },
	optionalProperties: { files: { elements: { type: "string" } } },
};

phase("reproduce");
const repro = await agent(
	"Reproduce this bug and describe the exact failing command/output. Bug: " + args.bug,
	{ label: "reproduce", agentType: "quick_task" },
);

phase("root-cause");
const diagnosis = await agent(
	"Given this reproduction, find the root cause. Cite files and lines. Reproduction:\n" + repro,
	{ label: "root-cause", schema: REPORT, agentType: "task" },
);

phase("fix");
const fix = await agent(
	"Implement the fix and a regression test. Root cause: " + JSON.stringify(diagnosis),
	{ label: "fix", agentType: "task" },
);

phase("verify");
const verdict = await agent(
	"Verify the fix resolves the original reproduction and the regression test passes. Fix summary:\n" + fix,
	{ label: "verify", agentType: "reviewer" },
);

return "Root cause: " + (diagnosis && diagnosis.rootCause) + "\nFix:\n" + fix + "\nVerification:\n" + verdict;
```

`packages/coding-agent/src/workflow/bundled/investigate.js`:

```javascript
export const meta = {
	name: "investigate",
	description: "Root-cause investigation: gather, hypothesize in parallel, refute, report.",
	whenToUse: "When the user asks why something happens or wants a grounded cross-file explanation.",
	phases: ["gather", "hypothesize", "verify"],
};

phase("gather");
const evidence = await agent("Gather all relevant evidence for: " + args.question, { label: "gather", agentType: "explore" });

phase("hypothesize");
const ANGLES = ["data-flow", "config", "concurrency"];
const hypotheses = await parallel(
	ANGLES.map((angle) => () =>
		agent("Propose a root-cause hypothesis from the " + angle + " angle. Evidence:\n" + evidence, { label: angle, agentType: "task" }),
	),
);

phase("verify");
const verdicts = await parallel(
	hypotheses.filter(Boolean).map((h) => () =>
		agent("Try to REFUTE this hypothesis with evidence. If it survives, say so. Hypothesis:\n" + h, { label: "refute", agentType: "reviewer" }),
	),
);

return "Question: " + args.question + "\nSurviving analysis:\n" + verdicts.filter(Boolean).join("\n---\n");
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { discoverWorkflows, getWorkflowSource } from "../../src/workflow/discovery";

describe("discoverWorkflows", () => {
	it("includes bundled workflows", async () => {
		const found = await discoverWorkflows(process.cwd());
		const names = found.map((w) => w.name);
		expect(names).toContain("bugfix");
		expect(names).toContain("investigate");
	});
	it("discovers project-level .omp/workflows/*.js and gives it precedence", async () => {
		await using dir = await TempDir.create("wf-disc");
		await fs.mkdir(path.join(dir.path, ".omp", "workflows"), { recursive: true });
		await Bun.write(path.join(dir.path, ".omp", "workflows", "bugfix.js"), "export const meta={name:'bugfix',description:'custom'};");
		const found = await discoverWorkflows(dir.path);
		const bugfix = found.find((w) => w.name === "bugfix");
		expect(bugfix?.source).toBe("project");
	});
	it("getWorkflowSource returns source for a bundled name", async () => {
		const r = await getWorkflowSource(process.cwd(), "bugfix");
		expect(r.source).toContain('name: "bugfix"');
	});
});
```

- [ ] **Step 3: Run test to verify it fails** — `bun test packages/coding-agent/test/workflow/discovery.test.ts`. Expected: FAIL "Cannot find module ... discovery".

- [ ] **Step 4: Write the implementation**

```typescript
/**
 * Discover workflows: bundled (embedded) + project (.omp/workflows/*.js) +
 * user (~/.omp/agent/workflows/*.js). Project shadows user shadows bundled, by name.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import bugfixScript from "./bundled/bugfix.js" with { type: "text" };
import investigateScript from "./bundled/investigate.js" with { type: "text" };
import { extractMeta } from "./meta";
import { readWorkflowScript } from "./storage";
import type { WorkflowMeta, WorkflowSource } from "./types";

export interface DiscoveredWorkflow {
	name: string;
	description: string;
	whenToUse?: string;
	source: WorkflowSource;
	/** Absolute path for disk workflows; undefined for bundled. */
	filePath?: string;
	/** Inline source for bundled workflows. */
	bundledSource?: string;
}

const BUNDLED: Array<{ source: string }> = [{ source: bugfixScript }, { source: investigateScript }];

function toMeta(source: string): WorkflowMeta | undefined {
	return extractMeta(source).meta;
}

async function loadDir(dir: string, source: WorkflowSource): Promise<DiscoveredWorkflow[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const out: DiscoveredWorkflow[] = [];
	for (const entry of entries) {
		if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith(".js")) continue;
		const filePath = path.join(dir, entry.name);
		const { script } = await readWorkflowScript(filePath);
		const meta = script ? toMeta(script) : undefined;
		if (!meta) continue;
		out.push({ name: meta.name, description: meta.description, whenToUse: meta.whenToUse, source, filePath });
	}
	return out;
}

export async function discoverWorkflows(cwd: string, home: string = os.homedir()): Promise<DiscoveredWorkflow[]> {
	const byName = new Map<string, DiscoveredWorkflow>();
	for (const { source } of BUNDLED) {
		const meta = toMeta(source);
		if (meta) byName.set(meta.name, { name: meta.name, description: meta.description, whenToUse: meta.whenToUse, source: "bundled", bundledSource: source });
	}
	for (const w of await loadDir(path.join(home, ".omp", "agent", "workflows"), "user")) byName.set(w.name, w);
	for (const w of await loadDir(path.join(cwd, ".omp", "workflows"), "project")) byName.set(w.name, w);
	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export interface WorkflowSourceResult {
	source?: string;
	error?: string;
}

/** Resolve a workflow name to its script source (project > user > bundled). */
export async function getWorkflowSource(cwd: string, name: string, home: string = os.homedir()): Promise<WorkflowSourceResult> {
	const found = (await discoverWorkflows(cwd, home)).find((w) => w.name === name);
	if (!found) return { error: `Unknown workflow: "${name}".` };
	if (found.bundledSource) return { source: found.bundledSource };
	if (found.filePath) return readWorkflowScript(found.filePath);
	return { error: `Workflow "${name}" has no readable source.` };
}
```

- [ ] **Step 5: Run test to verify it passes** — `bun test packages/coding-agent/test/workflow/discovery.test.ts`. Expected: PASS. Confirm `with { type: "text" }` import of `.js` works in this build (the bundler treats it as a raw asset; bundled agents use the same pattern for `.md` at `task/agents.ts:10`). If `.js`-as-text is rejected, rename the bundled scripts to `.js.txt` and update the imports.
- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/workflow/discovery.ts packages/coding-agent/src/workflow/bundled/ packages/coding-agent/test/workflow/discovery.test.ts
git commit -m "feat(workflow): discovery + bundled bugfix/investigate workflows"
```

---

### Task 15: Wire discovery into `WorkflowTool` (named workflows + `workflow()` nesting)

**Files:** Modify `packages/coding-agent/src/workflow/index.ts`

- [ ] **Step 1: Add the failing test** (append to `packages/coding-agent/test/workflow/tool.test.ts`)

```typescript
it("resolves a bundled workflow name and launches it", async () => {
	const tool = await WorkflowTool.create(session());
	const res = await tool.execute("id", { name: "investigate", args: { question: "why?" } });
	const text = (res.content[0] as { text: string }).text;
	expect(text).toContain("launched in background");
	expect(res.details?.meta?.name).toBe("investigate");
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test packages/coding-agent/test/workflow/tool.test.ts`. Expected: FAIL ("Named workflows are not available yet").

- [ ] **Step 3: Replace `#resolveSource` to use discovery**

Add the import in `index.ts` (after the other workflow imports):

```typescript
import { discoverWorkflows, getWorkflowSource } from "./discovery";
```

Replace the `#resolveSource` method body so `name` resolves via discovery:

```typescript
	async #resolveSource(params: WorkflowParams): Promise<{ source?: string; error?: string }> {
		if (params.scriptPath) return readWorkflowScript(params.scriptPath);
		if (params.script) return { source: params.script };
		if (params.name) return getWorkflowSource(this.session.cwd, params.name);
		return { error: "Provide one of `script`, `scriptPath`, or `name`." };
	}
```

- [ ] **Step 4: Enable `workflow()` nesting** — in `#runScript`, build globals with a `runWorkflow` dep that resolves a name or scriptPath and runs it inline on the SAME `WorkflowRun` (shared caps/counter/budget/signal). Replace the `createWorkflowGlobals(run, args)` line with:

```typescript
		let nestingActive = false;
		const globals = createWorkflowGlobals(run, args, {
			runWorkflow: async (nameOrRef, subArgs) => {
				if (nestingActive) throw new Error("workflow() nesting is one level only.");
				nestingActive = true;
				try {
					const sub =
						typeof nameOrRef === "string"
							? await getWorkflowSource(this.session.cwd, nameOrRef)
							: await readWorkflowScript(nameOrRef.scriptPath);
					if (sub.error || !sub.source) throw new Error(sub.error ?? "Unreadable sub-workflow.");
					const subValidate = validateSyntax(sub.source);
					if (!subValidate.ok) throw new Error(`Sub-workflow syntax error: ${subValidate.error}`);
					const subGlobals = createWorkflowGlobals(run, subArgs);
					return await runWorkflowScript(sub.source, subGlobals as unknown as Record<string, unknown>, subArgs);
				} finally {
					nestingActive = false;
				}
			},
		});
```

- [ ] **Step 5: Populate the named-workflows hint in the description** — change the constructor to accept discovered names and render them. Update `create()`:

```typescript
	static async create(session: ToolSession): Promise<WorkflowTool> {
		const [{ agents }, workflows] = await Promise.all([discoverAgents(session.cwd), discoverWorkflows(session.cwd)]);
		return new WorkflowTool(session, agents, workflows.map((w) => w.name));
	}
```
And change the constructor signature + description render:
```typescript
	private constructor(
		private readonly session: ToolSession,
		agents: AgentDefinition[],
		workflowNames: string[],
	) {
		this.#agents = agents;
		this.description = prompt.render(workflowDescription, { namedWorkflows: workflowNames.join(", ") });
	}
```
(Add `import { discoverWorkflows } from "./discovery";` — already added in Step 3 — and `DiscoveredWorkflow` is not needed here.)

- [ ] **Step 6: Run to verify it passes** — `bun test packages/coding-agent/test/workflow/tool.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/src/workflow/index.ts packages/coding-agent/test/workflow/tool.test.ts
git commit -m "feat(workflow): named workflow resolution + one-level workflow() nesting"
```

---

### Task 16: `/workflows` slash command + live progress render

**Files:**
- Create: `packages/coding-agent/src/workflow/render.ts`
- Modify: `packages/coding-agent/src/slash-commands/builtin-registry.ts` (registry array at `:601`)
- Test: `packages/coding-agent/test/workflow/render.test.ts`

- [ ] **Step 1: Write the failing test (pure render of frames → tree text)**

```typescript
import { describe, expect, it } from "bun:test";
import { renderWorkflowTree } from "../../src/workflow/render";
import type { WorkflowProgressFrame } from "../../src/workflow/types";

describe("renderWorkflowTree", () => {
	it("groups agents under phases and shows states", () => {
		const frames: WorkflowProgressFrame[] = [
			{ kind: "phase", runId: "r", index: 1, title: "scan" },
			{ kind: "agent", runId: "r", index: 1, label: "scan:a", phaseTitle: "scan", state: "start", agentId: "0-scan" },
			{ kind: "agent", runId: "r", index: 1, label: "scan:a", phaseTitle: "scan", state: "done", agentId: "0-scan", durationMs: 120 },
			{ kind: "log", runId: "r", message: "1 found" },
		];
		const text = renderWorkflowTree(frames);
		expect(text).toContain("scan");
		expect(text).toContain("scan:a");
		expect(text).toContain("done");
		expect(text).toContain("1 found");
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test packages/coding-agent/test/workflow/render.test.ts`. Expected: FAIL "Cannot find module ... render".

- [ ] **Step 3: Write the implementation** (plain-text reducer first; the TUI component can wrap it later)

```typescript
/** Render a flat list of workflow progress frames into a phase→agent tree (plain text). */
import type { WorkflowProgressFrame } from "./types";

export function renderWorkflowTree(frames: WorkflowProgressFrame[]): string {
	const phases = new Map<string, string[]>();
	const order: string[] = [];
	const latestByIndex = new Map<number, Extract<WorkflowProgressFrame, { kind: "agent" }>>();
	const logs: string[] = [];

	for (const f of frames) {
		if (f.kind === "phase") {
			if (!phases.has(f.title)) {
				phases.set(f.title, []);
				order.push(f.title);
			}
		} else if (f.kind === "log") {
			logs.push(f.message);
		} else {
			latestByIndex.set(f.index, f); // last state wins (start→done/error)
		}
	}

	const noPhase = "(no phase)";
	for (const f of latestByIndex.values()) {
		const key = f.phaseTitle ?? noPhase;
		if (!phases.has(key)) {
			phases.set(key, []);
			order.push(key);
		}
		const dur = f.durationMs != null ? ` ${Math.round(f.durationMs)}ms` : "";
		const err = f.error ? ` — ${f.error}` : "";
		phases.get(key)?.push(`  [${f.state}] ${f.label}${dur}${err}`);
	}

	const lines: string[] = [];
	for (const log of logs) lines.push(`» ${log}`);
	for (const title of order) {
		const rows = phases.get(title) ?? [];
		lines.push(`▸ ${title}`);
		lines.push(...rows);
	}
	return lines.join("\n");
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test packages/coding-agent/test/workflow/render.test.ts`. Expected: PASS.

- [ ] **Step 5: Register the `/workflows` slash command** — in `builtin-registry.ts`, add an entry to `BUILTIN_SLASH_COMMAND_REGISTRY` next to `agents` (`:601`). The handler subscribes the interactive UI to `WORKFLOW_PROGRESS_CHANNEL` and renders with `renderWorkflowTree`. Add the import at the top of the file:

```typescript
import { renderWorkflowTree } from "../workflow/render";
import { WORKFLOW_PROGRESS_CHANNEL, type WorkflowProgressFrame } from "../workflow/types";
```
Add the registry entry:
```typescript
	{
		name: "workflows",
		description: "Show live workflow orchestration progress",
		handleTui: (_command, runtime) => {
			runtime.ctx.showWorkflowsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
```

- [ ] **Step 6: Add the dashboard hook to the interactive context** — in `packages/coding-agent/src/modes/types.ts` add `showWorkflowsDashboard(): void` to `InteractiveModeContext`, and implement it in `packages/coding-agent/src/modes/interactive-mode.ts` by collecting frames from the session `eventBus` on `WORKFLOW_PROGRESS_CHANNEL` into a buffer and rendering `renderWorkflowTree(buffer)` in a scrollable panel (mirror the existing `showAgentsDashboard` implementation that `/agents` uses — search `showAgentsDashboard` in `interactive-mode.ts` for the panel pattern to copy).

- [ ] **Step 7: Typecheck + run workflow tests** —

Run: `bun check`
Run: `bun test packages/coding-agent/test/workflow/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/coding-agent/src/workflow/render.ts packages/coding-agent/src/slash-commands/builtin-registry.ts packages/coding-agent/src/modes/types.ts packages/coding-agent/src/modes/interactive-mode.ts packages/coding-agent/test/workflow/render.test.ts
git commit -m "feat(workflow): /workflows live progress dashboard"
```

---

# Phase 4 — Resume (journal) + worktree isolation

### Task 17: Journal with chained cache keys

**Files:** Create `packages/coding-agent/src/workflow/journal.ts`; Test `packages/coding-agent/test/workflow/journal.test.ts`

The journal makes resume sound: each `agent()` call is keyed by `hash(prompt, opts, prevKey)` — chaining the previous key so reordering or editing a call invalidates it and everything after. On resume, a completed `result` entry for a matching key returns instantly.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { computeCacheKey, WorkflowJournal } from "../../src/workflow/journal";

describe("computeCacheKey", () => {
	it("is stable for identical (prompt, opts, prevKey)", () => {
		expect(computeCacheKey("p", { model: "m" }, "prev")).toBe(computeCacheKey("p", { model: "m" }, "prev"));
	});
	it("changes when the prompt changes", () => {
		expect(computeCacheKey("a", {}, "k")).not.toBe(computeCacheKey("b", {}, "k"));
	});
	it("chains: same call with a different prevKey yields a different key", () => {
		expect(computeCacheKey("p", {}, "k1")).not.toBe(computeCacheKey("p", {}, "k2"));
	});
});

describe("WorkflowJournal", () => {
	it("replays a cached result and skips re-running, until a key diverges", async () => {
		await using dir = await TempDir.create("wf-journal");
		const file = path.join(dir.path, "run.jsonl");
		// First run: record two results.
		const writer = await WorkflowJournal.open(file);
		const k1 = computeCacheKey("scan:a", {}, "");
		await writer.recordResult(k1, "0-scan", "R1");
		const k2 = computeCacheKey("verify:R1", {}, k1);
		await writer.recordResult(k2, "1-verify", "R2");

		// Resume: same prefix → cache hits; a changed second call → miss.
		const reader = await WorkflowJournal.openForResume(file);
		expect(reader.lookup(k1)?.result).toBe("R1");
		const k2changed = computeCacheKey("verify:DIFFERENT", {}, k1);
		expect(reader.lookup(k2changed)).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test packages/coding-agent/test/workflow/journal.test.ts`. Expected: FAIL "Cannot find module ... journal".

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Append-only journal of agent() results, keyed by a chained hash of
 * (prompt, opts, prevKey). On resume, the longest unchanged prefix returns
 * cached results; the first diverging key (and everything after) re-runs live.
 */
import * as fs from "node:fs/promises";
import type { WorkflowAgentOpts } from "./types";

export interface JournalEntry {
	type: "result";
	key: string;
	agentId: string;
	result: string;
}

/** Stable cache key chaining the previous key so order + content both matter. */
export function computeCacheKey(prompt: string, opts: WorkflowAgentOpts, prevKey: string): string {
	const optsCanonical = JSON.stringify({
		schema: opts.schema ?? null,
		model: opts.model ?? null,
		agentType: opts.agentType ?? null,
		isolation: opts.isolation ?? null,
	});
	return Bun.hash(`${prevKey}\u0000${prompt}\u0000${optsCanonical}`).toString(16);
}

export class WorkflowJournal {
	#handle: fs.FileHandle | null;
	readonly #cache = new Map<string, JournalEntry>();

	private constructor(handle: fs.FileHandle | null, cache: Map<string, JournalEntry>) {
		this.#handle = handle;
		for (const [k, v] of cache) this.#cache.set(k, v);
	}

	/** Open for writing (truncates a fresh run's journal). */
	static async open(file: string): Promise<WorkflowJournal> {
		await fs.mkdir(require("node:path").dirname(file), { recursive: true });
		const handle = await fs.open(file, "w");
		return new WorkflowJournal(handle, new Map());
	}

	/** Open for resume: load prior entries (read-only cache + append handle). */
	static async openForResume(file: string): Promise<WorkflowJournal> {
		const cache = new Map<string, JournalEntry>();
		try {
			const text = await fs.readFile(file, "utf8");
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				const entry = JSON.parse(line) as JournalEntry;
				if (entry.type === "result") cache.set(entry.key, entry);
			}
		} catch {
			// No prior journal — nothing cached.
		}
		const handle = await fs.open(file, "a");
		return new WorkflowJournal(handle, cache);
	}

	lookup(key: string): JournalEntry | undefined {
		return this.#cache.get(key);
	}

	async recordResult(key: string, agentId: string, result: string): Promise<void> {
		const entry: JournalEntry = { type: "result", key, agentId, result };
		this.#cache.set(key, entry);
		await this.#handle?.write(`${JSON.stringify(entry)}\n`);
	}

	async close(): Promise<void> {
		await this.#handle?.close();
		this.#handle = null;
	}
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test packages/coding-agent/test/workflow/journal.test.ts`. Expected: PASS. (Replace the inline `require("node:path")` with a top-level `import * as path from "node:path"` per AGENTS.md "no inline imports" — shown inline here only to keep the snippet self-contained; the engineer MUST hoist it.)
- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/workflow/journal.ts packages/coding-agent/test/workflow/journal.test.ts
git commit -m "feat(workflow): journal with chained cache keys"
```

---

### Task 18: Wire resume into the engine

**Files:** Modify `packages/coding-agent/src/workflow/engine.ts`, `packages/coding-agent/src/workflow/index.ts`; Test `packages/coding-agent/test/workflow/engine-resume.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import { WorkflowRun } from "../../src/workflow/engine";
import { computeCacheKey, WorkflowJournal } from "../../src/workflow/journal";

describe("WorkflowRun with journal", () => {
	it("returns cached results without calling runSubprocess and emits 'cached'", async () => {
		await using dir = await TempDir.create("wf-resume");
		const file = path.join(dir.path, "run.jsonl");
		const writer = await WorkflowJournal.open(file);
		const k1 = computeCacheKey("one", {}, "");
		await writer.recordResult(k1, "0-one", "CACHED");
		await writer.close();

		const journal = await WorkflowJournal.openForResume(file);
		let calls = 0;
		const states: string[] = [];
		const run = new WorkflowRun({
			runId: "r",
			cwd: process.cwd(),
			concurrency: 2,
			budgetTotal: null,
			signal: new AbortController().signal,
			allocateId: async (l) => `0-${l}`,
			emit: (f) => {
				if (f.kind === "agent") states.push(f.state);
			},
			resolveAgent: () => ({ name: "workflow-subagent" }) as AgentDefinition,
			runSubprocess: async (o) => {
				calls++;
				return { index: o.index, id: o.id, output: "LIVE" } as SingleResult;
			},
			journal,
		});
		expect(await run.spawn("one", {})).toBe("CACHED");
		expect(calls).toBe(0);
		expect(states).toContain("cached");
		// A diverging call runs live and records.
		expect(await run.spawn("two", {})).toBe("LIVE");
		expect(calls).toBe(1);
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test packages/coding-agent/test/workflow/engine-resume.test.ts`. Expected: FAIL (`journal` not accepted; no cache path).

- [ ] **Step 3: Extend the engine** — in `engine.ts`:
  1. Import the journal: `import { computeCacheKey, type WorkflowJournal } from "./journal";`
  2. Add `journal?: WorkflowJournal;` to `WorkflowRunOptions`.
  3. Add private chain state: `#prevKey = "";`
  4. At the start of `spawn()`, after `#checkCaps()` and before allocating the index, compute the key and short-circuit on a hit:

```typescript
		const cacheKey = this.#opts.journal ? computeCacheKey(prompt, opts, this.#prevKey) : "";
		if (this.#opts.journal) this.#prevKey = cacheKey;
		const cached = this.#opts.journal?.lookup(cacheKey);
		if (cached) {
			const idx = ++this.#spawnIndex;
			this.#agentCount += 1;
			this.#opts.emit({
				kind: "agent",
				runId: this.runId,
				index: idx,
				label: (opts.label ?? prompt.slice(0, 60)).replace(/\s+/g, " ").trim() || "agent",
				phaseTitle: opts.phase ?? this.#currentPhase,
				state: "cached",
				agentId: cached.agentId,
			});
			return cached.result;
		}
```
  5. After a successful live spawn (in the `done` branch, before `return result.output`), record it:

```typescript
			if (this.#opts.journal && typeof result.output === "string") {
				await this.#opts.journal.recordResult(cacheKey, agentId, result.output);
			}
```

- [ ] **Step 4: Wire the journal in `index.ts` `#runScript`** — open the journal under the transcript dir and pass it to `WorkflowRun`:

```typescript
		const journal =
			artifactsDir != null
				? params_resume
					? await WorkflowJournal.openForResume(path.join(subagentTranscriptDir(artifactsDir, runId), "journal.jsonl"))
					: await WorkflowJournal.open(path.join(subagentTranscriptDir(artifactsDir, runId), "journal.jsonl"))
				: undefined;
```
Pass `journal` into the `new WorkflowRun({ ... })` options, and `await journal?.close()` in a `finally` around the `runWorkflowScript` call. Add `import * as path from "node:path";` and `import { WorkflowJournal } from "./journal";` at the top. Thread a `params_resume = !!params.resumeFromRunId` boolean from `execute()` into `#runScript` (add it as a parameter).

- [ ] **Step 5: Run to verify it passes** — `bun test packages/coding-agent/test/workflow/engine-resume.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/workflow/engine.ts packages/coding-agent/src/workflow/index.ts packages/coding-agent/test/workflow/engine-resume.test.ts
git commit -m "feat(workflow): journal-based resume (cached prefix replay)"
```

---

### Task 19: `agent({isolation:'worktree'})` mapping

**Files:** Modify `packages/coding-agent/src/workflow/engine.ts`; Test `packages/coding-agent/test/workflow/isolation.test.ts`

omp already supports worktree isolation in the task layer (`task/worktree.ts`). For the workflow `agent()` helper, route `opts.isolation === "worktree"` through the same `ensureIsolation`/`captureBaseline`/`captureDeltaPatch` path the task tool uses, then apply the captured patch on the parent after the spawn returns.

- [ ] **Step 1: Write the failing test (guard only — full worktree integration is exercised by the task tests)**

```typescript
import { describe, expect, it } from "bun:test";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import { WorkflowRun } from "../../src/workflow/engine";

describe("agent isolation", () => {
	it("rejects unknown isolation values", async () => {
		const run = new WorkflowRun({
			runId: "r",
			cwd: process.cwd(),
			concurrency: 1,
			budgetTotal: null,
			signal: new AbortController().signal,
			allocateId: async (l) => `0-${l}`,
			emit: () => {},
			resolveAgent: () => ({ name: "workflow-subagent" }) as AgentDefinition,
			runSubprocess: async (o) => ({ index: o.index, id: o.id, output: "ok" } as SingleResult),
		});
		await expect(run.spawn("x", { isolation: "remote" as never })).rejects.toThrow(/not available/);
	});
});
```

- [ ] **Step 2: Run to verify it passes already** — `bun test packages/coding-agent/test/workflow/isolation.test.ts`. Expected: PASS (the `"remote"` guard from Task 5 already throws). This task is the seam for worktree support; the guard test locks the contract.

- [ ] **Step 3: Implement worktree isolation in `spawn()`** — when `opts.isolation === "worktree"` and the cwd is a git repo (`getRepoRoot(this.cwd)`), wrap the `runSubprocess` call:
  1. `const baseline = await captureBaseline(repoRoot);`
  2. `const iso = await ensureIsolation({ mode: "worktree", repoRoot, id: agentId });`
  3. call `runSubprocess({ ..., worktree: iso.worktreePath })`
  4. on success: `const patch = await captureDeltaPatch(iso, baseline); if (patch.text) await git.patch.applyText(repoRoot, patch.text);`
  5. `finally { await cleanupIsolation(iso); }`

  Import these from `../task/worktree` (verified names at `task/index.ts:54-68`): `captureBaseline`, `ensureIsolation`, `captureDeltaPatch`, `cleanupIsolation`, `getRepoRoot`. Use `../utils/git` for `patch.applyText`. Keep this behind a try/catch that falls back to non-isolated execution with a `log()` warning if the repo is missing — mirror the task tool's fallback at `task/index.ts` isolation path.

- [ ] **Step 4: Manual verification** — author a 2-agent workflow where each agent edits a distinct file under `agent({isolation:"worktree"})`; run it; confirm both edits land on the parent working tree and the worktrees are cleaned (`git worktree list` shows none left over).

Run: `git worktree list`
Expected: only the main worktree.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/workflow/engine.ts packages/coding-agent/test/workflow/isolation.test.ts
git commit -m "feat(workflow): agent({isolation:'worktree'}) via task worktree backend"
```

---

# Final verification

- [ ] **Full typecheck:** Run `bun check`. Expected: PASS (no errors across the changed packages).
- [ ] **Workflow suite:** Run `bun test packages/coding-agent/test/workflow/`. Expected: all PASS.
- [ ] **Targeted regression:** Run `bun test packages/coding-agent/test/task/`. Expected: PASS (no regression from the `agents.ts` and `async/job-manager.ts` edits).
- [ ] **Binary smoke:** Run `bun --cwd=packages/coding-agent run build && packages/coding-agent/dist/omp --smoke-test && packages/coding-agent/dist/omp --version`. Expected: smoke passes (confirms the `with { type: "text" }` `.js`/`.md` imports survive `--compile`; if the bundled `.js` scripts fail to embed, rename to `.js.txt` per Task 14 Step 5).
- [ ] **Manual end-to-end (real model):** With `workflow.enabled=true`, run an inline workflow that fans out 3 `quick_task` agents in `parallel()` then a `phase("synthesize")` `agent()`; confirm `/workflows` shows the live tree, the `<task-notification>`/completion text returns, `agent://` ids resolve, and aborting mid-run yields a partial result without a crash.
- [ ] **Changelog:** Add to `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]` → `### Added`: `Added Workflow tool: deterministic multi-subagent orchestration scripts with /workflows live progress and journal-based resume.`

---

## Self-review (run after the plan is implemented)

1. **Spec coverage** — every Claude Workflow capability maps to a task:
   - tool params {script, scriptPath, name, args, resumeFromRunId} → Task 11/15/18.
   - meta literal → Task 2. sandbox + determinism → Task 3.
   - agent/parallel/pipeline/phase/log/budget → Task 6; workflow() nesting → Task 15.
   - caps (min(16,cores-2), 1000) → Task 5. background + notification → Task 11. settings/consent → Task 8/12.
   - subagent agent + structured output → Task 7 (+ `outputSchema` passthrough in Task 5/11).
   - discovery + bundled workflows → Task 14. /workflows UI → Task 16. resume journal → Task 17/18. worktree isolation → Task 19.
2. **Type consistency** — `WorkflowRunOptions.runSubprocess`/`resolveAgent`/`emit`/`allocateId` names are identical across engine.ts (Task 5), tests (Task 5/13/18), and the tool wiring (Task 11). `WorkflowProgressFrame` discriminants (`phase`/`log`/`agent`) and states (`start`/`done`/`error`/`cached`) match between types.ts (Task 1), engine.ts (Task 5/18), and render.ts (Task 16). `computeCacheKey(prompt, opts, prevKey)` signature matches between journal.ts (Task 17) and engine.ts (Task 18).
3. **Open risks to verify during execution (not placeholders — checks):**
   - `with { type: "text" }` for `.js` bundled scripts (Task 14 Step 5 has the `.js.txt` fallback).
   - `Bun.hash` determinism across processes for the journal key (stable within a Bun version; acceptable since resume is same-session). If cross-version stability is needed, swap to a SHA via WebCrypto.
   - `MCPManager.instance()` and `AsyncJobManager.instance()` are the right process-global accessors (verified at `task/index.ts:1020` and `async/job-manager.ts:71`).
   - `runSubprocess` honoring `outputSchema` for the structured `agent({schema})` path — confirm `SingleResult.output`/`extractedToolData` carries the structured payload; if structured data lands in `extractedToolData` rather than `output`, update `WorkflowRun.spawn` to prefer it when `opts.schema` is set.