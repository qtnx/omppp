/**
 * Unit coverage for the advisor thinking clamp + gist store.
 *
 * Fully dependency-injected: a fake `obfuscate`, a tmp `artifactsDir`, and a spy
 * `gistFn` exercise every path without touching a real session or model.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThinkingArtifactStore } from "@oh-my-pi/pi-coding-agent/advisor/thinking-artifacts";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "thinking-artifacts-"));
	tmpDirs.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(tmpDirs.map(dir => rm(dir, { recursive: true, force: true })));
});

/** Redact literal "SECRET" so we can assert obfuscation reached every surface. */
const obfuscate = (text: string): string => text.replaceAll("SECRET", "REDACTED");

/** A large thinking block whose head, middle, and tail each carry a secret. */
function largeText(): string {
	return `SECRET-head${"a".repeat(3000)}SECRET-tail`;
}

/** Poll until the fire-and-forget artifact write lands (or time out). */
async function waitForFile(path: string, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await Bun.file(path).exists()) return true;
		await Bun.sleep(10);
	}
	return false;
}

function extractGistId(rendered: string): string {
	const m = rendered.match(/\{\{GIST:([a-z0-9]+)\}\}/);
	if (!m) throw new Error(`no gist placeholder in: ${rendered}`);
	return m[1];
}

describe("ThinkingArtifactStore.renderThinking", () => {
	it("returns short text verbatim but obfuscated", () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => undefined,
			obfuscate,
			gistEnabled: () => true,
		});
		const out = store.renderThinking("a short SECRET thought");
		expect(out).toBe("a short REDACTED thought");
		expect(out).not.toContain("SECRET");
	});

	it("clamps large text to head + gist placeholder + elided marker with path + tail", async () => {
		const dir = await makeTmpDir();
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
		});
		const text = largeText();
		const out = store.renderThinking(text);

		// No raw secret leaks (head/tail were obfuscated).
		expect(out).not.toContain("SECRET");
		expect(out).toContain("REDACTED-head");
		expect(out).toContain("REDACTED-tail");

		const id = extractGistId(out);
		const artifactPath = join(dir, "__advisor-artifacts", `thinking-${id}.md`);
		expect(out).toContain(`{{GIST:${id}}}`);
		expect(out).toContain("chars elided — full:");
		expect(out).toContain(artifactPath);
		expect(out).toContain("read supports :start-end line ranges");

		// Middle char count reported.
		expect(out).toMatch(/\[… \d+ chars elided/);

		expect(await waitForFile(artifactPath)).toBe(true);
		const artifact = await Bun.file(artifactPath).text();
		expect(artifact).not.toContain("SECRET");
		expect(artifact).toContain("REDACTED-head");
		expect(artifact).toContain("REDACTED-tail");
	});

	it("passes full obfuscated text without writing an artifact when clamp threshold is disabled", async () => {
		const dir = await makeTmpDir();
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			clampThreshold: () => 0,
		});
		const text = largeText();
		const out = store.renderThinking(text);

		expect(out).toBe(obfuscate(text));
		expect(out).not.toContain("SECRET");
		expect(out).toContain("REDACTED-head");
		expect(out).toContain("REDACTED-tail");
		expect(out).not.toContain("{{GIST:");
		expect(await Bun.file(join(dir, "__advisor-artifacts")).exists()).toBe(false);
	});

	it("clamps text that exceeds a configured positive threshold", () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => undefined,
			obfuscate,
			gistEnabled: () => true,
			clampThreshold: () => 500,
		});
		const out = store.renderThinking("x".repeat(600));

		expect(out).toMatch(/\{\{GIST:[a-z0-9]+\}\}/);
	});

	it("omits the artifact path from the marker when no artifactsDir is configured", () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => undefined,
			obfuscate,
			gistEnabled: () => true,
		});
		const out = store.renderThinking(largeText());
		expect(out).toMatch(/\{\{GIST:[a-z0-9]+\}\}/);
		expect(out).toContain("chars elided]");
		expect(out).not.toContain("full:");
	});

	it("gives the same id and a single artifact file for identical text", async () => {
		const dir = await makeTmpDir();
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
		});
		const text = largeText();
		const first = extractGistId(store.renderThinking(text));
		const second = extractGistId(store.renderThinking(text));
		expect(second).toBe(first);

		const artifactPath = join(dir, "__advisor-artifacts", `thinking-${first}.md`);
		expect(await waitForFile(artifactPath)).toBe(true);
		const files = await readdir(join(dir, "__advisor-artifacts"));
		expect(files).toEqual([`thinking-${first}.md`]);
	});
});

describe("ThinkingArtifactStore.resolveGists", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await makeTmpDir();
	});

	function clampedBatch(store: ThinkingArtifactStore): { batch: string; id: string } {
		const rendered = store.renderThinking(largeText());
		return { batch: `before\n${rendered}\nafter`, id: extractGistId(rendered) };
	}

	it("substitutes gist bullets on success", async () => {
		let calls = 0;
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			gistFn: async excerpts => {
				calls++;
				return new Map(excerpts.map(e => [e.id, "- decided X\n- found Y"]));
			},
		});
		const { batch, id } = clampedBatch(store);
		const out = await store.resolveGists(batch);
		expect(calls).toBe(1);
		expect(out).toContain("_gist:_ - decided X");
		expect(out).not.toContain(`{{GIST:${id}}}`);
	});

	it("uses the cache on the second pass and does not call gistFn again", async () => {
		let calls = 0;
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			gistFn: async excerpts => {
				calls++;
				return new Map(excerpts.map(e => [e.id, "- cached bullet"]));
			},
		});
		const { batch } = clampedBatch(store);
		await store.resolveGists(batch);
		const out = await store.resolveGists(batch);
		expect(calls).toBe(1);
		expect(out).toContain("_gist:_ - cached bullet");
	});

	it("leaves unknown ids untouched", async () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			gistFn: async () => new Map(),
		});
		const batch = "user wrote {{GIST:notarealid}} literally";
		const out = await store.resolveGists(batch);
		expect(out).toBe(batch);
	});

	it("substitutes empty string when gistFn returns null", async () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			gistFn: async () => null,
		});
		const { batch, id } = clampedBatch(store);
		const out = await store.resolveGists(batch);
		expect(out).not.toContain(`{{GIST:${id}}}`);
		expect(out).not.toContain("_gist:_");
	});

	it("substitutes empty string when gistFn throws", async () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			gistFn: async () => {
				throw new Error("boom");
			},
		});
		const { batch, id } = clampedBatch(store);
		const out = await store.resolveGists(batch);
		expect(out).not.toContain(`{{GIST:${id}}}`);
		expect(out).not.toContain("_gist:_");
	});

	it("substitutes empty string without calling gistFn when disabled", async () => {
		let calls = 0;
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => false,
			gistFn: async () => {
				calls++;
				return new Map();
			},
		});
		const { batch, id } = clampedBatch(store);
		const out = await store.resolveGists(batch);
		expect(calls).toBe(0);
		expect(out).not.toContain(`{{GIST:${id}}}`);
		expect(out).not.toContain("_gist:_");
	});

	it("substitutes empty string when gistFn is absent", async () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
		});
		const { batch, id } = clampedBatch(store);
		const out = await store.resolveGists(batch);
		expect(out).not.toContain(`{{GIST:${id}}}`);
		expect(out).not.toContain("_gist:_");
	});
});
