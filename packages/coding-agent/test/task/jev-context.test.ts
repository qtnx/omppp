import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as jev from "../../src/jev/systemone";
import { selectRelevantContext } from "../../src/task/jev-context";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});
function available() {
	spies.push(spyOn(jev, "jevAvailable").mockReturnValue(true));
}
function choice(value: string, confidence = 0.9) {
	return {
		choice: value,
		confidence,
		probabilities: Object.fromEntries(
			["required", "supporting", "superseded", "irrelevant"].map(key => [key, key === value ? 0.85 : 0.05]),
		),
	};
}
const snapshot =
	"# Snapshot\n\n## Old\nPublish release notes.\n\n## Constraint\nNever publish without approval.\n\n## Correction\nOnly fix locally; do not publish release notes.";

describe("selectRelevantContext", () => {
	it("keeps current constraints and correction in chronological order, omitting superseded instructions", async () => {
		available();
		const result = await selectRelevantContext({
			assignment: "fix locally",
			snapshot,
			post: async () => ({
				answers: {
					"ctx::0": choice("superseded"),
					"ctx::1": choice("required", 0.8),
					"ctx::2": choice("required", 0.99),
				},
			}),
		});
		expect(result.sections).toEqual([
			"## Constraint\nNever publish without approval.",
			"## Correction\nOnly fix locally; do not publish release notes.",
		]);
		expect(result.requiresFullSnapshot).toBe(false);
	});
	it("deduplicates normalized sections at their latest original position and scrubs all outgoing state", async () => {
		available();
		const result = await selectRelevantContext({
			assignment: "CANARY",
			context: "CANARY",
			snapshot: "## Same\nCANARY\n\n## Other\ncontext\n\n## Same\nCANARY",
			redact: text => text.replaceAll("CANARY", "[hidden]"),
			post: async request => {
				expect(JSON.stringify(request)).not.toContain("CANARY");
				expect(Object.keys(request.questions)).toEqual(["ctx::1", "ctx::2"]);
				expect(JSON.stringify(request.questions)).not.toContain("## Other");
				return { answers: { "ctx::1": choice("supporting"), "ctx::2": choice("required") } };
			},
		});
		expect(result.sections).toEqual(["## Other\ncontext", "## Same\nCANARY"]);
	});
	it("never emits a fragment of a required section when the excerpt cannot fit", async () => {
		available();
		const result = await selectRelevantContext({
			assignment: "fix",
			snapshot,
			maxChars: 20,
			post: async () => ({
				answers: { "ctx::0": choice("irrelevant"), "ctx::1": choice("required"), "ctx::2": choice("required") },
			}),
		});
		expect(result.sections).toEqual([]);
		expect(result.requiresFullSnapshot).toBe(true);
	});
	it("enforces both candidate bounds and marks omitted context incomplete", async () => {
		available();
		const result = await selectRelevantContext({
			assignment: "fix",
			snapshot: Array.from({ length: 45 }, (_, n) => `## ${n}\n${"x".repeat(1000)}`).join("\n\n"),
			post: async request => {
				const state = request.state as { sections: Array<{ id: number; text: string }>; omitted_sections: number };
				expect(state.sections.length).toBeLessThanOrEqual(40);
				expect(state.sections.reduce((sum, section) => sum + section.text.length, 0)).toBeLessThanOrEqual(16000);
				expect(state.omitted_sections).toBeGreaterThan(0);
				return {
					answers: Object.fromEntries(state.sections.map(section => [`ctx::${section.id}`, choice("required")])),
				};
			},
		});
		expect(result.requiresFullSnapshot).toBe(true);
	});
	it("falls back to the full snapshot for unavailable or malformed judgments", async () => {
		available();
		for (const post of [
			async () => {
				throw new jev.JevError("offline", "connection");
			},
			async () => ({ answers: {} }),
		]) {
			const result = await selectRelevantContext({ assignment: "fix", snapshot, post });
			expect(result.sections).toEqual([]);
			expect(result.requiresFullSnapshot).toBe(true);
		}
	});
});
