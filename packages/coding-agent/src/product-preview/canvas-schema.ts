const MAX_CANVAS_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 2_000;
const MAX_EDGES = 4_000;
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 4_000;
const MAX_EDGE_LABEL_LENGTH = 200;
const MAX_REF_PATH_LENGTH = 512;
const MAX_REF_ANCHOR_LENGTH = 256;
const MAX_REFS_PER_NODE = 100;
const MAX_COORDINATE = 1_000_000;
const MIN_VIEWPORT_ZOOM = 0.1;
const MAX_VIEWPORT_ZOOM = 4;

const ARTIFACT_TYPES = ["spec", "story-map", "journey-map", "plan", "architecture"] as const;
const NODE_TYPES = ["card", "lane", "group", "milestone", "decision", "actor", "step"] as const;
const EDGE_TYPES = ["sequence", "dependency", "association", "decision"] as const;
const NODE_STATUSES = ["draft", "ready", "blocked", "done"] as const;
const NODE_ROLES = ["primary", "secondary", "risk", "success", "neutral"] as const;

export type PreviewCanvasArtifactType = (typeof ARTIFACT_TYPES)[number];
export type PreviewCanvasNodeType = (typeof NODE_TYPES)[number];
export type PreviewCanvasEdgeType = (typeof EDGE_TYPES)[number];
export type PreviewCanvasNodeStatus = (typeof NODE_STATUSES)[number];
export type PreviewCanvasNodeRole = (typeof NODE_ROLES)[number];
export type PreviewCanvasLayout = "authored" | "deterministic";

export interface PreviewCanvasPosition {
	x: number;
	y: number;
}

export interface PreviewCanvasSize {
	width: number;
	height: number;
}

export interface PreviewCanvasRef {
	label: string;
	path: string;
	anchor?: string;
}

export interface PreviewCanvasNode {
	id: string;
	type: PreviewCanvasNodeType;
	position?: PreviewCanvasPosition;
	size?: PreviewCanvasSize;
	parentId?: string;
	title: string;
	body?: string;
	status?: PreviewCanvasNodeStatus;
	role?: PreviewCanvasNodeRole;
	refs?: PreviewCanvasRef[];
}

export interface PreviewCanvasEdge {
	id: string;
	source: string;
	target: string;
	type?: PreviewCanvasEdgeType;
	label?: string;
}

export interface PreviewCanvasViewport {
	x: number;
	y: number;
	zoom: number;
}

export interface PreviewCanvasDocument {
	version: 1;
	title: string;
	artifactType: PreviewCanvasArtifactType;
	description?: string;
	nodes: PreviewCanvasNode[];
	edges: PreviewCanvasEdge[];
	viewport?: PreviewCanvasViewport;
}

export interface CanvasValidationError {
	code: "invalid_canvas";
	message: string;
	field: string;
}

export interface CanvasParseSuccess {
	ok: true;
	canvas: PreviewCanvasDocument;
	layout: PreviewCanvasLayout;
}

export interface CanvasParseFailure {
	ok: false;
	error: CanvasValidationError;
}

export type CanvasParseResult = CanvasParseSuccess | CanvasParseFailure;

class CanvasValidationFailure extends Error {
	field: string;

	constructor(field: string, message: string) {
		super(message);
		this.field = field;
	}
}

/** Parses a complete version-1 canvas artifact without computing any layout. */
export function parseCanvasDocument(source: string | Uint8Array): CanvasParseResult {
	try {
		const text = typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true }).decode(source);
		if (new TextEncoder().encode(text).byteLength > MAX_CANVAS_BYTES) {
			throw new CanvasValidationFailure("$", "Canvas artifact exceeds 2 MiB");
		}
		const parsed = JSON.parse(text) as unknown;
		const canvas = parseDocument(parsed);
		const positionedNodes = canvas.nodes.filter(node => node.position !== undefined).length;
		if (positionedNodes !== 0 && positionedNodes !== canvas.nodes.length) {
			const firstMissing = canvas.nodes.findIndex(node => node.position === undefined);
			throw new CanvasValidationFailure(
				`nodes[${firstMissing}].position`,
				"Node positions must be supplied for every node or omitted for every node",
			);
		}
		return { ok: true, canvas, layout: positionedNodes === 0 ? "deterministic" : "authored" };
	} catch (error) {
		if (error instanceof CanvasValidationFailure) {
			return { ok: false, error: { code: "invalid_canvas", message: error.message, field: error.field } };
		}
		return { ok: false, error: { code: "invalid_canvas", message: "Canvas artifact is not valid JSON", field: "$" } };
	}
}

function parseDocument(value: unknown): PreviewCanvasDocument {
	const record = expectRecord(value, "$");
	expectOnlyKeys(record, "$", ["version", "title", "artifactType", "description", "nodes", "edges", "viewport"]);
	if (record.version !== 1) throw new CanvasValidationFailure("version", "Canvas version must be 1");
	const title = expectString(record.title, "title", 1, MAX_TITLE_LENGTH);
	const artifactType = expectEnum(record.artifactType, "artifactType", ARTIFACT_TYPES);
	const description = optionalString(record.description, "description", 0, MAX_TEXT_LENGTH);
	const nodeValues = expectArray(record.nodes, "nodes", MAX_NODES);
	const edgeValues = expectArray(record.edges, "edges", MAX_EDGES);
	const nodes = nodeValues.map((node, index) => parseNode(node, `nodes[${index}]`));
	const edges = edgeValues.map((edge, index) => parseEdge(edge, `edges[${index}]`));
	const viewport = record.viewport === undefined ? undefined : parseViewport(record.viewport);
	validateGraph(nodes, edges);
	return {
		version: 1,
		title,
		artifactType,
		...(description === undefined ? {} : { description }),
		nodes,
		edges,
		...(viewport === undefined ? {} : { viewport }),
	};
}

function parseNode(value: unknown, field: string): PreviewCanvasNode {
	const record = expectRecord(value, field);
	expectOnlyKeys(record, field, [
		"id",
		"type",
		"position",
		"size",
		"parentId",
		"title",
		"body",
		"status",
		"role",
		"refs",
	]);
	const id = expectString(record.id, `${field}.id`, 1, MAX_ID_LENGTH);
	const type = expectEnum(record.type, `${field}.type`, NODE_TYPES);
	const position = record.position === undefined ? undefined : parsePosition(record.position, `${field}.position`);
	const size = record.size === undefined ? undefined : parseSize(record.size, `${field}.size`);
	const parentId = optionalString(record.parentId, `${field}.parentId`, 1, MAX_ID_LENGTH);
	const title = expectString(record.title, `${field}.title`, 1, MAX_TITLE_LENGTH);
	const body = optionalString(record.body, `${field}.body`, 0, MAX_TEXT_LENGTH);
	const status = record.status === undefined ? undefined : expectEnum(record.status, `${field}.status`, NODE_STATUSES);
	const role = record.role === undefined ? undefined : expectEnum(record.role, `${field}.role`, NODE_ROLES);
	const refs = record.refs === undefined ? undefined : parseRefs(record.refs, `${field}.refs`);
	return {
		id,
		type,
		...(position === undefined ? {} : { position }),
		...(size === undefined ? {} : { size }),
		...(parentId === undefined ? {} : { parentId }),
		title,
		...(body === undefined ? {} : { body }),
		...(status === undefined ? {} : { status }),
		...(role === undefined ? {} : { role }),
		...(refs === undefined ? {} : { refs }),
	};
}

function parseEdge(value: unknown, field: string): PreviewCanvasEdge {
	const record = expectRecord(value, field);
	expectOnlyKeys(record, field, ["id", "source", "target", "type", "label"]);
	const id = expectString(record.id, `${field}.id`, 1, MAX_ID_LENGTH);
	const source = expectString(record.source, `${field}.source`, 1, MAX_ID_LENGTH);
	const target = expectString(record.target, `${field}.target`, 1, MAX_ID_LENGTH);
	const type = record.type === undefined ? undefined : expectEnum(record.type, `${field}.type`, EDGE_TYPES);
	const label = optionalString(record.label, `${field}.label`, 0, MAX_EDGE_LABEL_LENGTH);
	return { id, source, target, ...(type === undefined ? {} : { type }), ...(label === undefined ? {} : { label }) };
}

function parsePosition(value: unknown, field: string): PreviewCanvasPosition {
	const record = expectRecord(value, field);
	expectOnlyKeys(record, field, ["x", "y"]);
	return {
		x: expectFiniteNumber(record.x, `${field}.x`, -MAX_COORDINATE, MAX_COORDINATE),
		y: expectFiniteNumber(record.y, `${field}.y`, -MAX_COORDINATE, MAX_COORDINATE),
	};
}

function parseSize(value: unknown, field: string): PreviewCanvasSize {
	const record = expectRecord(value, field);
	expectOnlyKeys(record, field, ["width", "height"]);
	return {
		width: expectFiniteNumber(record.width, `${field}.width`, 1, MAX_COORDINATE),
		height: expectFiniteNumber(record.height, `${field}.height`, 1, MAX_COORDINATE),
	};
}

function parseViewport(value: unknown): PreviewCanvasViewport {
	const field = "viewport";
	const record = expectRecord(value, field);
	expectOnlyKeys(record, field, ["x", "y", "zoom"]);
	return {
		x: expectFiniteNumber(record.x, `${field}.x`, -MAX_COORDINATE, MAX_COORDINATE),
		y: expectFiniteNumber(record.y, `${field}.y`, -MAX_COORDINATE, MAX_COORDINATE),
		zoom: expectFiniteNumber(record.zoom, `${field}.zoom`, MIN_VIEWPORT_ZOOM, MAX_VIEWPORT_ZOOM),
	};
}

function parseRefs(value: unknown, field: string): PreviewCanvasRef[] {
	const refs = expectArray(value, field, MAX_REFS_PER_NODE);
	return refs.map((ref, index) => {
		const refField = `${field}[${index}]`;
		const record = expectRecord(ref, refField);
		expectOnlyKeys(record, refField, ["label", "path", "anchor"]);
		const label = expectString(record.label, `${refField}.label`, 1, MAX_TITLE_LENGTH);
		const refPath = expectString(record.path, `${refField}.path`, 1, MAX_REF_PATH_LENGTH);
		if (!isSafeRelativePath(refPath)) {
			throw new CanvasValidationFailure(`${refField}.path`, "Canvas reference path must be a safe relative path");
		}
		const anchor = optionalString(record.anchor, `${refField}.anchor`, 1, MAX_REF_ANCHOR_LENGTH);
		return { label, path: refPath, ...(anchor === undefined ? {} : { anchor }) };
	});
}

function validateGraph(nodes: PreviewCanvasNode[], edges: PreviewCanvasEdge[]): void {
	const ids = new Set<string>();
	for (const [index, node] of nodes.entries()) {
		if (ids.has(node.id)) throw new CanvasValidationFailure(`nodes[${index}].id`, "Canvas ids must be unique");
		ids.add(node.id);
	}
	for (const [index, edge] of edges.entries()) {
		if (ids.has(edge.id)) throw new CanvasValidationFailure(`edges[${index}].id`, "Canvas ids must be unique");
		ids.add(edge.id);
	}
	const nodeIds = new Set(nodes.map(node => node.id));
	for (const [index, node] of nodes.entries()) {
		if (node.parentId !== undefined && !nodeIds.has(node.parentId)) {
			throw new CanvasValidationFailure(`nodes[${index}].parentId`, "Canvas parentId must identify a node");
		}
	}
	for (const [index, edge] of edges.entries()) {
		if (!nodeIds.has(edge.source)) {
			throw new CanvasValidationFailure(`edges[${index}].source`, "Canvas edge source must identify a node");
		}
		if (!nodeIds.has(edge.target)) {
			throw new CanvasValidationFailure(`edges[${index}].target`, "Canvas edge target must identify a node");
		}
	}
	const parents = new Map(nodes.map(node => [node.id, node.parentId]));
	for (const node of nodes) {
		const visited = new Set<string>();
		let current: string | undefined = node.id;
		while (current !== undefined) {
			if (visited.has(current)) {
				throw new CanvasValidationFailure("nodes", "Canvas parent graph must be acyclic");
			}
			visited.add(current);
			current = parents.get(current);
		}
	}
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new CanvasValidationFailure(field, "Expected an object");
	}
	return value as Record<string, unknown>;
}

function expectOnlyKeys(record: Record<string, unknown>, field: string, allowed: readonly string[]): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) throw new CanvasValidationFailure(`${field}.${key}`, "Unexpected canvas field");
	}
}

function expectArray(value: unknown, field: string, maxLength: number): unknown[] {
	if (!Array.isArray(value)) throw new CanvasValidationFailure(field, "Expected an array");
	if (value.length > maxLength)
		throw new CanvasValidationFailure(field, `Array may contain at most ${maxLength} entries`);
	return value;
}

function expectString(value: unknown, field: string, minLength: number, maxLength: number): string {
	if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
		throw new CanvasValidationFailure(field, `Expected a string between ${minLength} and ${maxLength} characters`);
	}
	return value;
}

function optionalString(value: unknown, field: string, minLength: number, maxLength: number): string | undefined {
	return value === undefined ? undefined : expectString(value, field, minLength, maxLength);
}

function expectEnum<T extends string>(value: unknown, field: string, values: readonly T[]): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new CanvasValidationFailure(field, "Expected a supported canvas value");
	}
	return value as T;
}

function expectFiniteNumber(value: unknown, field: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
		throw new CanvasValidationFailure(field, `Expected a finite number from ${min} to ${max}`);
	}
	return value;
}

function isSafeRelativePath(value: string): boolean {
	if (
		value.includes("\\") ||
		value.includes("\0") ||
		value.startsWith("/") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
	) {
		return false;
	}
	const segments = value.split("/");
	return segments.every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}
