import { describe, expect, it, mock } from "bun:test";
import type { Observation } from "../tab-protocol";

mock.module("../../../edit/diff", () => ({
	generateUnifiedDiffString: (oldContent: string, newContent: string) => {
		const oldLines = oldContent.split("\n");
		const newLines = newContent.split("\n");
		const output = [`@@ -1,${oldLines.length} +1,${newLines.length} @@`];
		let oldLine = 1;
		let newLine = 1;

		for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
			if (oldLines[i] === newLines[i]) {
				output.push(` ${oldLine}|${oldLines[i]}`);
				oldLine++;
				newLine++;
				continue;
			}
			if (oldLines[i] !== undefined) {
				output.push(`-${oldLine}|${oldLines[i]}`);
				oldLine++;
			}
			if (newLines[i] !== undefined) {
				output.push(`+${newLine}|${newLines[i]}`);
				newLine++;
			}
		}

		return { diff: output.join("\n"), firstChangedLine: undefined };
	},
}));

// Dynamic import is required so Bun installs the mock before snapshot-diff loads its shared diff dependency.
const { diffObservations, serializeObservation } = await import("../snapshot-diff");

function makeObservation(elementId: number): Observation {
	return {
		elements: [
			{ id: elementId, name: "Submit", role: "button", states: ["enabled"] },
			{ id: elementId + 1, name: "Email", role: "textbox", states: ["focused"], value: "a@example.com" },
		],
		scroll: { height: 600, scrollHeight: 1200, scrollWidth: 800, width: 800, x: 0, y: 10 },
		title: "Example",
		url: "https://example.test/form",
		viewport: { height: 600, width: 800 },
	};
}

describe("serializeObservation", () => {
	it("omits volatile element ids", () => {
		const first = serializeObservation(makeObservation(1));
		const second = serializeObservation(makeObservation(99));

		expect(first).toBe(second);
		expect(first).not.toContain("#1");
		expect(first).not.toContain("#99");
		expect(first).toContain('button "Submit" states=[enabled]');
		expect(first).toContain('textbox "Email" value="a@example.com" states=[focused]');
	});

	it("is stable for identical observations", () => {
		const obs = makeObservation(7);

		expect(serializeObservation(obs)).toBe(serializeObservation(obs));
	});
});

describe("diffObservations", () => {
	it("returns unchanged with empty diff for identical observations", () => {
		const obs = makeObservation(2);

		expect(diffObservations(obs, obs)).toEqual({ changed: false, diff: "" });
	});

	it("marks an added element in unified diff output", () => {
		const prev = makeObservation(3);
		const next: Observation = {
			...prev,
			elements: [
				...prev.elements,
				{ id: 500, name: "Remember me", role: "checkbox", states: ["checked"], value: "true" },
			],
		};

		const result = diffObservations(prev, next);

		expect(result.changed).toBe(true);
		expect(result.diff).toContain("@@");
		expect(result.diff).toContain('+6|checkbox "Remember me" value="true" states=[checked]');
		expect(result.diff).not.toContain("#500");
	});
});
