/**
 * Unit coverage for the advisor gist-only note artifact store.
 *
 * Fully dependency-injected: a fake `obfuscate`, a tmp `artifactsDir`, and a spy
 * `gistFn` exercise every path without touching a real session or model.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
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

afterEach(() => {
	vi.restoreAllMocks();
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
	it("renders short non-empty notes as a gist-only elision without leaking text", () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => undefined,
			obfuscate,
			gistEnabled: () => true,
			clampThreshold: () => 1,
		});
		const text = "a short SECRET thought";
		const out = store.renderThinking(text);

		expect(out).toMatch(/\{\{GIST:[a-z0-9]+\}\}/);
		expect(out).toContain(`[… ${obfuscate(text).length} chars elided]`);
		expect(out).not.toContain("full:");
		expect(out).not.toContain(text);
		expect(out).not.toContain("SECRET");
		expect(out).not.toContain("REDACTED");
	});

	it("renders large notes with the same gist-only shape and no verbatim head or tail", () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => undefined,
			obfuscate,
			gistEnabled: () => true,
			clampThreshold: () => 1,
		});
		const text = largeText();
		const out = store.renderThinking(text);

		expect(out).toMatch(/\{\{GIST:[a-z0-9]+\}\}/);
		expect(out).toContain(`[… ${obfuscate(text).length} chars elided]`);
		expect(out).not.toContain("full:");
		expect(out).not.toContain("SECRET");
		expect(out).not.toContain("REDACTED-head");
		expect(out).not.toContain("REDACTED-tail");
	});

	it("writes the full obfuscated artifact and sends the same source to the gist function", async () => {
		const dir = await makeTmpDir();
		const text = largeText();
		const obfuscated = obfuscate(text);
		const gistFn = vi.fn(async (excerpts: Array<{ id: string; text: string }>) => {
			return new Map(excerpts.map(e => [e.id, "- summarized safely"]));
		});
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			gistFn,
			clampThreshold: () => 1,
		});

		const out = store.renderThinking(text);
		const id = extractGistId(out);
		const artifactPath = join(dir, "__advisor-artifacts", `notes-${id}.md`);
		expect(out).toBe(
			`{{GIST:${id}}}\n[… ${obfuscated.length} chars elided — full: ${artifactPath} (read supports :start-end line ranges)]`,
		);
		expect(out).not.toContain("SECRET");
		expect(out).not.toContain("REDACTED-head");
		expect(out).not.toContain("REDACTED-tail");

		expect(await waitForFile(artifactPath)).toBe(true);
		await store.resolveGists(out);

		expect(await Bun.file(artifactPath).text()).toBe(obfuscated);
		expect(gistFn).toHaveBeenCalledTimes(1);
		expect(gistFn.mock.calls[0]?.[0]).toEqual([{ id, text: obfuscated }]);
	});

	it("returns obfuscated whitespace as-is without creating a gist", () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => undefined,
			obfuscate: text => `obfuscated:${text}`,
			gistEnabled: () => true,
		});
		const out = store.renderThinking(" \n\t ");

		expect(out).toBe("obfuscated: \n\t ");
		expect(out).not.toContain("{{GIST:");
	});

	it("defaults clamping off and forwards full obfuscated notes without spilling artifacts", async () => {
		const text = "SECRET full note";
		const obfuscated = obfuscate(text);
		const id = Bun.hash(text).toString(36);
		for (const clampThreshold of [undefined, () => 0] as const) {
			const dir = await makeTmpDir();
			const store = new ThinkingArtifactStore({
				artifactsDir: () => dir,
				obfuscate,
				gistEnabled: () => true,
				...(clampThreshold ? { clampThreshold } : {}),
			});

			const out = store.renderThinking(text);

			expect(out).toBe(obfuscated);
			expect(out).not.toContain("{{GIST:");
			expect(out).not.toContain("chars elided");
			expect(await Bun.file(join(dir, "__advisor-artifacts", `notes-${id}.md`)).exists()).toBe(false);
		}
	});

	it("keeps stable ids for identical text and evicts the oldest owned gist source past the cap", async () => {
		const resolvedIds: string[] = [];
		const store = new ThinkingArtifactStore({
			artifactsDir: () => undefined,
			obfuscate,
			gistEnabled: () => true,
			clampThreshold: () => 1,
			gistFn: async excerpts => {
				resolvedIds.push(...excerpts.map(e => e.id));
				return new Map(excerpts.map(e => [e.id, "- still owned"]));
			},
		});
		const first = store.renderThinking("SECRET note 0");
		const firstId = extractGistId(first);
		const second = store.renderThinking("SECRET note 1");
		const secondId = extractGistId(second);
		const repeatedFirstId = extractGistId(store.renderThinking("SECRET note 0"));
		expect(repeatedFirstId).toBe(firstId);
		for (let i = 2; i <= 64; i++) store.renderThinking(`SECRET note ${i}`);

		expect(await store.resolveGists(second)).toBe(second);

		const resolvedFirst = await store.resolveGists(first);
		expect(resolvedFirst).toContain("_gist:_ - still owned");
		expect(resolvedIds).toEqual([firstId]);
		expect(resolvedIds).not.toContain(secondId);
	});

	it("writes a single deduped artifact file for identical clamped text", async () => {
		const dir = await makeTmpDir();
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			clampThreshold: () => 1,
		});
		const text = largeText();
		const first = extractGistId(store.renderThinking(text));
		const second = extractGistId(store.renderThinking(text));
		expect(second).toBe(first);

		const artifactPath = join(dir, "__advisor-artifacts", `notes-${first}.md`);
		expect(await waitForFile(artifactPath)).toBe(true);
		const files = await readdir(join(dir, "__advisor-artifacts"));
		expect(files).toEqual([`notes-${first}.md`]);
	});
});

describe("ThinkingArtifactStore.resolveGists", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await makeTmpDir();
	});

	function renderedBatch(store: ThinkingArtifactStore): { batch: string; id: string; obfuscated: string } {
		const text = largeText();
		const rendered = store.renderThinking(text);
		return { batch: `before\n${rendered}\nafter`, id: extractGistId(rendered), obfuscated: obfuscate(text) };
	}

	it("substitutes cached gist bullets on success", async () => {
		let calls = 0;
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			clampThreshold: () => 1,
			gistFn: async excerpts => {
				calls++;
				return new Map(excerpts.map(e => [e.id, "- decided X\n- found Y"]));
			},
		});
		const { batch, id } = renderedBatch(store);
		const out = await store.resolveGists(batch);
		expect(calls).toBe(1);
		expect(out).toContain("_gist:_ - decided X");
		expect(out).not.toContain(`{{GIST:${id}}}`);

		const cached = await store.resolveGists(batch);
		expect(calls).toBe(1);
		expect(cached).toContain("_gist:_ - decided X");
	});

	it("passes the full obfuscated source as the gist excerpt", async () => {
		let received: Array<{ id: string; text: string }> = [];
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			clampThreshold: () => 1,
			gistFn: async excerpts => {
				received = excerpts;
				return new Map(excerpts.map(e => [e.id, "- excerpt captured"]));
			},
		});
		const { batch, id, obfuscated } = renderedBatch(store);

		await store.resolveGists(batch);

		expect(received).toEqual([{ id, text: obfuscated }]);
	});

	it("leaves unknown ids untouched", async () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			gistFn: async () => new Map(),
		});
		const batch = "user wrote {{GIST:zzz}} literally";
		const out = await store.resolveGists(batch);
		expect(out).toBe(batch);
	});

	it("substitutes empty string when gistFn returns null", async () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			clampThreshold: () => 1,
			gistFn: async () => null,
		});
		const { batch, id } = renderedBatch(store);
		const out = await store.resolveGists(batch);
		expect(out).not.toContain(`{{GIST:${id}}}`);
		expect(out).not.toContain("_gist:_");
	});

	it("substitutes empty string when gistFn throws", async () => {
		const store = new ThinkingArtifactStore({
			artifactsDir: () => dir,
			obfuscate,
			gistEnabled: () => true,
			clampThreshold: () => 1,
			gistFn: async () => {
				throw new Error("boom");
			},
		});
		const { batch, id } = renderedBatch(store);
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
			clampThreshold: () => 1,
			gistFn: async () => {
				calls++;
				return new Map();
			},
		});
		const { batch, id } = renderedBatch(store);
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
			clampThreshold: () => 1,
		});
		const { batch, id } = renderedBatch(store);
		const out = await store.resolveGists(batch);
		expect(out).not.toContain(`{{GIST:${id}}}`);
		expect(out).not.toContain("_gist:_");
	});
});
