import { describe, expect, test } from "bun:test";
import type { PreviewCanvasDocument } from "../src/product-preview/canvas-schema";
import { layoutCanvasNodes } from "../src/product-preview/client/canvas-layout";

function canvas(overrides: Partial<PreviewCanvasDocument> = {}): PreviewCanvasDocument {
	return {
		version: 1,
		title: "Layout fixture",
		artifactType: "plan",
		nodes: [
			{ id: "phase-a", type: "group", title: "Phase A" },
			{ id: "task-a", type: "card", title: "Task A", parentId: "phase-a" },
			{ id: "first", type: "card", title: "First" },
			{ id: "second", type: "card", title: "Second" },
		],
		edges: [{ id: "first-second", source: "first", target: "second", type: "sequence" }],
		...overrides,
	};
}

describe("layoutCanvasNodes", () => {
	test("places groups, children, and ordered nodes at the C5 intervals without mutating the artifact", () => {
		const input = canvas();
		const positioned = layoutCanvasNodes(input);

		expect(positioned.map(node => [node.id, node.position])).toEqual([
			["phase-a", { x: 0, y: 0 }],
			["task-a", { x: 24, y: 96 }],
			["first", { x: 362, y: 0 }],
			["second", { x: 682, y: 0 }],
		]);
		expect(input.nodes[0]?.position).toBeUndefined();
	});

	test("computes lane and group containment boxes around non-overlapping child rectangles", () => {
		const input = canvas({
			nodes: [
				{ id: "lane", type: "lane", title: "Lane" },
				{ id: "lane-first", type: "card", title: "Lane first", parentId: "lane" },
				{ id: "lane-second", type: "card", title: "Lane second", parentId: "lane" },
				{ id: "group", type: "group", title: "Group" },
				{ id: "group-first", type: "card", title: "Group first", parentId: "group" },
				{ id: "group-second", type: "card", title: "Group second", parentId: "group" },
			],
			edges: [],
		});

		const positioned = Object.fromEntries(layoutCanvasNodes(input).map(node => [node.id, node]));
		for (const parentId of ["lane", "group"]) {
			const parent = positioned[parentId]!;
			const first = positioned[`${parentId}-first`]!;
			const second = positioned[`${parentId}-second`]!;

			expect(parent.computedSize).toEqual({ width: 298, height: 356 });
			expect(first.position).toEqual({ x: 24, y: 96 });
			expect(second.position).toEqual({ x: 24, y: 236 });
			expect(first.position.y + 96).toBeLessThanOrEqual(second.position.y);
			expect(second.position.x + 250).toBeLessThanOrEqual(parent.computedSize!.width);
			expect(second.position.y + 96).toBeLessThanOrEqual(parent.computedSize!.height);
		}

		expect(input.nodes.map(node => [node.id, node.position, node.size])).toEqual([
			["lane", undefined, undefined],
			["lane-first", undefined, undefined],
			["lane-second", undefined, undefined],
			["group", undefined, undefined],
			["group-first", undefined, undefined],
			["group-second", undefined, undefined],
		]);
	});

	test("keeps a top-level flow rectangle clear of an auto-sized parent while children stay parent-relative", () => {
		const input = canvas({
			nodes: [
				{ id: "lane", type: "lane", title: "Lane" },
				{ id: "lane-first", type: "card", title: "Lane first", parentId: "lane" },
				{ id: "lane-second", type: "card", title: "Lane second", parentId: "lane" },
				{ id: "flow", type: "card", title: "Top-level flow", size: { width: 250, height: 96 } },
			],
			edges: [],
		});

		const positioned = Object.fromEntries(layoutCanvasNodes(input).map(node => [node.id, node]));
		const lane = positioned.lane!;
		const flow = positioned.flow!;

		expect(positioned["lane-first"]!.position).toEqual({ x: 24, y: 96 });
		expect(positioned["lane-second"]!.position).toEqual({ x: 24, y: 236 });

		const laneRight = lane.position.x + lane.computedSize!.width;
		const laneBottom = lane.position.y + lane.computedSize!.height;
		const flowRight = flow.position.x + flow.size!.width;
		const flowBottom = flow.position.y + flow.size!.height;
		expect(
			flowRight <= lane.position.x ||
				laneRight <= flow.position.x ||
				flowBottom <= lane.position.y ||
				laneBottom <= flow.position.y,
		).toBe(true);
	});

	test("preserves authored coordinates byte-for-byte and gives cycles stable source-order rows", () => {
		const authored = canvas({
			nodes: [
				{ id: "a", type: "card", title: "A", position: { x: -22, y: 18 } },
				{ id: "b", type: "card", title: "B", position: { x: 400, y: 12 } },
			],
			edges: [],
		});
		const authoredBefore = structuredClone(authored);

		expect(layoutCanvasNodes(authored).map(node => node.position)).toEqual([
			{ x: -22, y: 18 },
			{ x: 400, y: 12 },
		]);
		expect(authored).toEqual(authoredBefore);

		const cyclic = canvas({
			nodes: [
				{ id: "a", type: "card", title: "A" },
				{ id: "b", type: "card", title: "B" },
			],
			edges: [
				{ id: "ab", source: "a", target: "b", type: "dependency" },
				{ id: "ba", source: "b", target: "a", type: "dependency" },
			],
		});
		expect(layoutCanvasNodes(cyclic).map(node => node.position)).toEqual([
			{ x: 0, y: 0 },
			{ x: 0, y: 160 },
		]);
	});
});
