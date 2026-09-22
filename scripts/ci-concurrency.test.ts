// Regression test for #2564: the CI workflow's `concurrency` block must route
// release runs to a per-sha group with no cancellation, so a later main push
// can't kill the in-flight release and leave the tag unpublished. The block is
// evaluated by GitHub at workflow-scheduling time (before any job can produce
// the signal), so this test re-implements the small subset of GitHub
// expression semantics the block uses and asserts the resolved group / cancel
// flag for every event shape we care about.

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";

const WORKFLOW_PATH = path.resolve(import.meta.dir, "..", ".github", "workflows", "ci.yml");
const BUN_INSTALL_ACTION_PATH = path.resolve(import.meta.dir, "..", ".github", "actions", "bun-install", "action.yml");

type Value = string | boolean | null;

// `github` context fed into the evaluator. Nested objects are walked the same
// way as in real GHA expressions; missing keys resolve to `null`.
interface GhaCtx {
	workflow: string;
	ref: string;
	sha: string;
	event_name: string;
	event: {
		head_commit?: { message?: string };
	};
}

interface GhaWorkflowCtx {
	github: GhaCtx;
	needs?: Record<string, { outputs?: Record<string, string>; result?: string }>;
}

// Single-purpose evaluator for the GitHub expression subset used by workflow
// scheduling: concurrency templates, release-companion metadata, and job gates.
// It supports `startsWith`, `format`, `cancelled`, `!`, equality, `&&`, `||`,
// parens, single-quoted strings, and dotted property access. It follows GHA
// short-circuit semantics: `&&`/`||` return underlying values, missing paths are
// `null`, and `startsWith(null, …)` is false because the search string is `""`.
class GhaEval {
	#pos = 0;

	private constructor(
		private readonly src: string,
		private readonly ctx: GhaWorkflowCtx,
	) {}

	static run(expr: string, ctx: GhaWorkflowCtx): Value {
		const ev = new GhaEval(expr.trim(), ctx);
		const value = ev.#or();
		ev.#skipWs();
		if (ev.#pos !== ev.src.length) {
			throw new Error(`trailing input at offset ${ev.#pos}: ${ev.src.slice(ev.#pos)}`);
		}
		return value;
	}

	// Substitute every `${{ … }}` placeholder in a workflow template string.
	static template(template: string, ctx: GhaWorkflowCtx): string {
		let out = "";
		let i = 0;
		while (i < template.length) {
			const start = template.indexOf("${{", i);
			if (start === -1) {
				out += template.slice(i);
				break;
			}
			out += template.slice(i, start);
			const end = template.indexOf("}}", start);
			if (end === -1) throw new Error("unterminated ${{ expression");
			const v = GhaEval.run(template.slice(start + 3, end), ctx);
			out += v === null ? "" : String(v);
			i = end + 2;
		}
		return out;
	}

	#or(): Value {
		let left = this.#and();
		while (this.#consume("||")) {
			const right = this.#and();
			// Truthy left wins; only null/false/"" fall through.
			if (left !== null && left !== false && left !== "") continue;
			left = right;
		}
		return left;
	}

	#and(): Value {
		let left = this.#eq();
		while (this.#consume("&&")) {
			const right = this.#eq();
			// Falsy left short-circuits and is returned verbatim.
			if (left === null || left === false || left === "") continue;
			left = right;
		}
		return left;
	}

	#eq(): Value {
		let left = this.#unary();
		while (true) {
			if (this.#consume("==")) {
				const right = this.#unary();
				left = left === right;
				continue;
			}
			if (this.#consume("!=")) {
				const right = this.#unary();
				left = left !== right;
				continue;
			}
			return left;
		}
	}

	#unary(): Value {
		this.#skipWs();
		if (this.src[this.#pos] === "!") {
			this.#pos++;
			const v = this.#unary();
			return v === null || v === false || v === "";
		}
		return this.#primary();
	}

	#primary(): Value {
		this.#skipWs();
		const ch = this.src[this.#pos];
		if (ch === "(") {
			this.#pos++;
			const v = this.#or();
			this.#skipWs();
			if (this.src[this.#pos] !== ")") throw new Error("expected `)`");
			this.#pos++;
			return v;
		}
		if (ch === "'") return this.#string();
		// Identifier or function call.
		const ident = this.#identifier();
		this.#skipWs();
		if (this.src[this.#pos] === "(") return this.#call(ident);
		return this.#readPath(ident);
	}

	#string(): string {
		// GHA single-quoted: `''` is an escaped quote.
		this.#pos++; // opening quote
		let out = "";
		while (this.#pos < this.src.length) {
			const c = this.src[this.#pos];
			if (c === "'") {
				if (this.src[this.#pos + 1] === "'") {
					out += "'";
					this.#pos += 2;
					continue;
				}
				this.#pos++;
				return out;
			}
			out += c;
			this.#pos++;
		}
		throw new Error("unterminated string literal");
	}

	#identifier(): string {
		const start = this.#pos;
		while (this.#pos < this.src.length && /[A-Za-z0-9_.-]/.test(this.src[this.#pos]!)) {
			this.#pos++;
		}
		if (start === this.#pos) throw new Error(`expected identifier at ${this.#pos}`);
		return this.src.slice(start, this.#pos);
	}

	#call(name: string): Value {
		this.#pos++; // opening paren
		const args: Value[] = [];
		this.#skipWs();
		if (this.src[this.#pos] !== ")") {
			for (;;) {
				args.push(this.#or());
				this.#skipWs();
				if (this.src[this.#pos] === ",") {
					this.#pos++;
					continue;
				}
				break;
			}
		}
		this.#skipWs();
		if (this.src[this.#pos] !== ")") throw new Error("expected `)` closing call");
		this.#pos++;
		switch (name) {
			case "cancelled":
				if (args.length !== 0) throw new Error("cancelled expects no arguments");
				return false;
			case "startsWith": {
				const hay = args[0] === null || args[0] === false ? "" : String(args[0]);
				const needle = args[1] === null || args[1] === false ? "" : String(args[1]);
				return hay.startsWith(needle);
			}
			case "format": {
				const tmpl = args[0] === null ? "" : String(args[0]);
				return tmpl.replace(/\{(\d+)\}/g, (_, idx) => {
					const v = args[Number(idx) + 1];
					return v === null || v === false ? "" : String(v);
				});
			}
			default:
				throw new Error(`unsupported function: ${name}`);
		}
	}

	#readPath(dotted: string): Value {
		let cur: unknown = this.ctx;
		for (const seg of dotted.split(".")) {
			if (cur == null || typeof cur !== "object") return null;
			cur = (cur as Record<string, unknown>)[seg];
		}
		if (cur === undefined || cur === null) return null;
		if (typeof cur === "object") return null;
		return cur as Value;
	}

	#consume(op: string): boolean {
		this.#skipWs();
		if (this.src.startsWith(op, this.#pos)) {
			this.#pos += op.length;
			return true;
		}
		return false;
	}

	#skipWs(): void {
		while (this.#pos < this.src.length && /\s/.test(this.src[this.#pos]!)) this.#pos++;
	}
}

const workflowYaml = await Bun.file(WORKFLOW_PATH).text();
const bunInstallActionYaml = await Bun.file(BUN_INSTALL_ACTION_PATH).text();
const buildNativeActionYaml = await Bun.file(
	path.resolve(import.meta.dir, "..", ".github", "actions", "build-native", "action.yml"),
).text();
const sourceHashPlaceholder = "$" + "{{ steps.compute.outputs.source-hash }}";
// The block sits at indent 0 immediately under the top-level `concurrency:`
// key and uses single-line values, so a flat-line extract is unambiguous.
// Values are double-quoted in YAML (the GitHub expression contains `: ` from
// the `'chore: bump version to '` literal which would otherwise trip plain
// scalar parsing), so we unwrap the wrapping `"…"` here.
const concurrencySection = workflowYaml.slice(workflowYaml.indexOf("\nconcurrency:") + 1);
const groupRaw = /^\s*group:\s*(\S.*?)\s*$/m.exec(concurrencySection)?.[1];
const cancelRaw = /^\s*cancel-in-progress:\s*(\S.*?)\s*$/m.exec(concurrencySection)?.[1];
const groupTemplate = groupRaw?.startsWith('"') && groupRaw.endsWith('"') ? groupRaw.slice(1, -1) : groupRaw;
const cancelTemplate = cancelRaw?.startsWith('"') && cancelRaw.endsWith('"') ? cancelRaw.slice(1, -1) : cancelRaw;
if (!groupTemplate || !cancelTemplate) {
	throw new Error("could not locate concurrency.group / cancel-in-progress in ci.yml");
}

const RELEASE_SUBJECT = "chore: bump version to 15.12.6";

const baseCtx = (overrides: Partial<GhaCtx> = {}): GhaWorkflowCtx => ({
	github: {
		workflow: "CI",
		ref: "refs/heads/main",
		sha: "deadbeefcafebabe",
		event_name: "push",
		event: {},
		...overrides,
	},
});

function workflowJobSection(name: string): string {
	const marker = `\n   ${name}:\n`;
	const start = workflowYaml.indexOf(marker);
	if (start === -1) throw new Error(`could not locate ${name} job in ci.yml`);
	const rest = workflowYaml.slice(start + 1);
	const next = /\n {3}[A-Za-z0-9_-]+:\n/.exec(rest);
	return next ? rest.slice(0, next.index) : rest;
}

function workflowJobIf(name: string): string | undefined {
	const section = workflowJobSection(name);
	const jobFields = section.slice(0, section.search(/\n {6}(?:steps|uses):/));
	return /^\s*if:\s*\$\{\{([\s\S]*?)\}\}\s*$/m.exec(jobFields)?.[1];
}

function evaluateJobIf(name: string, ctx: GhaWorkflowCtx): Value | undefined {
	const expression = workflowJobIf(name);
	return expression ? GhaEval.run(expression, ctx) : undefined;
}

function workflowOutputTemplate(name: string, output: string): string | undefined {
	const section = workflowJobSection(name);
	const raw = new RegExp(`^\\s*${output}:\\s*(\\S.*?)\\s*$`, "m").exec(section)?.[1];
	return raw?.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

function completedNeeds(isCompanion: boolean, isRelease: boolean): GhaWorkflowCtx["needs"] {
	const outputs = {
		"is-companion": String(isCompanion),
		"is-release": String(isRelease),
		"linux-x64-run-id": "",
		"cross-platform-run-id": "",
	};
	const result = { result: "success" };
	return {
		release_metadata: { outputs, ...result },
		native_artifact_lookup: { outputs, ...result },
		native_linux_x64: result,
		native_linux_x64_modern: result,
		check: result,
		native_cross_platform_kata: result,
		native_cross_platform_win32: result,
		native_cross_platform_macos: result,
		test_workspace: result,
		test_coding_agent_singleton: result,
		test_ts_native: result,
		test_coding_agent_ui: result,
		test_coding_agent_runtime: result,
		test_coding_agent_native: result,
		test_smoke: result,
		install_methods: result,
		security: result,
	};
}

function jobStepScript(jobName: string, stepId: string): string {
	const parsed = YAML.parse(workflowYaml);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("ci.yml root is not a mapping");
	}
	const jobs = (parsed as Record<string, unknown>).jobs;
	if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
		throw new Error("ci.yml jobs is not a mapping");
	}
	const job = (jobs as Record<string, unknown>)[jobName];
	if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error(`${jobName} is not a mapping`);
	const steps = (job as Record<string, unknown>).steps;
	if (!Array.isArray(steps)) throw new Error(`${jobName}.steps is not an array`);
	const step = steps.find(candidate => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
		return (candidate as Record<string, unknown>).id === stepId;
	});
	if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`${jobName} has no step ${stepId}`);
	const run = (step as Record<string, unknown>).run;
	if (typeof run !== "string") throw new Error(`${jobName}.${stepId} run script is not a string`);
	return run;
}

/**
 * Run a workflow step script against a fake `gh`. `ghBody` is a bash snippet
 * dispatching on "$*" (the full gh argv); it prints the already-`--jq`-filtered
 * output the real CLI would produce.
 */
async function runStepWithFakeGh(script: string, ghBody: string, env: Record<string, string> = {}): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omppp-ci-step-"));
	try {
		const gh = path.join(tempDir, "gh");
		const outputPath = path.join(tempDir, "github-output");
		await Bun.write(gh, `#!/usr/bin/env bash\nargs="$*"\n${ghBody}\nexit 1\n`);
		await fs.chmod(gh, 0o755);
		const proc = Bun.spawn(["bash", "-c", script.replace(sourceHashPlaceholder, "testhash")], {
			env: {
				...Bun.env,
				...env,
				REPO: "owner/repo",
				GITHUB_SHA: "tagsha",
				GITHUB_OUTPUT: outputPath,
				PATH: `${tempDir}:${Bun.env.PATH ?? ""}`,
			},
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) throw new Error(`step script exited ${exitCode}`);
		return await Bun.file(outputPath).text();
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

const nativeArtifactKeys = [
	"linux-x64-baseline",
	"linux-x64-modern",
	"linux-musl-x64-baseline",
	"darwin-x64-baseline",
	"darwin-arm64",
	"win32-x64-baseline",
];

/** Bash that prints `lines` (tabs allowed) the way `gh --jq` would. Lines must not contain `'`. */
function emit(lines: readonly string[]): string {
	return `printf '%b' '${lines.map(line => `${line.replaceAll("\t", "\\t")}\\n`).join("")}'; exit 0`;
}

/** Fake gh for the artifact lookup: artifact name -> "run\tsha" rows (newest first). */
function lookupGh(
	artifactRows: (key: string) => string[],
	pushRuns: readonly string[],
	mainAncestors: readonly string[],
): string {
	const cases = [
		...nativeArtifactKeys.map(
			key => `  *"artifacts?name=pi-natives-${key}-htesthash&"*) ${emit(artifactRows(key))} ;;`,
		),
		...pushRuns.map(id => `  *"actions/runs/${id} "*) ${emit(["push\t.github/workflows/ci.yml"])} ;;`),
		`  *"actions/runs/"*) ${emit(["pull_request\t.github/workflows/ci.yml"])} ;;`,
		...mainAncestors.map(sha => `  *"compare/${sha}...main "*) ${emit(["ahead"])} ;;`),
		`  *compare/*) ${emit(["diverged"])} ;;`,
	];
	return `case "$args" in\n${cases.join("\n")}\nesac`;
}

const requiredReleaseJobs = [
	"Lint, type check & web build",
	"Test TS workspace fast",
	"Test coding-agent singleton/global-state (TS)",
	"Test TS native/integration packages",
	"Test coding-agent UI/TUI (TS)",
	"Test coding-agent runtime/session (TS)",
	"Test coding-agent native/unit (TS)",
	"Test CLI smoke (TS)",
	"Install method smoke tests",
];

/** Fake gh for release_base: newest-first main runs, their green jobs, and the diff to the tag. */
function releaseBaseGh(
	runs: { id: string; sha: string; green: readonly string[]; files: readonly string[] }[],
): string {
	const cases = [
		`  "run list"*) ${emit(runs.map(run => `${run.id}\t${run.sha}`))} ;;`,
		...runs.map(run => `  *"runs/${run.id}/jobs"*) ${emit(run.green)} ;;`),
		...runs.map(run => `  *"compare/${run.sha}...tagsha --jq .status"*) ${emit(["ahead"])} ;;`),
		...runs.map(run => `  *"compare/${run.sha}...tagsha "*) ${emit(run.files)} ;;`),
	];
	return `case "$args" in\n${cases.join("\n")}\nesac`;
}

describe("ci.yml workflow scheduling", () => {
	it("release companion main push skips duplicated workload and keeps normal branch cancellation", () => {
		const ctx = baseCtx({ event: { head_commit: { message: `${RELEASE_SUBJECT}\n\nbody` } } });
		const companionOutput = workflowOutputTemplate("release_metadata", "is-companion") ?? "";
		expect(GhaEval.template(companionOutput, ctx)).toBe("true");
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-refs/heads/main");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("true");

		const companionCtx = { ...ctx, needs: completedNeeds(true, false) };
		for (const job of [
			"native_artifact_lookup",
			"check",
			"native_linux_x64",
			"native_linux_x64_modern",
			"native_cross_platform_kata",
			"native_cross_platform_win32",
			"native_cross_platform_macos",
			"test_workspace",
			"test_coding_agent_singleton",
			"test_ts_native",
			"test_coding_agent_ui",
			"test_coding_agent_runtime",
			"test_coding_agent_native",
			"test_smoke",
			"install_methods",
			"security",
		]) {
			expect(evaluateJobIf(job, companionCtx)).toBe(false);
		}
	});

	it("valid tag release remains per-sha non-cancellable and can run the full release graph", () => {
		const ctx = baseCtx({
			ref: "refs/tags/v15.12.6",
			sha: "abc123",
			event: {},
		});
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-release-abc123");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("false");
		expect(evaluateJobIf("release_binary", { ...ctx, needs: completedNeeds(false, true) })).toBe(true);
	});

	it("tag release skips redundant typecheck and still publishes when check is skipped", () => {
		const ctx = baseCtx({
			ref: "refs/tags/v15.12.6",
			sha: "abc123",
			event: {},
		});
		const needs = completedNeeds(false, true);
		needs.check = { result: "skipped" };
		expect(evaluateJobIf("check", { ...ctx, needs })).toBe(false);
		expect(evaluateJobIf("release_gate", { ...ctx, needs })).toBe(true);
		expect(evaluateJobIf("release_binary", { ...ctx, needs })).toBe(true);
	});

	it("workflow_dispatch from a version tag ref remains per-sha and non-cancellable", () => {
		const ctx = baseCtx({
			ref: "refs/tags/v15.12.6",
			event_name: "workflow_dispatch",
			sha: "abc123",
			event: {},
		});
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-release-abc123");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("false");
	});

	it("workflow_dispatch from tagged main HEAD is isolated before release_metadata can inspect tags", () => {
		const ctx = baseCtx({
			event_name: "workflow_dispatch",
			sha: "taggedmain123",
			event: {},
		});
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-release-taggedmain123");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("false");
	});

	it("ordinary main push executes every CI workload gate", () => {
		const ctx = baseCtx({ event: { head_commit: { message: "fix(ux): theme tweak" } } });
		const companionOutput = workflowOutputTemplate("release_metadata", "is-companion") ?? "";
		expect(GhaEval.template(companionOutput, ctx)).toBe("false");
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-refs/heads/main");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("true");

		const mainCtx = { ...ctx, needs: completedNeeds(false, false) };
		for (const job of [
			"native_artifact_lookup",
			"check",
			"native_linux_x64",
			"native_linux_x64_modern",
			"native_cross_platform_kata",
			"native_cross_platform_win32",
			"native_cross_platform_macos",
			"test_workspace",
			"test_coding_agent_singleton",
			"test_ts_native",
			"test_coding_agent_ui",
			"test_coding_agent_runtime",
			"test_coding_agent_native",
			"test_smoke",
			"install_methods",
			"security",
		]) {
			expect(evaluateJobIf(job, mainCtx)).toBe(true);
		}
	});

	it("pull_request (no head_commit): branch-wide group, cancel enabled", () => {
		const ctx = baseCtx({ ref: "refs/pull/42/merge", event_name: "pull_request", event: {} });
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-refs/pull/42/merge");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("true");
	});

	it("distinct tag release SHAs land in disjoint protected groups", () => {
		const a = baseCtx({ ref: "refs/tags/v15.12.6", sha: "aaaa1111", event: {} });
		const b = baseCtx({ ref: "refs/tags/v15.12.7", sha: "bbbb2222", event: {} });
		expect(GhaEval.template(groupTemplate, a)).not.toBe(GhaEval.template(groupTemplate, b));
	});

	it("non-release main text and rejected non-semver tags never enter the release graph", () => {
		const mainCtx = baseCtx({
			event: { head_commit: { message: `fix: notes mention ${RELEASE_SUBJECT}` } },
		});
		const invalidTagCtx = baseCtx({ ref: "refs/tags/vnext", event: {} });
		const companionOutput = workflowOutputTemplate("release_metadata", "is-companion") ?? "";
		expect(GhaEval.template(companionOutput, mainCtx)).toBe("false");
		expect(evaluateJobIf("release_binary", { ...mainCtx, needs: completedNeeds(false, false) })).toBe(false);
		expect(evaluateJobIf("release_binary", { ...invalidTagCtx, needs: completedNeeds(false, false) })).toBe(false);
	});

	it("reuses each exact artifact only from a trusted main-ancestor push run", async () => {
		// 300 is newest but lacks win32; 200 is a PR run; 400 is off-main; 100 holds the full set.
		const output = await runStepWithFakeGh(
			jobStepScript("native_artifact_lookup", "find"),
			lookupGh(
				key => [
					"200\tpr-sha",
					"400\toff-main",
					...(key === "win32-x64-baseline" ? [] : ["300\ttrusted-newer"]),
					"100\ttrusted-complete",
				],
				["100", "300", "400"],
				["trusted-complete", "trusted-newer"],
			),
		);
		expect(output).toContain("darwin-x64-baseline-run-id=300\n");
		expect(output).toContain("win32-x64-baseline-run-id=100\n");
		expect(output).toContain("linux-x64-run-id=300\n");
		expect(output).toContain("cross-platform-run-id=100\n");
		expect(output).not.toMatch(/=(200|400)\n/);
	});

	it("leaves every artifact to rebuild when no trusted run holds it", async () => {
		const output = await runStepWithFakeGh(
			jobStepScript("native_artifact_lookup", "find"),
			lookupGh(() => ["200\tpr-sha"], [], []),
		);
		expect(output).toContain("linux-x64-run-id=\n");
		expect(output).toContain("win32-x64-baseline-run-id=\n");
		expect(output).toContain("cross-platform-run-id=\n");
	});

	it("release base skips re-testing only for a bump-only diff on a fully green main run", async () => {
		const script = jobStepScript("release_base", "base");
		const bumpFiles = [
			"package.json",
			"Cargo.lock",
			"packages/coding-agent/CHANGELOG.md",
			"crates/pi-natives/src/lib.rs",
		];
		// Companion bump run (newest) skipped tests, so the older fully green run decides.
		const fastPath = await runStepWithFakeGh(
			script,
			releaseBaseGh([
				{ id: "2", sha: "bump", green: ["Resolve release metadata"], files: [] },
				{ id: "1", sha: "base", green: requiredReleaseJobs, files: bumpFiles },
			]),
		);
		expect(fastPath).toContain("tested=true");

		const codeChanged = await runStepWithFakeGh(
			script,
			releaseBaseGh([
				{
					id: "1",
					sha: "base",
					green: requiredReleaseJobs,
					files: [...bumpFiles, "packages/coding-agent/src/cli.ts"],
				},
			]),
		);
		expect(codeChanged).toContain("tested=false");

		const partialGreen = await runStepWithFakeGh(
			script,
			releaseBaseGh([{ id: "1", sha: "base", green: requiredReleaseJobs.slice(1), files: [] }]),
		);
		expect(partialGreen).toContain("tested=false");
	});

	it("release publishes without re-running tests only when release_base vouches for them", () => {
		const ctx = baseCtx({ ref: "refs/tags/v15.12.6", sha: "abc123", event: {} });
		const needs = completedNeeds(false, true);
		for (const job of [
			"test_workspace",
			"test_coding_agent_singleton",
			"test_ts_native",
			"test_coding_agent_ui",
			"test_coding_agent_runtime",
			"test_coding_agent_native",
			"test_smoke",
			"install_methods",
		]) {
			needs[job] = { result: "skipped" };
		}
		needs.release_base = { result: "success", outputs: { tested: "true" } };
		expect(evaluateJobIf("test_coding_agent_native", { ...ctx, needs })).toBe(false);
		expect(evaluateJobIf("release_binary", { ...ctx, needs })).toBe(true);
		expect(evaluateJobIf("release_gate", { ...ctx, needs })).toBe(true);

		needs.release_base = { result: "success", outputs: { tested: "false" } };
		expect(evaluateJobIf("release_binary", { ...ctx, needs })).toBe(false);
	});

	it("keeps a conditional build and current-run staging path for every native artifact job", () => {
		const parsed = YAML.parse(workflowYaml);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("ci.yml root is not a mapping");
		}
		const jobs = (parsed as Record<string, unknown>).jobs;
		if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
			throw new Error("ci.yml jobs is not a mapping");
		}

		for (const name of [
			"native_linux_x64",
			"native_linux_x64_modern",
			"native_cross_platform_kata",
			"native_cross_platform_win32",
			"native_cross_platform_macos",
		]) {
			const job = (jobs as Record<string, unknown>)[name];
			if (!job || typeof job !== "object" || Array.isArray(job)) {
				throw new Error(`${name} is not a mapping`);
			}
			const steps = (job as Record<string, unknown>).steps;
			if (!Array.isArray(steps)) throw new Error(`${name}.steps is not an array`);

			const build = steps.find(step => {
				if (!step || typeof step !== "object" || Array.isArray(step)) return false;
				return (step as Record<string, unknown>).uses === "./.github/actions/build-native";
			});
			if (!build || typeof build !== "object" || Array.isArray(build)) {
				throw new Error(`${name} does not retain build-native`);
			}
			expect((build as Record<string, unknown>).if).toMatch(/run-id.*==\s*''/);

			const priorDownload = steps.find(step => {
				if (!step || typeof step !== "object" || Array.isArray(step)) return false;
				const fields = step as Record<string, unknown>;
				const withInputs = fields.with;
				return (
					typeof fields.uses === "string" &&
					fields.uses.includes("download-artifact") &&
					!!withInputs &&
					typeof withInputs === "object" &&
					!Array.isArray(withInputs) &&
					typeof (withInputs as Record<string, unknown>)["run-id"] === "string"
				);
			});
			if (!priorDownload || typeof priorDownload !== "object" || Array.isArray(priorDownload)) {
				throw new Error(`${name} does not download a prior-run artifact`);
			}
			expect((priorDownload as Record<string, unknown>).if).toMatch(/run-id.*!=\s*''/);

			const currentUpload = steps.find(step => {
				if (!step || typeof step !== "object" || Array.isArray(step)) return false;
				const fields = step as Record<string, unknown>;
				return typeof fields.uses === "string" && fields.uses.includes("upload-artifact");
			});
			if (!currentUpload || typeof currentUpload !== "object" || Array.isArray(currentUpload)) {
				throw new Error(`${name} does not re-upload the staged artifact`);
			}
			expect((currentUpload as Record<string, unknown>).if).toMatch(/run-id.*!=\s*''/);
		}
	});
});

describe("native artifact build dependencies", () => {
	it("keeps dependency installation opt-in while artifact-only builds disable it", () => {
		const bunInstall = YAML.parse(bunInstallActionYaml);
		const buildNative = YAML.parse(buildNativeActionYaml);
		if (!bunInstall || typeof bunInstall !== "object" || Array.isArray(bunInstall)) {
			throw new Error("bun-install action root is not a mapping");
		}
		if (!buildNative || typeof buildNative !== "object" || Array.isArray(buildNative)) {
			throw new Error("build-native action root is not a mapping");
		}

		const inputs = (bunInstall as Record<string, unknown>).inputs;
		if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
			throw new Error("bun-install inputs is not a mapping");
		}
		const installDependencies = (inputs as Record<string, unknown>).install_dependencies;
		if (!installDependencies || typeof installDependencies !== "object" || Array.isArray(installDependencies)) {
			throw new Error("bun-install install_dependencies input is not a mapping");
		}
		expect((installDependencies as Record<string, unknown>).default).toBe("true");

		const nativeRuns = (buildNative as Record<string, unknown>).runs;
		if (!nativeRuns || typeof nativeRuns !== "object" || Array.isArray(nativeRuns)) {
			throw new Error("build-native runs is not a mapping");
		}
		const nativeSteps = (nativeRuns as Record<string, unknown>).steps;
		if (!Array.isArray(nativeSteps)) throw new Error("build-native steps is not an array");
		const bunStep = nativeSteps.find(step => {
			if (!step || typeof step !== "object" || Array.isArray(step)) return false;
			return (step as Record<string, unknown>).uses === "./.github/actions/bun-install";
		});
		if (!bunStep || typeof bunStep !== "object" || Array.isArray(bunStep)) {
			throw new Error("build-native does not invoke bun-install");
		}
		const bunWith = (bunStep as Record<string, unknown>).with;
		if (!bunWith || typeof bunWith !== "object" || Array.isArray(bunWith)) {
			throw new Error("build-native bun-install step has no inputs");
		}
		expect((bunWith as Record<string, unknown>).install_dependencies).toBe(`\${{ steps.cargo.outputs.needed }}`);

		const bunRuns = (bunInstall as Record<string, unknown>).runs;
		if (!bunRuns || typeof bunRuns !== "object" || Array.isArray(bunRuns)) {
			throw new Error("bun-install runs is not a mapping");
		}
		const bunSteps = (bunRuns as Record<string, unknown>).steps;
		if (!Array.isArray(bunSteps)) throw new Error("bun-install steps is not an array");
		for (const name of [
			"Restore bun store (GitHub cache)",
			"Prepare mounted bun store",
			"Install dependencies",
			"Save bun store (GitHub cache)",
		]) {
			const step = bunSteps.find(candidate => {
				if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
				return (candidate as Record<string, unknown>).name === name;
			});
			if (!step || typeof step !== "object" || Array.isArray(step)) {
				throw new Error(`bun-install has no ${name} step`);
			}
			expect((step as Record<string, unknown>).if).toContain("inputs.install_dependencies == 'true'");
		}
	});
});
