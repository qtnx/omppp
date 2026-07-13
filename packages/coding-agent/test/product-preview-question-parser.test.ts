import { describe, expect, it } from "bun:test";
import { parseQuestionBlock } from "../src/product-preview/client/question-parser";

describe("parseQuestionBlock", () => {
	it("parses a single-choice question", () => {
		expect(
			parseQuestionBlock(
				'{"id":"layout","question":"Choose a layout","options":[{"label":"Sidebar"},{"label":"Tabs","description":"At the top"}]}',
			),
		).toEqual({
			id: "layout",
			question: "Choose a layout",
			options: [{ label: "Sidebar" }, { label: "Tabs", description: "At the top" }],
			multi: false,
		});
	});

	it("parses an explicit multi-choice question", () => {
		const parsed = parseQuestionBlock(
			'{"id":"roles","question":"Who can review?","options":[{"label":"Owners"},{"label":"Editors"}],"multi":true}',
		);
		expect(parsed?.multi).toBe(true);
	});

	it("returns null for invalid JSON", () => {
		expect(parseQuestionBlock("not json")).toBeNull();
	});

	it("returns null for fewer than two options", () => {
		expect(parseQuestionBlock('{"id":"one","question":"Pick","options":[{"label":"Only"}]}')).toBeNull();
	});

	it("returns null for a missing id", () => {
		expect(parseQuestionBlock('{"question":"Pick","options":[{"label":"One"},{"label":"Two"}]}')).toBeNull();
	});
});
