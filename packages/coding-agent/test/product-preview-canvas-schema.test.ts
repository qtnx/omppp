import { describe, expect, it } from "bun:test";
import { parseCanvasDocument } from "@oh-my-pi/pi-coding-agent/product-preview/canvas-schema";

function validCanvas(
	artifactType: "spec" | "story-map" | "journey-map" | "plan" | "architecture" = "spec",
): Record<string, unknown> {
	return {
		version: 1,
		title: "Review canvas",
		artifactType,
		nodes: [
			{
				id: "root",
				type: "group",
				title: "Root",
				refs: [{ label: "Product brief", path: "briefs/product.md", anchor: "scope" }],
			},
			{ id: "child", type: "card", title: "Child", parentId: "root" },
		],
		edges: [{ id: "root-child", source: "root", target: "child", type: "sequence" }],
	};
}

function expectInvalid(value: unknown, field: string): void {
	const result = parseCanvasDocument(JSON.stringify(value));
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("Expected invalid canvas");
	expect(result.error).toMatchObject({ code: "invalid_canvas", field });
}

describe("parseCanvasDocument", () => {
	it.each(["spec", "story-map", "journey-map", "plan", "architecture"] as const)(
		"accepts a bounded %s artifact",
		artifactType => {
			const result = parseCanvasDocument(JSON.stringify(validCanvas(artifactType)));

			expect(result).toMatchObject({ ok: true, layout: "deterministic", canvas: { version: 1, artifactType } });
		},
	);

	it("preserves fully authored positions and reports authored layout without computing positions", () => {
		const canvas = validCanvas();
		const nodes = canvas.nodes as Array<Record<string, unknown>>;
		nodes[0]!.position = { x: -20, y: 40 };
		nodes[1]!.position = { x: 800, y: 120 };

		const result = parseCanvasDocument(JSON.stringify(canvas));

		expect(result).toMatchObject({
			ok: true,
			layout: "authored",
			canvas: { nodes: [{ position: { x: -20, y: 40 } }, { position: { x: 800, y: 120 } }] },
		});
	});

	it("rejects mixed, malformed, and out-of-range positions at their field", () => {
		const mixed = validCanvas();
		const mixedNodes = mixed.nodes as Array<Record<string, unknown>>;
		mixedNodes[0]!.position = { x: 0, y: 0 };
		expectInvalid(mixed, "nodes[1].position");

		const malformed = validCanvas();
		const malformedNodes = malformed.nodes as Array<Record<string, unknown>>;
		malformedNodes[0]!.position = { x: "left", y: 0 };
		expectInvalid(malformed, "nodes[0].position.x");

		const outOfRange = validCanvas();
		const outOfRangeNodes = outOfRange.nodes as Array<Record<string, unknown>>;
		outOfRangeNodes[0]!.position = { x: 1_000_001, y: 0 };
		expectInvalid(outOfRange, "nodes[0].position.x");
	});

	it("rejects unsafe references and unknown executable fields", () => {
		const unsafe = validCanvas();
		const unsafeNodes = unsafe.nodes as Array<Record<string, unknown>>;
		unsafeNodes[0]!.refs = [{ label: "Outside", path: "../secrets.md" }];
		expectInvalid(unsafe, "nodes[0].refs[0].path");

		const url = validCanvas();
		const urlNodes = url.nodes as Array<Record<string, unknown>>;
		urlNodes[0]!.refs = [{ label: "Remote", path: "https://example.test/spec" }];
		expectInvalid(url, "nodes[0].refs[0].path");

		const executable = validCanvas();
		const executableNodes = executable.nodes as Array<Record<string, unknown>>;
		executableNodes[0]!.html = "<script>alert(1)</script>";
		expectInvalid(executable, "nodes[0].html");
	});

	it("rejects duplicate ids, dangling graph endpoints, and cyclic parents", () => {
		const duplicate = validCanvas();
		const duplicateNodes = duplicate.nodes as Array<Record<string, unknown>>;
		duplicateNodes[1]!.id = "root";
		expectInvalid(duplicate, "nodes[1].id");

		const dangling = validCanvas();
		const danglingEdges = dangling.edges as Array<Record<string, unknown>>;
		danglingEdges[0]!.target = "missing";
		expectInvalid(dangling, "edges[0].target");

		const cyclic = validCanvas();
		const cyclicNodes = cyclic.nodes as Array<Record<string, unknown>>;
		cyclicNodes[0]!.parentId = "child";
		expectInvalid(cyclic, "nodes");
	});

	it("rejects malformed JSON and artifacts over the byte cap", () => {
		const malformed = parseCanvasDocument("{");
		expect(malformed).toMatchObject({ ok: false, error: { code: "invalid_canvas", field: "$" } });

		const oversized = `{"version":1,"title":"${"a".repeat(2 * 1024 * 1024)}"}`;
		const result = parseCanvasDocument(oversized);
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_canvas", field: "$" } });
	});
});
