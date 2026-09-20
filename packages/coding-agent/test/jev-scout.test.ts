import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { JevError } from "@oh-my-pi/pi-coding-agent/jev/systemone";
import { scoutSource } from "@oh-my-pi/pi-coding-agent/jev/scout";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { JevScoutTool } from "@oh-my-pi/pi-coding-agent/tools/jev-scout";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

const TS_SOURCE = `export const VERSION = "1";

export function unrelatedHelper(input: string): string {
	return input.trim();
}

export function evictExpiredEntries(now: number, entries: Map<string, number>): number {
	let removed = 0;
	for (const [key, expiresAt] of entries) {
		if (expiresAt > now) continue;
		entries.delete(key);
		removed += 1;
	}
	return removed;
}
`;

const PY_SOURCE = `VERSION = "1"


def unrelated_helper(value):
    return value.strip()


def evict_expired_entries(now, entries):
    removed = 0
    for key in list(entries):
        if entries[key] <= now:
            del entries[key]
            removed += 1
    return removed
`;

type Recorded = { url: string; body: { state: unknown; questions: Record<string, unknown>; model: string } };

/** Fake System One endpoint: records every request and answers from a per-call planner. */
function fakeJev(plan: (body: Recorded["body"], index: number) => Record<string, unknown>): {
	fetchImpl: typeof fetch;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Recorded["body"];
		calls.push({ url: String(url), body });
		return new Response(
			JSON.stringify({
				model: body.model,
				answers: plan(body, calls.length - 1),
				usage: { input_tokens: 10, output_tokens: 2 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

function choiceAnswer(ids: string[], winner: string) {
	const probabilities: Record<string, number> = {};
	for (const id of ids) probabilities[id] = id === winner ? 1 : 0;
	return { type: "choice", choice: winner, probabilities, confidence: 0.9 };
}

/** Answer the navigation question by picking the observed id whose path ends with `suffix`. */
function pickPath(body: Recorded["body"], suffix: string) {
	const state = body.state as { entries: Array<{ id: string; path: string }> };
	const ids = Object.keys((body.questions["navigation::pick"] as { criteria: Record<string, null> }).criteria);
	const match = state.entries.find(entry => entry.path.endsWith(suffix));
	return {
		"navigation::pick": choiceAnswer(ids, match?.id ?? "NONE"),
		"navigation::present": { type: "noul", noul: match ? 0.95 : 0.02 },
	};
}

/** Answer the location question by picking the option whose outline text contains `needle`. */
function pickOutline(body: Recorded["body"], needle: string) {
	const state = body.state as { files: Array<{ id: string; outline: string }> };
	const ids = Object.keys((body.questions["location::pick"] as { criteria: Record<string, null> }).criteria);
	let winner = "NONE";
	for (const file of state.files) {
		for (const line of file.outline.split("\n")) {
			const range = /^(\d+)-\d+:/.exec(line);
			if (range && line.includes(needle)) {
				const candidate = `${file.id}:l${range[1]}`;
				if (ids.includes(candidate)) winner = candidate;
			}
		}
	}
	return {
		"location::pick": choiceAnswer(ids, winner),
		"location::present": { type: "noul", noul: winner === "NONE" ? 0.02 : 0.95 },
	};
}

let root = "";
const originalEndpoint = Bun.env.TYPESAFE_SYSTEMONE_URL;

beforeEach(async () => {
	Bun.env.TYPESAFE_SYSTEMONE_URL = "http://scout.test/v1/systemone";
	root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-scout-"));
});

afterEach(async () => {
	if (originalEndpoint === undefined) delete Bun.env.TYPESAFE_SYSTEMONE_URL;
	else Bun.env.TYPESAFE_SYSTEMONE_URL = originalEndpoint;
	await fs.rm(root, { recursive: true, force: true });
});

describe("scoutSource file navigation", () => {
	it("navigates a directory and returns the selected TypeScript declaration verbatim", async () => {
		await fs.mkdir(path.join(root, "src", "cache"), { recursive: true });
		await fs.writeFile(path.join(root, "src", "cache", "evict.ts"), TS_SOURCE);
		await fs.writeFile(path.join(root, "README.md"), "# docs\n");
		const { fetchImpl, calls } = fakeJev((body, index) => {
			if (index === 0) return pickPath(body, "src");
			if (index === 1) return pickPath(body, "src/cache");
			if (index === 2) return pickPath(body, "evict.ts");
			return pickOutline(body, "evictExpiredEntries");
		});

		const result = await scoutSource({ query: "where are expired cache entries removed?", path: root, fetchImpl });

		expect(result.status).toBe("found");
		expect(result.excerpts).toHaveLength(1);
		const excerpt = result.excerpts[0]!;
		expect(excerpt.path).toBe(path.join(root, "src", "cache", "evict.ts"));
		expect(excerpt.text).toStartWith("export function evictExpiredEntries(");
		expect(excerpt.text.trimEnd()).toEndWith("}");
		expect(excerpt.text).toContain("return removed;");
		expect(excerpt.text).not.toContain("unrelatedHelper");
		const lines = excerpt.text.split("\n");
		expect(excerpt.endLine - excerpt.startLine + 1).toBe(lines.length);
		expect(
			TS_SOURCE.split("\n")
				.slice(excerpt.startLine - 1, excerpt.endLine)
				.join("\n"),
		).toBe(excerpt.text);
		expect(result.filesRead).toBe(1);
		expect(result.requests).toBe(calls.length);
		expect(result.inputTokens).toBe(10 * calls.length);
	});

	it("resolves the chosen Python function through the same outline path", async () => {
		const file = path.join(root, "evict.py");
		await fs.writeFile(file, PY_SOURCE);
		const { fetchImpl } = fakeJev(body => pickOutline(body, "evict_expired_entries"));

		const result = await scoutSource({ query: "which function drops expired entries?", path: file, fetchImpl });

		expect(result.status).toBe("found");
		const excerpt = result.excerpts[0]!;
		expect(excerpt.text).toStartWith("def evict_expired_entries(now, entries):");
		expect(excerpt.text).toContain("return removed");
		expect(excerpt.text).not.toContain("unrelated_helper");
	});

	it("reports no_match instead of an irrelevant excerpt when Jev selects NONE", async () => {
		const file = path.join(root, "evict.ts");
		await fs.writeFile(file, TS_SOURCE);
		const { fetchImpl } = fakeJev(body => {
			const ids = Object.keys((body.questions["location::pick"] as { criteria: Record<string, null> }).criteria);
			return { "location::pick": choiceAnswer(ids, "NONE"), "location::present": { type: "noul", noul: 0.03 } };
		});

		const result = await scoutSource({ query: "where is the OAuth token refreshed?", path: file, fetchImpl });

		expect(result.status).toBe("no_match");
		expect(result.excerpts).toEqual([]);
	});

	it("stops without reading files when the listing reports no route to the query", async () => {
		await fs.mkdir(path.join(root, "docs"), { recursive: true });
		await fs.writeFile(path.join(root, "docs", "notes.md"), "notes\n");
		const { fetchImpl, calls } = fakeJev(body => {
			const ids = Object.keys((body.questions["navigation::pick"] as { criteria: Record<string, null> }).criteria);
			return { "navigation::pick": choiceAnswer(ids, "NONE"), "navigation::present": { type: "noul", noul: 0.01 } };
		});

		const result = await scoutSource({ query: "where is the payment ledger written?", path: root, fetchImpl });

		expect(result.status).toBe("no_match");
		expect(result.filesRead).toBe(0);
		expect(calls).toHaveLength(1);
	});

	// Explicit body mode tries an outline first; default metadata never escalates.
	const MEDIUM_SOURCE = `${Array.from(
		{ length: 50 },
		(_, index) =>
			`export function pad${index}(value: number): number {\n\tconst step = value + ${index};\n\treturn step * 2;\n}\n`,
	).join("\n")}\n${TS_SOURCE}`;

	it("offers bodies only after rejection when the explicit setting permits them", async () => {
		const file = path.join(root, "evict.ts");
		await Bun.write(file, MEDIUM_SOURCE);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "removed += 1;"));

		const result = await scoutSource({
			query: "expired entry removal",
			path: file,
			sourceDetail: "bodies",
			fetchImpl,
		});

		const outlineOf = (call: (typeof calls)[number]) =>
			(call.body.state as { files: Array<{ outline: string }> }).files[0]!.outline;
		expect(calls).toHaveLength(2);
		expect(outlineOf(calls[0]!)).not.toContain("removed += 1;");
		expect(outlineOf(calls[1]!)).toContain("removed += 1;");
		expect(result.excerpts[0]!.text).toStartWith("export function evictExpiredEntries");
	});

	it("does not re-send bodies when the first ranking round already answered", async () => {
		const file = path.join(root, "evict.ts");
		await fs.writeFile(file, TS_SOURCE);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "evictExpiredEntries"));

		const result = await scoutSource({ query: "expired entry removal", path: file, fetchImpl });

		expect(calls).toHaveLength(1);
		expect(result.status).toBe("found");
	});

	it("re-reads the file so a later edit changes the returned excerpt", async () => {
		const file = path.join(root, "evict.ts");
		await fs.writeFile(file, TS_SOURCE);
		const { fetchImpl } = fakeJev(body => pickOutline(body, "evictExpiredEntries"));
		const before = await scoutSource({ query: "expired entry removal", path: file, fetchImpl });
		expect(before.excerpts[0]!.text).toContain("removed += 1;");

		await fs.writeFile(file, TS_SOURCE.replace("removed += 1;", "removed += 2; // changed"));
		const after = await scoutSource({ query: "expired entry removal", path: file, fetchImpl });

		expect(after.excerpts[0]!.text).toContain("removed += 2; // changed");
	});

	it("returns the enclosing declaration when the picked line is a statement inside it", async () => {
		const file = path.join(root, "evict.ts");
		await fs.writeFile(file, TS_SOURCE);
		const { fetchImpl } = fakeJev(body => pickOutline(body, "removed += 1;"));

		const result = await scoutSource({
			query: "expired entry removal",
			path: file,
			sourceDetail: "outline",
			fetchImpl,
		});

		expect(result.excerpts[0]!.text).toStartWith("export function evictExpiredEntries");
		expect(result.excerpts[0]!.startLine).toBe(7);
		expect(result.excerpts[0]!.endLine).toBe(15);
	});

	it("keeps bodies and absolute paths out of the default request", async () => {
		const file = path.join(root, "evict.ts");
		// A 15-line file: under the previous 160/240 unfold it went out WHOLE, so
		// this fixture is what distinguishes headers-only from the old behaviour.
		await Bun.write(file, TS_SOURCE);
		const { fetchImpl, calls } = fakeJev(body => {
			const ids = Object.keys((body.questions["location::pick"] as { criteria: Record<string, null> }).criteria);
			return { "location::pick": choiceAnswer(ids, "NONE"), "location::present": { type: "noul", noul: 0.02 } };
		});

		const result = await scoutSource({ query: "expired entry removal", path: file, fetchImpl });

		const state = calls[0]!.body.state as { files: Array<{ path: string; outline: string }> };
		expect(calls.length).toBeLessThanOrEqual(3);
		expect(result.status).toBe("no_match");
		expect(state.files[0]!.path).toBe("evict.ts");
		expect(state.files[0]!.outline).toContain("function evictExpiredEntries");
		expect(state.files[0]!.outline).not.toContain("removed += 1;");
		expect(JSON.stringify(state)).not.toContain(root);
	});

	// Data formats contain no declaration names; none of their values may leave.
	it.each([
		["values.yaml", "db_password: hunter2-in-a-config", `service: api\n{SECRET}\nreplicas: 3\n`],
		["secrets.json", `"token": "sk-live-not-a-real-key"`, `{\n  "service": "api",\n  {SECRET}\n}\n`],
	])("skips %s instead of shipping its whole content", async (name, secretish, template) => {
		const file = path.join(root, name);
		await Bun.write(file, template.replace("{SECRET}", secretish));
		const { fetchImpl, calls } = fakeJev(body => {
			const ids = Object.keys((body.questions["location::pick"] as { criteria: Record<string, null> }).criteria);
			return { "location::pick": choiceAnswer(ids, "NONE"), "location::present": { type: "noul", noul: 0.02 } };
		});

		const result = await scoutSource({ query: "where is the database password configured?", path: file, fetchImpl });

		expect(result.status).toBe("no_match");
		expect(result.truncated).toBeTrue();
		expect(calls).toEqual([]);
		expect(result.warnings.join(" ")).toContain(name);
		expect(JSON.stringify(calls.map(call => call.body.state))).not.toContain(secretish);
	});

	it("sends directory listings as paths relative to the scout root", async () => {
		await fs.mkdir(path.join(root, "src", "cache"), { recursive: true });
		await Bun.write(path.join(root, "src", "cache", "evict.ts"), TS_SOURCE);
		const { fetchImpl, calls } = fakeJev((body, index) => {
			if (index === 0) return pickPath(body, "src");
			if (index === 1) return pickPath(body, "src/cache");
			if (index === 2) return pickPath(body, "evict.ts");
			return pickOutline(body, "evictExpiredEntries");
		});

		await scoutSource({ query: "where are expired cache entries removed?", path: root, fetchImpl });

		const first = calls[0]!.body.state as { directory: string; entries: Array<{ path: string }> };
		expect(first.directory).toBe(".");
		expect(first.entries.map(entry => entry.path)).toContain("src");
		expect(calls.every(call => !JSON.stringify(call.body.state).includes(root))).toBeTrue();
	});

	it("withholds an excerpt when the ranked pick is not backed by the presence answer", async () => {
		const file = path.join(root, "evict.ts");
		await fs.writeFile(file, TS_SOURCE);
		const { fetchImpl } = fakeJev(body => ({
			...pickOutline(body, "evictExpiredEntries"),
			"location::present": { type: "noul", noul: 0.04 },
		}));

		const result = await scoutSource({ query: "where is the retry backoff computed?", path: file, fetchImpl });

		expect(result.status).toBe("no_match");
		expect(result.excerpts).toEqual([]);
	});
});

describe("scoutSource provider contract", () => {
	it("keeps the query and source out of the questions and redacts state before sending", async () => {
		const file = path.join(root, "evict.ts");
		await fs.writeFile(file, `${TS_SOURCE}\nconst token = "sk-live-SECRET";\n`);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "evictExpiredEntries"));

		await scoutSource({
			query: "expired entry removal",
			path: file,
			fetchImpl,
			redact: text => text.replaceAll("sk-live-SECRET", "[redacted]"),
		});

		const request = calls.at(-1)!;
		const questions = JSON.stringify(request.body.questions);
		expect(questions).not.toContain("expired entry removal");
		expect(questions).not.toContain("evictExpiredEntries");
		const state = JSON.stringify(request.body.state);
		expect(state).toContain("expired entry removal");
		expect(state).not.toContain("sk-live-SECRET");
	});

	it("rejects a malformed choice answer instead of guessing a location", async () => {
		const file = path.join(root, "evict.ts");
		await fs.writeFile(file, TS_SOURCE);
		const { fetchImpl } = fakeJev(() => ({
			"location::pick": { type: "choice", choice: "f0:l999", probabilities: { "f0:l999": 1 }, confidence: 1 },
		}));

		const failure = await scoutSource({ query: "expired entry removal", path: file, fetchImpl }).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(JevError);
		expect((failure as JevError).kind).toBe("invalid");
	});

	it("fails closed when the endpoint is explicitly disabled", async () => {
		Bun.env.TYPESAFE_SYSTEMONE_URL = "";
		const file = path.join(root, "evict.ts");
		await fs.writeFile(file, TS_SOURCE);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "evictExpiredEntries"));

		const failure = await scoutSource({ query: "expired entry removal", path: file, fetchImpl }).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(JevError);
		expect((failure as JevError).kind).toBe("unavailable");
		expect(calls).toEqual([]);
	});

	it("propagates cancellation without sending a request", async () => {
		const file = path.join(root, "evict.ts");
		await fs.writeFile(file, TS_SOURCE);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "evictExpiredEntries"));
		const controller = new AbortController();
		controller.abort();

		const failure = await scoutSource({
			query: "expired entry removal",
			path: file,
			fetchImpl,
			signal: controller.signal,
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect(calls).toEqual([]);
	});

	it("rejects an empty query and a missing path before contacting the provider", async () => {
		const { fetchImpl, calls } = fakeJev(() => ({}));

		await expect(scoutSource({ query: "   ", path: root, fetchImpl })).rejects.toThrow(/query/i);
		await expect(scoutSource({ query: "anything", path: path.join(root, "absent.ts"), fetchImpl })).rejects.toThrow(
			/missing or inaccessible/i,
		);
		expect(calls).toEqual([]);
	});
});

describe("jev_scout tool entrypoint", () => {
	it("scrubs configured session secrets out of the source it sends to Jev", async () => {
		// A secrets.yml-style plain entry: not a vault row and not a credential
		// pattern, so only the real session obfuscator can catch it.
		const configured = "correct-horse-battery-staple-42";
		const file = path.join(root, "config.ts");
		await Bun.write(file, `export function loadDeployToken() {\n\treturn "${configured}";\n}\n`);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "loadDeployToken"));
		using fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
		const obfuscator = new SecretObfuscator([{ type: "plain", content: configured, mode: "replace" }], "test-key");
		const tool = new JevScoutTool({
			cwd: root,
			hasUI: false,
			redactOutboundText: (text: string) => obfuscator.obfuscate(text),
			settings: Settings.isolated({}),
		} as unknown as ToolSession);

		const result = await tool.execute("call-1", {
			query: `deploy token loading ${configured}`,
			path: file,
			max_files: 1,
		});

		expect(fetchSpy).toHaveBeenCalled();
		const sent = JSON.stringify(calls.at(-1)!.body);
		expect(sent).not.toContain(configured);
		expect(sent).toContain("loadDeployToken");
		// The excerpt is read from disk after the request, so the caller still sees real source.
		expect(result.details?.excerpts[0]!.text).toContain(configured);
	});

	it("retries with bodies only after an outlined selection is rejected and the setting permits it", async () => {
		const file = path.join(root, "evict.ts");
		const padded = `${Array.from(
			{ length: 50 },
			(_, index) =>
				`export function pad${index}(value: number): number {\n\tconst step = value + ${index};\n\treturn step * 2;\n}\n`,
		).join("\n")}\n${TS_SOURCE}`;
		await Bun.write(file, padded);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "removed += 1;"));
		using fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
		const settings = Settings.isolated({ "signals.scoutSourceDetail": "bodies" });
		const tool = new JevScoutTool({ cwd: root, hasUI: false, settings } as unknown as ToolSession);

		const result = await tool.execute("call-1", { query: "expired entry removal", path: file, max_files: 1 });

		expect(fetchSpy).toHaveBeenCalled();
		expect(JSON.stringify(calls[0]!.body.state)).not.toContain("removed += 1;");
		expect(JSON.stringify(calls.at(-1)!.body.state)).toContain("removed += 1;");
		expect(calls.length).toBeLessThanOrEqual(3);
		expect(result.details?.excerpts[0]!.text).toStartWith("export function evictExpiredEntries");
	});
});

describe("scoutSource scope reporting", () => {
	it("marks scope truncated and warns when the file budget stops the walk", async () => {
		await fs.mkdir(path.join(root, "a"), { recursive: true });
		await fs.mkdir(path.join(root, "b"), { recursive: true });
		await fs.writeFile(path.join(root, "a", "one.ts"), TS_SOURCE);
		await fs.writeFile(path.join(root, "b", "two.ts"), TS_SOURCE);
		const { fetchImpl } = fakeJev((body, index) => {
			if (body.questions["location::pick"]) return pickOutline(body, "evictExpiredEntries");
			const state = body.state as { entries: Array<{ id: string; path: string }> };
			const ids = Object.keys((body.questions["navigation::pick"] as { criteria: Record<string, null> }).criteria);
			const answer = choiceAnswer(ids, state.entries[0]?.id ?? "NONE");
			if (index === 0) {
				answer.probabilities[state.entries[0]!.id] = 0.6;
				answer.probabilities[state.entries[1]!.id] = 0.4;
			}
			return {
				"navigation::pick": answer,
				"navigation::present": { type: "noul", noul: 0.9 },
			};
		});

		const result = await scoutSource({ query: "expired entry removal", path: root, maxFiles: 1, fetchImpl });

		expect(result.filesRead).toBe(1);
		expect(result.truncated).toBeTrue();
		expect(result.warnings.join(" ")).toContain("absence is not proven");
	});

	it("tries a lower-ranked file after rejection without reading the same file again", async () => {
		await Bun.write(path.join(root, "one.ts"), "export function unrelated() { return 1; }\n");
		await Bun.write(path.join(root, "two.ts"), TS_SOURCE);
		const { fetchImpl } = fakeJev(body => {
			if (body.questions["location::pick"]) return pickOutline(body, "evictExpiredEntries");
			const state = body.state as { entries: Array<{ id: string; path: string }> };
			const answer = choiceAnswer(["NONE", ...state.entries.map(entry => entry.id)], state.entries[0]!.id);
			answer.probabilities[state.entries[0]!.id] = 0.7;
			answer.probabilities[state.entries[1]!.id] = 0.3;
			return { "navigation::pick": answer, "navigation::present": { type: "noul", noul: 0.9 } };
		});
		const result = await scoutSource({ query: "expired entry removal", path: root, maxFiles: 2, fetchImpl });
		expect(result.excerpts[0]?.path).toBe(path.join(root, "two.ts"));
		expect(result.filesRead).toBe(2);
	});

	it("skips an oversized file with a warning instead of reading it", async () => {
		const file = path.join(root, "huge.ts");
		await fs.writeFile(file, `// pad\n${"x".repeat(2 * 1024 * 1024 + 1)}\n`);
		const { fetchImpl, calls } = fakeJev(() => ({}));

		const result = await scoutSource({ query: "expired entry removal", path: file, fetchImpl });

		expect(result.status).toBe("no_match");
		expect(result.filesRead).toBe(0);
		expect(result.truncated).toBeTrue();
		expect(result.warnings.join(" ")).toContain("oversized");
		expect(calls).toEqual([]);
	});

	it("batches a listing wider than one request so the tail is still offered", async () => {
		await fs.mkdir(path.join(root, "wide"), { recursive: true });
		for (let index = 0; index < 205; index++) {
			await fs.writeFile(path.join(root, "wide", `mod${String(index).padStart(3, "0")}.ts`), TS_SOURCE);
		}
		const offered = new Set<string>();
		const { fetchImpl } = fakeJev(body => {
			if (body.questions["location::pick"]) return pickOutline(body, "evictExpiredEntries");
			const state = body.state as { entries: Array<{ id: string; path: string }> };
			for (const entry of state.entries) offered.add(entry.path);
			return pickPath(body, "mod204.ts");
		});

		const result = await scoutSource({ query: "expired entry removal", path: path.join(root, "wide"), fetchImpl });

		expect(offered.size).toBe(205);
		expect(result.filesRead).toBeGreaterThanOrEqual(1);
		expect(result.excerpts[0]!.path).toEndWith("mod204.ts");
	});

	it("finds a declaration in a second file without exceeding the provider option limit", async () => {
		const fillers = Array.from({ length: 150 }, (_, index) => `export const value${index} = ${index};`).join("\n");
		await Bun.write(path.join(root, "a.ts"), fillers);
		await Bun.write(path.join(root, "b.ts"), `export function targetBehavior() { return 42; }\n${fillers}`);
		const { fetchImpl } = fakeJev(body => {
			if (body.questions["location::pick"]) {
				const question = body.questions["location::pick"] as { criteria: Record<string, null> };
				if (Object.keys(question.criteria).length > 255) throw new Error("Provider rejects more than 255 options");
				return pickOutline(body, "targetBehavior");
			}
			const state = body.state as { entries: Array<{ id: string; path: string }> };
			const answer = choiceAnswer(["NONE", ...state.entries.map(entry => entry.id)], state.entries[0]!.id);
			answer.probabilities[state.entries[0]!.id] = 0.6;
			answer.probabilities[state.entries[1]!.id] = 0.4;
			return { "navigation::pick": answer, "navigation::present": { type: "noul", noul: 0.9 } };
		});

		const result = await scoutSource({ query: "target behavior", path: root, maxFiles: 2, fetchImpl });
		expect(result.filesRead).toBe(2);
		expect(result.excerpts).toEqual([
			{
				path: path.join(root, "b.ts"),
				startLine: 1,
				endLine: 1,
				text: "export function targetBehavior() { return 42; }",
			},
		]);
	});
});

describe("scoutSource bounded metadata search", () => {
	it("finds a method beyond the former header cap without exposing its body", async () => {
		const file = path.join(root, "large.ts");
		await Bun.write(
			file,
			`class Workflows {\n${Array.from(
				{ length: 900 },
				(_, index) => `other${index}() { return "BODY_CANARY"; }`,
			).join("\n")}\ndelayedWorkflow() { return "BODY_CANARY"; }\n}`,
		);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "delayedWorkflow"));
		const result = await scoutSource({ query: "delayed workflow", path: file, fetchImpl });
		expect(result.excerpts[0]?.startLine).toBe(902);
		expect(result.excerpts[0]?.text).toStartWith("delayedWorkflow()");
		expect(JSON.stringify(calls)).not.toContain("BODY_CANARY");
	});

	it("continues onto an unseen declaration page after a rejected page", async () => {
		const file = path.join(root, "pages.ts");
		await Bun.write(
			file,
			Array.from({ length: 310 }, (_, index) => `export function action${index}() { return ${index}; }`).join("\n"),
		);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "action300"));
		const result = await scoutSource({ query: "behavior lookup", path: file, fetchImpl });
		expect(result.excerpts[0]?.startLine).toBe(301);
		expect(calls).toHaveLength(2);
		const ids = calls.flatMap(call =>
			Object.keys((call.body.questions["location::pick"] as { criteria: Record<string, null> }).criteria).filter(
				id => id !== "NONE",
			),
		);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("sends names but no one-line bodies, signature defaults, imports, comments, or computed-name literals", async () => {
		const file = path.join(root, "private.ts");
		await Bun.write(
			file,
			`import other from "IMPORT_CANARY";
// COMMENT_CANARY
class Box {
  safe(value = "DEFAULT_CANARY") { return \`TEMPLATE_CANARY\`; }
  ["KEY_CANARY"]() { return "BODY_CANARY"; }
}
export function InternalTenant42() { return "BODY_CANARY"; }`,
		);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "SanitizedTenant"));
		const result = await scoutSource({
			query: "tenant behavior",
			path: file,
			fetchImpl,
			redact: text => text.replaceAll("InternalTenant42", "SanitizedTenant"),
		});
		expect(result.excerpts[0]?.text).toContain("InternalTenant42");
		const outbound = JSON.stringify(calls);
		expect(outbound).toContain("SanitizedTenant");
		for (const forbidden of [
			"IMPORT_CANARY",
			"COMMENT_CANARY",
			"DEFAULT_CANARY",
			"TEMPLATE_CANARY",
			"KEY_CANARY",
			"BODY_CANARY",
			"InternalTenant42",
		]) {
			expect(outbound).not.toContain(forbidden);
		}
	});

	it("stops after three disjoint pages and reports incomplete coverage", async () => {
		const file = path.join(root, "many.ts");
		await Bun.write(
			file,
			Array.from({ length: 1000 }, (_, index) => `export function action${index}() { return ${index}; }`).join("\n"),
		);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "absentBehavior"));
		const result = await scoutSource({ query: "absent behavior", path: file, fetchImpl });
		expect(result.status).toBe("no_match");
		expect(result.truncated).toBeTrue();
		expect(calls).toHaveLength(3);
		const ids = calls.flatMap(call =>
			Object.keys((call.body.questions["location::pick"] as { criteria: Record<string, null> }).criteria).filter(
				id => id !== "NONE",
			),
		);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("rejects an invalid detail policy before sending source", async () => {
		const { fetchImpl, calls } = fakeJev(() => ({}));
		await expect(
			scoutSource({ query: "lookup", path: root, sourceDetail: "invalid" as never, fetchImpl }),
		).rejects.toThrow(/sourceDetail/);
		expect(calls).toEqual([]);
	});

	it("enforces the serialized-state ceiling after redaction expands a field", async () => {
		const file = path.join(root, "small.ts");
		await Bun.write(file, TS_SOURCE);
		const { fetchImpl, calls } = fakeJev(body => pickOutline(body, "evictExpiredEntries"));
		const result = await scoutSource({
			query: "expand",
			path: file,
			fetchImpl,
			redact: text => (text === "expand" ? "x".repeat(40_000) : text),
		});
		expect(result.status).toBe("no_match");
		expect(result.truncated).toBeTrue();
		expect(calls).toEqual([]);
	});

	it("stops navigation before cumulative redacted state exceeds the call budget", async () => {
		const file = path.join(root, ...Array.from({ length: 8 }, (_, index) => `level${index}`), "target.ts");
		await Bun.write(file, TS_SOURCE);
		const { fetchImpl, calls } = fakeJev(body => {
			const state = body.state as { entries: Array<{ path: string }> };
			return pickPath(body, state.entries[0]!.path);
		});
		const result = await scoutSource({ query: "x".repeat(30_000), path: root, fetchImpl });
		const sizes = calls.map(call => new TextEncoder().encode(JSON.stringify(call.body.state)).byteLength);
		expect(result.status).toBe("no_match");
		expect(result.truncated).toBeTrue();
		expect(calls).toHaveLength(6);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(32 * 1024);
		expect(sizes.reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(192 * 1024);
	});
});
