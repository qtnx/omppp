import { expect, test } from "bun:test";

import { sourceDeclarations } from "../native/index.js";

test("sourceDeclarations returns bounded declaration metadata", () => {
	const result = sourceDeclarations({
		code: `class Box {
\t#hidden() { return "SECRET_CANARY"; }
\ttail() { return "SECRET_CANARY"; }
}
function free() { return "SECRET_CANARY"; }
const arrow = () => "SECRET_CANARY";
`,
		path: "fixture.ts",
	});

	expect(result.parsed).toBe(true);
	expect(result.language).toBe("typescript");
	expect(result.declarations.map(declaration => declaration.name)).toEqual([
		"Box",
		"#hidden",
		"tail",
		"free",
		"arrow",
	]);
	expect(result.declarations[2]).toMatchObject({ startLine: 3, endLine: 3 });
	expect(result.declarations.every(declaration => !declaration.name.includes("SECRET_CANARY"))).toBe(true);
});

test("sourceDeclarations returns empty metadata for malformed and unsupported input", () => {
	expect(sourceDeclarations({ code: "function broken( {", path: "fixture.ts" })).toEqual({
		parsed: false,
		declarations: [],
	});
	expect(sourceDeclarations({ code: "plain text", path: "fixture.txt" })).toEqual({
		parsed: false,
		declarations: [],
	});
});
