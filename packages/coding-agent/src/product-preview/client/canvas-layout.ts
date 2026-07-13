import type { PreviewCanvasDocument, PreviewCanvasNode } from "../canvas-schema";

export interface PositionedCanvasNode extends PreviewCanvasNode {
	position: { x: number; y: number };
	/** Layout-computed containment box for lane/group parents that omit size. */
	computedSize?: { width: number; height: number };
}

const GROUP_X = 360;
const CHILD_Y = 140;
const FLOW_X = 320;
const FLOW_Y = 160;
/** Child inset inside a parent lane/group and the box padding around children. */
const CHILD_INSET_X = 24;
const CHILD_TOP = 96;
const CHILD_WIDTH = 250;
const CHILD_HEIGHT = 96;
const GROUP_PAD_BOTTOM = 24;
const GROUP_MIN_WIDTH = CHILD_INSET_X * 2 + CHILD_WIDTH;
const ROOT_FLOW_GAP = 64;

/**
 * Applies the client-owned C5 layout without changing the artifact. Authored
 * coordinates always win; deterministic coordinates use source order as every
 * tie-breaker so a refresh never makes the canvas jump.
 */
export function layoutCanvasNodes(canvas: PreviewCanvasDocument): PositionedCanvasNode[] {
	if (canvas.nodes.every(node => node.position)) {
		return canvas.nodes.map(node => ({ ...node, position: node.position! }));
	}

	const sourceIndex = new Map(canvas.nodes.map((node, index) => [node.id, index]));
	const positioned = new Map<string, PositionedCanvasNode>();
	const topLevelGroups = canvas.nodes.filter(
		node => !node.parentId && (node.type === "lane" || node.type === "group"),
	);

	for (const [index, node] of topLevelGroups.entries()) {
		positioned.set(node.id, { ...node, position: { x: index * GROUP_X, y: 0 } });
	}

	for (const group of topLevelGroups) {
		const children = canvas.nodes.filter(node => node.parentId === group.id);
		for (const [index, child] of children.entries()) {
			positioned.set(child.id, { ...child, position: { x: CHILD_INSET_X, y: CHILD_TOP + index * CHILD_Y } });
		}
		// Size the parent from the child band so React Flow `extent: "parent"`
		// bounds each child to the group and children stay distinct/clickable.
		const groupNode = positioned.get(group.id);
		const count = Math.max(children.length, 1);
		if (groupNode && !groupNode.size) {
			groupNode.computedSize = {
				width: GROUP_MIN_WIDTH,
				height: CHILD_TOP + count * CHILD_Y - (CHILD_Y - CHILD_HEIGHT) + GROUP_PAD_BOTTOM,
			};
		}
	}

	const remaining = canvas.nodes.filter(node => !positioned.has(node.id));
	const remainingIds = new Set(remaining.map(node => node.id));
	const outgoing = new Map<string, string[]>();
	const indegree = new Map(remaining.map(node => [node.id, 0]));
	for (const edge of canvas.edges) {
		if (
			(edge.type !== "sequence" && edge.type !== "dependency") ||
			!remainingIds.has(edge.source) ||
			!remainingIds.has(edge.target)
		)
			continue;
		outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
		indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
	}

	const depth = new Map<string, number>();
	const queue = remaining.filter(node => indegree.get(node.id) === 0);
	for (const node of queue) depth.set(node.id, 0);
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const node = queue[cursor]!;
		for (const target of outgoing.get(node.id) ?? []) {
			depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(node.id) ?? 0) + 1));
			const next = (indegree.get(target) ?? 1) - 1;
			indegree.set(target, next);
			if (next === 0) queue.push(canvas.nodes.find(candidate => candidate.id === target)!);
		}
	}

	const flowBaseX =
		topLevelGroups.length === 0
			? 0
			: Math.max(
					...topLevelGroups.map(group => {
						const positionedGroup = positioned.get(group.id)!;
						const width = positionedGroup.size?.width ?? positionedGroup.computedSize?.width ?? GROUP_MIN_WIDTH;
						return positionedGroup.position.x + width;
					}),
				) + ROOT_FLOW_GAP;

	const rowByDepth = new Map<number, number>();
	let cycleRow = 0;
	for (const node of remaining) {
		const nodeDepth = depth.get(node.id);
		if (nodeDepth === undefined) {
			positioned.set(node.id, { ...node, position: { x: flowBaseX, y: cycleRow++ * FLOW_Y } });
			continue;
		}
		const row = rowByDepth.get(nodeDepth) ?? 0;
		rowByDepth.set(nodeDepth, row + 1);
		positioned.set(node.id, { ...node, position: { x: flowBaseX + nodeDepth * FLOW_X, y: row * FLOW_Y } });
	}

	return canvas.nodes.map(
		node => positioned.get(node.id) ?? { ...node, position: { x: flowBaseX, y: sourceIndex.get(node.id)! * FLOW_Y } },
	);
}
