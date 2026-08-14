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
const repositoryPlaceholder = "$" + "{{ github.repository }}";
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

function nativeArtifactLookupScript(): string {
	const parsed = YAML.parse(workflowYaml);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("ci.yml root is not a mapping");
	}
	const jobs = (parsed as Record<string, unknown>).jobs;
	if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
		throw new Error("ci.yml jobs is not a mapping");
	}
	const lookup = (jobs as Record<string, unknown>).native_artifact_lookup;
	if (!lookup || typeof lookup !== "object" || Array.isArray(lookup)) {
		throw new Error("native_artifact_lookup is not a mapping");
	}
	const steps = (lookup as Record<string, unknown>).steps;
	if (!Array.isArray(steps)) throw new Error("native_artifact_lookup.steps is not an array");
	const findStep = steps.find(step => {
		if (!step || typeof step !== "object" || Array.isArray(step)) return false;
		return (step as Record<string, unknown>).id === "find";
	});
	if (!findStep || typeof findStep !== "object" || Array.isArray(findStep)) {
		throw new Error("could not find native artifact lookup step");
	}
	const run = (findStep as Record<string, unknown>).run;
	if (typeof run !== "string") throw new Error("native artifact lookup run script is not a string");
	return run;
}

async function nativeLookupRunListArgs(): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omppp-ci-lookup-"));
	try {
		const gh = path.join(tempDir, "gh");
		const argsPath = path.join(tempDir, "gh-run-args");
		const outputPath = path.join(tempDir, "github-output");
		await Bun.write(
			gh,
			`#!/usr/bin/env bash
if [ "$1" = "run" ]; then
\tprintf '%s\\n' "$@" > "$GH_ARGS"
\techo 123
\texit 0
fi
if [ "$1" = "api" ]; then
\texit 0
fi
exit 1
`,
		);
		await fs.chmod(gh, 0o755);
		const script = nativeArtifactLookupScript()
			.replace(sourceHashPlaceholder, "testhash")
			.replace(repositoryPlaceholder, "owner/repo")
			.replaceAll("gh ", '"$GH_BIN" ');
		const proc = Bun.spawn(["bash", "-c", script], {
			env: {
				...Bun.env,
				GH_ARGS: argsPath,
				GH_BIN: gh,
				GITHUB_OUTPUT: outputPath,
				PATH: `${tempDir}:${Bun.env.PATH ?? ""}`,
			},
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) throw new Error(`native lookup script exited ${exitCode}`);
		// Await the capture before `finally` removes tempDir; returning the
		// pending `Bun.file(...).text()` races cleanup under parallel load.
		return await Bun.file(argsPath).text();
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

const nativeArtifactNames = [
	"pi-natives-linux-x64-baseline-htesthash",
	"pi-natives-linux-x64-modern-htesthash",
	"pi-natives-linux-arm64-htesthash",
	"pi-natives-linux-musl-x64-baseline-htesthash",
	"pi-natives-linux-musl-arm64-htesthash",
	"pi-natives-darwin-x64-baseline-htesthash",
	"pi-natives-darwin-arm64-htesthash",
	"pi-natives-win32-x64-baseline-htesthash",
];

async function nativeLookupWithCandidates(
	runList: string,
	artifacts: Record<string, string>,
	ancestorShas: readonly string[],
): Promise<{ args: string; output: string }> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omppp-ci-lookup-"));
	try {
		const gh = path.join(tempDir, "gh");
		const git = path.join(tempDir, "git");
		const argsPath = path.join(tempDir, "gh-run-args");
		const outputPath = path.join(tempDir, "github-output");
		await Bun.write(
			gh,
			`#!/usr/bin/env bash
if [ "$1" = "run" ]; then
\tprintf '%s\\n' "$@" > "$GH_ARGS"
\tprintf '%b' "$GH_RUN_LIST"
\texit 0
fi
if [ "$1" = "api" ]; then
\trun_id="\${2#*/runs/}"
\trun_id="\${run_id%%/*}"
	case "$run_id" in
${Object.entries(artifacts)
	.map(
		([runId, names]) =>
			`		${runId}) printf '%b' "${names.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$")}" ;;`,
	)
	.join("\n")}
		*) exit 1 ;;
	esac
	exit 0
fi
exit 1
`,
		);
		await Bun.write(
			git,
			`#!/usr/bin/env bash
if [ "$1" = "rev-parse" ] && [ "$2" = "--is-shallow-repository" ]; then
	echo false
	exit 0
fi
if [ "$1" = "fetch" ]; then
	exit 0
fi
if [ "$1" = "merge-base" ] && [ "$2" = "--is-ancestor" ]; then
	case "$3" in
${ancestorShas.map(sha => `		"${sha}") exit 0 ;;`).join("\n")}
		*) exit 1 ;;
	esac
fi
exit 1
`,
		);
		await fs.chmod(gh, 0o755);
		await fs.chmod(git, 0o755);
		const script = nativeArtifactLookupScript()
			.replace(sourceHashPlaceholder, "testhash")
			.replace(repositoryPlaceholder, "owner/repo")
			.replaceAll("gh ", '"$GH_BIN" ')
			.replaceAll("git ", '"$GIT_BIN" ');
		const proc = Bun.spawn(["bash", "-c", script], {
			env: {
				...Bun.env,
				GH_ARGS: argsPath,
				GH_BIN: gh,
				GH_RUN_LIST: runList,
				GIT_BIN: git,
				GITHUB_OUTPUT: outputPath,
				PATH: `${tempDir}:${Bun.env.PATH ?? ""}`,
			},
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) throw new Error(`native lookup script exited ${exitCode}`);
		return {
			args: await Bun.file(argsPath).text(),
			output: await Bun.file(outputPath).text(),
		};
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
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

	it("searches completed trusted push runs across main and release tags for native reuse", async () => {
		const args = await nativeLookupRunListArgs();
		expect(args).toContain("--status=completed");
		expect(args).toContain("--event=push");
		expect(args).not.toContain("--branch=main");
	});

	it("reuses each exact artifact only from a main-ancestor completed push run", async () => {
		const allArtifacts = `${nativeArtifactNames.join("\n")}\n`;
		const result = await nativeLookupWithCandidates(
			["200\tuntrusted-sha", "300\ttrusted-incomplete", "100\ttrusted-complete", ""].join("\n"),
			{
				"100": allArtifacts,
				"200": allArtifacts,
				"300": `${nativeArtifactNames.slice(0, -1).join("\n")}\n`,
			},
			["trusted-complete", "trusted-incomplete"],
		);
		expect(result.args).toContain("--status=completed");
		expect(result.args).toContain("--event=push");
		expect(result.output).toContain("darwin-x64-baseline-run-id=300");
		expect(result.output).toContain("win32-x64-baseline-run-id=100");
		expect(result.output).not.toContain("=200");
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
