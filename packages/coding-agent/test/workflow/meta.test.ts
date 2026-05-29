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
		expect(extractMeta(`export const meta = { name: makeName(), description: "d" };`).metaError).toContain(
			"PURE LITERAL",
		);
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
