import {
	Background,
	BackgroundVariant,
	Controls,
	type Edge,
	Handle,
	MiniMap,
	type Node,
	type NodeProps,
	Position,
	ReactFlow,
	type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PreviewCanvasDocument, PreviewCanvasNode, PreviewCanvasNodeStatus } from "../canvas-schema";
import type { BundleItem, PreviewCommentWire } from "../types";
import { layoutCanvasNodes } from "./canvas-layout";
import "@xyflow/react/dist/style.css";
import "./canvas-app.css";

export interface CanvasNodeSelection {
	itemId: string;
	nodeId: string;
	title: string;
}

export interface CanvasUpdate {
	item: BundleItem;
	canvas: PreviewCanvasDocument;
	comments: PreviewCommentWire[];
}

/** Resolves a canvas ref path to a manifest item id, or null when unresolved. */
export type CanvasRefResolver = (path: string) => string | null;
/** Navigates the host shell to a manifest item id. */
export type CanvasRefNavigator = (itemId: string) => void;

export interface ProductPreviewCanvasHost {
	mount(
		element: HTMLElement,
		input: CanvasUpdate & {
			onNodeSelected(node: CanvasNodeSelection): void;
			onOpenComment(node: CanvasNodeSelection): void;
			resolveRef?: CanvasRefResolver;
			onNavigateRef?: CanvasRefNavigator;
		},
	): ProductPreviewCanvasHandle;
}

export interface ProductPreviewCanvasHandle {
	update(input: CanvasUpdate): void;
	focusNode(nodeId: string): void;
	fitView(): void;
	destroy(): void;
}
interface FlowNodeData extends Record<string, unknown> {
	node: PreviewCanvasNode;
	status: PreviewCanvasNodeStatus;
	onSelect(node: PreviewCanvasNode): void;
	onOpenDetail(node: PreviewCanvasNode, trigger?: HTMLElement): void;
}

interface CanvasController {
	update(input: CanvasUpdate): void;
	focusNode(nodeId: string): void;
	fitView(): void;
}

function makeSelection(item: BundleItem, node: PreviewCanvasNode): CanvasNodeSelection {
	return { itemId: item.id, nodeId: node.id, title: node.title };
}

function toFlowNodes(
	canvas: PreviewCanvasDocument,
	onSelect: (node: PreviewCanvasNode) => void,
	onOpenDetail: (node: PreviewCanvasNode, trigger?: HTMLElement) => void,
): Node<FlowNodeData>[] {
	const positioned = layoutCanvasNodes(canvas);
	const sizeById = new Map<string, { width: number; height: number }>();
	for (const node of positioned) {
		const size = node.size ?? node.computedSize;
		if (size) sizeById.set(node.id, size);
	}
	return positioned.map(node => {
		const size = node.size ?? node.computedSize ?? sizeById.get(node.id);
		return {
			id: node.id,
			type: "reviewNode",
			position: node.position,
			parentId: node.parentId,
			// Bound children to their parent box so each child stays distinct and
			// a physical click lands on the intended child, never the parent alone.
			extent: node.parentId ? "parent" : undefined,
			style: size ? { width: size.width, height: size.height } : undefined,
			data: { node, status: node.status ?? "ready", onSelect, onOpenDetail },
		};
	});
}

function toFlowEdges(canvas: PreviewCanvasDocument): Edge[] {
	return canvas.edges.map(edge => ({
		id: edge.id,
		source: edge.source,
		target: edge.target,
		label: edge.label,
		type: "smoothstep",
		animated: edge.type === "sequence",
	}));
}

const STATUS_META: Record<PreviewCanvasNodeStatus, { label: string; glyph: string; cls: string }> = {
	draft: { label: "Draft", glyph: "○", cls: "is-draft" },
	ready: { label: "Ready", glyph: "○", cls: "is-ready" },
	blocked: { label: "Blocked", glyph: "⚠", cls: "is-blocked" },
	done: { label: "Done", glyph: "✓", cls: "is-done" },
};

function StatusBadge({ status }: { status: PreviewCanvasNodeStatus }) {
	const meta = STATUS_META[status];
	return (
		<span className={`preview-canvas-node__status ${meta.cls}`} aria-label={`Status: ${meta.label}`}>
			<span className="preview-canvas-node__status-glyph" aria-hidden="true">
				{meta.glyph}
			</span>
			{meta.label}
		</span>
	);
}

function ReviewNode({ data, selected }: NodeProps<Node<FlowNodeData>>) {
	const { node, status, onSelect, onOpenDetail } = data;
	return (
		<button
			type="button"
			className={`preview-canvas-node preview-canvas-node--${node.type} preview-canvas-node--role-${node.role ?? "neutral"} ${selected ? "is-selected" : ""}`}
			onClick={() => onSelect(node)}
			onDoubleClick={event => onOpenDetail(node, event.currentTarget)}
			// Enter on the focused node opens detail; a single tap/click only selects.
			onKeyDown={event => {
				if (event.key === "Enter") {
					event.preventDefault();
					onOpenDetail(node, event.currentTarget);
				}
			}}
			aria-label={`${node.title}, ${STATUS_META[status].label}`}
		>
			<Handle type="target" position={Position.Left} />
			<StatusBadge status={status} />
			<strong className="preview-canvas-node__title">{node.title}</strong>
			{node.body ? <span className="preview-canvas-node__body">{node.body}</span> : null}
			{node.refs?.length ? (
				<span className="preview-canvas-node__refs-count" aria-hidden="true">
					{node.refs.length} ref{node.refs.length === 1 ? "" : "s"}
				</span>
			) : null}
			<Handle type="source" position={Position.Right} />
		</button>
	);
}

function CanvasIsland({
	initial,
	onNodeSelected,
	onOpenComment,
	resolveRef,
	onNavigateRef,
	controller,
}: {
	initial: CanvasUpdate & {
		resolveRef?: CanvasRefResolver;
		onNavigateRef?: CanvasRefNavigator;
	};
	onNodeSelected(node: CanvasNodeSelection): void;
	onOpenComment(node: CanvasNodeSelection): void;
	controller: { current: CanvasController | null };
}) {
	const [input, setInput] = useState(initial);
	const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
	const [showMinimap, setShowMinimap] = useState(true);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<PreviewCanvasNode | null>(null);
	const dialogRef = useRef<HTMLDialogElement>(null);
	const lastTrigger = useRef<HTMLElement | null>(null);
	const wrapperRef = useRef<HTMLElement | null>(null);

	const selectNode = (node: PreviewCanvasNode) => {
		// Selection only highlights + notifies the host. It never opens the rail,
		// so a single tap never covers the canvas with the comment composer.
		setSelected(node);
		onNodeSelected(makeSelection(input.item, node));
	};
	const openDetail = (node: PreviewCanvasNode, trigger?: HTMLElement) => {
		lastTrigger.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
		setSelected(node);
		dialogRef.current?.showModal();
	};
	const nodeTypes = useMemo(() => ({ reviewNode: ReviewNode }), []);
	const selectNodeCb = useCallback(selectNode, [input.item]);
	const openDetailCb = useCallback(openDetail, []);
	const nodes = useMemo(
		() => toFlowNodes(input.canvas, selectNodeCb, openDetailCb),
		[input.canvas, selectNodeCb, openDetailCb],
	);
	const edges = useMemo(() => toFlowEdges(input.canvas), [input.canvas]);

	const focusNode = (nodeId: string) => {
		const node = input.canvas.nodes.find(candidate => candidate.id === nodeId);
		if (!node) return;
		flow?.fitView({ nodes: [{ id: nodeId }], duration: 160, padding: 0.5 });
		setSelected(node);
	};
	const resetLayout = () => flow?.setNodes(toFlowNodes(input.canvas, selectNodeCb, openDetailCb));
	useEffect(() => {
		controller.current = {
			update: setInput,
			focusNode,
			fitView: () => flow?.fitView({ duration: 160, padding: 0.2 }),
		};
		return () => {
			controller.current = null;
		};
	});
	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		const restoreFocus = () => lastTrigger.current?.focus();
		dialog.addEventListener("close", restoreFocus);
		return () => dialog.removeEventListener("close", restoreFocus);
	}, []);

	// Keyboard: do not steal keystrokes from inputs, textareas, the dialog, or
	// while focus is inside the toolbar. Only the flow surface owns these.
	const isTypingTarget = (target: EventTarget | null): boolean => {
		const element = target instanceof HTMLElement ? target : null;
		if (!element) return false;
		const tag = element.tagName;
		return (
			tag === "INPUT" ||
			tag === "TEXTAREA" ||
			tag === "SELECT" ||
			element.isContentEditable ||
			element.closest("dialog") !== null ||
			element.closest(".preview-canvas__toolbar") !== null
		);
	};
	const onKeyDown = (event: React.KeyboardEvent) => {
		if (isTypingTarget(event.target)) return;
		switch (event.key) {
			case "Escape":
				if (dialogRef.current?.open) return; // the <dialog> owns Escape while open
				if (selected) {
					setSelected(null);
					event.preventDefault();
				}
				break;
			case "0":
				flow?.fitView({ duration: 160, padding: 0.2 });
				event.preventDefault();
				break;
			case "+":
			case "=":
				flow?.zoomIn();
				event.preventDefault();
				break;
			case "-":
			case "_":
				flow?.zoomOut();
				event.preventDefault();
				break;
			case "ArrowLeft":
			case "ArrowRight":
			case "ArrowUp":
			case "ArrowDown": {
				moveNodeFocus(event.key);
				event.preventDefault();
				break;
			}
		}
	};
	const moveNodeFocus = (key: string) => {
		const host = wrapperRef.current;
		if (!host) return;
		const nodeEls = [...host.querySelectorAll<HTMLElement>(".react-flow__node:not(.hidden)")];
		if (!nodeEls.length) return;
		const active = nodeEls.find(el => el.contains(document.activeElement));
		const center = (el: HTMLElement) => {
			const r = el.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2, el };
		};
		const points = nodeEls.map(center);
		if (!active) {
			points.sort((a, b) => a.y - b.y || a.x - b.x)[0]?.el.focus();
			return;
		}
		const origin = center(active);
		const dir = {
			x: key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0,
			y: key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0,
		};
		let best: { score: number; el: HTMLElement } | null = null;
		for (const p of points) {
			if (p.el === active) continue;
			const dx = p.x - origin.x;
			const dy = p.y - origin.y;
			if (dir.x && Math.sign(dx) !== dir.x) continue;
			if (dir.y && Math.sign(dy) !== dir.y) continue;
			// Must move in the intended axis; the cross axis is secondary weight.
			if (dir.x && Math.abs(dx) < 1) continue;
			if (dir.y && Math.abs(dy) < 1) continue;
			const along = dir.x ? Math.abs(dx) : Math.abs(dy);
			const across = dir.x ? Math.abs(dy) : Math.abs(dx);
			const score = along + across * 2.5;
			if (!best || score < best.score) best = { score, el: p.el };
		}
		best?.el.focus();
	};

	const matches = query.trim().toLowerCase()
		? input.canvas.nodes.filter(node =>
				`${node.title} ${node.body ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
			)
		: [];
	return (
		<section
			className="preview-canvas"
			aria-label={`${input.canvas.title} canvas`}
			aria-busy={!flow}
			ref={wrapperRef}
			onKeyDown={onKeyDown}
		>
			<div className="preview-canvas__toolbar" role="toolbar" aria-label="Canvas controls">
				<label className="sr-only" htmlFor="canvas-search">
					Search canvas
				</label>
				<input
					id="canvas-search"
					value={query}
					onChange={event => setQuery(event.target.value)}
					placeholder="Search nodes"
				/>
				<button type="button" onClick={() => matches[0] && focusNode(matches[0].id)} disabled={!matches.length}>
					Find node
				</button>
				<button type="button" onClick={() => flow?.zoomOut()} aria-label="Zoom out">
					Zoom out
				</button>
				<button type="button" onClick={() => flow?.zoomIn()} aria-label="Zoom in">
					Zoom in
				</button>
				<button type="button" onClick={() => flow?.fitView({ duration: 160, padding: 0.2 })}>
					Fit view
				</button>
				<button type="button" onClick={resetLayout}>
					Reset layout
				</button>
				<button type="button" onClick={() => setShowMinimap(value => !value)} aria-pressed={showMinimap}>
					Minimap
				</button>
				<button
					type="button"
					onClick={event => selected && openDetail(selected, event.currentTarget)}
					disabled={!selected}
				>
					Open detail
				</button>
			</div>
			<div className="preview-canvas__flow">
				<ReactFlow
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					onInit={setFlow}
					onNodeClick={(_, node) => selectNodeCb((node.data as FlowNodeData).node)}
					fitView
					fitViewOptions={{ padding: 0.2 }}
					minZoom={0.1}
					maxZoom={4}
					nodesDraggable
					aria-label={`${input.canvas.title} flow`}
				>
					<Background variant={BackgroundVariant.Dots} gap={18} size={1} />
					<Controls showInteractive={false} />
					{showMinimap ? <MiniMap pannable zoomable /> : null}
				</ReactFlow>
			</div>
			{selected ? (
				<div className="preview-canvas__selection" role="status">
					<span className="preview-canvas__selection-context">Selected: {selected.title}</span>
					<button type="button" onClick={() => onOpenComment(makeSelection(input.item, selected))}>
						Send feedback
					</button>
					<button type="button" onClick={event => openDetail(selected, event.currentTarget)}>
						Open detail
					</button>
				</div>
			) : (
				<p className="preview-canvas__hint">
					Select a node to highlight it. Choose Send feedback to comment, or double-click for detail.
				</p>
			)}
			<dialog
				className="preview-canvas-dialog"
				ref={dialogRef}
				aria-labelledby="canvas-detail-title"
				onClick={event => {
					if (event.target === event.currentTarget) dialogRef.current?.close();
				}}
			>
				<div className="preview-canvas-dialog__body">
					<h2 id="canvas-detail-title">{selected?.title ?? "Canvas detail"}</h2>
					{selected?.status ? <StatusBadge status={selected.status} /> : null}
					{selected?.body ? <p>{selected.body}</p> : <p>No additional detail for this node.</p>}
					{selected?.refs?.length ? (
						<ul className="preview-canvas-dialog__refs">
							{selected.refs.map(ref => {
								const targetId = resolveRef?.(ref.path);
								if (targetId) {
									return (
										<li key={`${ref.path}:${ref.label}`}>
											<button
												type="button"
												className="preview-canvas-ref"
												onClick={() => {
													dialogRef.current?.close();
													onNavigateRef?.(targetId);
												}}
											>
												{ref.label}
											</button>
										</li>
									);
								}
								return (
									<li
										key={`${ref.path}:${ref.label}`}
										className="preview-canvas-ref preview-canvas-ref--inert"
									>
										{ref.label}
									</li>
								);
							})}
						</ul>
					) : null}
					<div className="preview-canvas-dialog__actions">
						{selected ? (
							<button type="button" onClick={() => onOpenComment(makeSelection(input.item, selected))}>
								Send feedback
							</button>
						) : null}
						<button type="button" onClick={() => dialogRef.current?.close()}>
							Close
						</button>
					</div>
				</div>
			</dialog>
		</section>
	);
}

function mount(
	element: HTMLElement,
	input: CanvasUpdate & {
		onNodeSelected(node: CanvasNodeSelection): void;
		onOpenComment(node: CanvasNodeSelection): void;
		resolveRef?: CanvasRefResolver;
		onNavigateRef?: CanvasRefNavigator;
	},
): ProductPreviewCanvasHandle {
	const root: Root = createRoot(element);
	const controller: { current: CanvasController | null } = { current: null };
	root.render(
		<CanvasIsland
			initial={input}
			onNodeSelected={input.onNodeSelected}
			onOpenComment={input.onOpenComment}
			resolveRef={input.resolveRef}
			onNavigateRef={input.onNavigateRef}
			controller={controller}
		/>,
	);
	return {
		update(next) {
			controller.current?.update(next);
		},
		focusNode(nodeId) {
			controller.current?.focusNode(nodeId);
		},
		fitView() {
			controller.current?.fitView();
		},
		destroy() {
			root.unmount();
		},
	};
}

Object.assign(globalThis, { ProductPreviewCanvasHost: { mount } satisfies ProductPreviewCanvasHost });
