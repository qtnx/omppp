import {
	ArrowLeft,
	Braces,
	ChevronDown,
	ChevronRight,
	FileJson,
	GitBranch,
	MessageSquare,
	Search,
	Users,
	X,
} from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import "../vendor/euphony/euphony.js";
import { getSessions, getSessionTrace } from "../api";
import type { SessionSummary, SessionTrace, TraceNode } from "../types";

interface TracesViewProps {
	onSelectRequest?: (id: number) => void;
}

type EuphonyRole = "assistant" | "developer" | "system" | "tool" | "user";

interface EuphonyTextContent {
	text: string;
}

interface EuphonyDeveloperContent {
	instructions: string;
}

interface EuphonySystemContent {
	model_identity: string;
}

type EuphonyContent = EuphonyTextContent[] | EuphonyDeveloperContent[] | EuphonySystemContent[];

interface EuphonyMessage {
	id?: string | null;
	role: EuphonyRole;
	name?: string | null;
	create_time?: number | null;
	metadata?: Record<string, unknown>;
	content: string | EuphonyContent;
	channel?: string | null;
	recipient?: string | null;
}

interface EuphonyConversationData {
	id?: string | null;
	messages: EuphonyMessage[];
	create_time?: number | null;
	metadata?: Record<string, unknown>;
}

/**
 * Minimal structural view of the vendored `<euphony-conversation>` element.
 * We declare only the properties we set so the DOM node can be cast with
 * `as unknown as EuphonyConversationElement`, sidestepping Euphony's nominal
 * `Role` string-enum (a literal like "assistant" is not assignable to it).
 */
interface EuphonyConversationElement extends HTMLElement {
	conversationData: EuphonyConversationData;
	shouldRenderMarkdown: boolean;
	theme: "auto" | "light" | "dark";
	conversationLabel: string;
	customLabels: string[][];
	disableMarkdownButton: boolean;
	disableTranslationButton: boolean;
	disableShareButton: boolean;
	disableMetadataButton: boolean;
	disablePreferenceButton: boolean;
	disableTokenWindow: boolean;
	disableEditingModeSaveButton: boolean;
}

const TRACE_PAGE_SIZE_OPTIONS = [50, 100, 200] as const;
const DEFAULT_TRACE_PAGE_SIZE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function formatTime(ms: number | undefined): string {
	if (!ms) return "-";
	return new Date(ms).toLocaleString();
}

function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return "-";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(value: number | undefined): string {
	if (!value) return "$0.00";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function compactPath(value: string): string {
	return value.replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");
}

function getEntryRecord(entry: unknown): Record<string, unknown> | null {
	return isRecord(entry) ? entry : null;
}

function getMessage(entry: unknown): Record<string, unknown> | null {
	const record = getEntryRecord(entry);
	const message = record?.message;
	return isRecord(message) ? message : null;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "null";
	} catch {
		return String(value);
	}
}

function markdownCodeBlock(language: string, text: string): string {
	const escaped = text.replaceAll("```", "``\u200b`");
	return `\`\`\`${language}\n${escaped}\n\`\`\``;
}

/** Render a message's content blocks as Markdown (text, thinking, tool calls, images). */
function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text") {
			const text = stringField(block, "text");
			if (text) parts.push(text);
		} else if (block.type === "thinking") {
			const thinking = stringField(block, "thinking");
			if (thinking) parts.push(`### Thinking\n\n${thinking}`);
		} else if (block.type === "toolCall") {
			const name = stringField(block, "name") ?? "tool";
			parts.push(`### Tool call: \`${name}\`\n\n${markdownCodeBlock("json", safeJson(block.arguments ?? {}))}`);
		} else if (block.type === "image") {
			parts.push(`_[image: ${stringField(block, "mimeType") ?? "image"}]_`);
		}
	}
	return parts.join("\n\n");
}

function contentForRole(role: EuphonyRole, text: string): EuphonyContent {
	const content = text.trimEnd();
	if (role === "system") return [{ model_identity: content }];
	if (role === "developer") return [{ instructions: content }];
	return [{ text: content }];
}

function formatToolResultText(message: Record<string, unknown>, fallback: string): string {
	const toolName = stringField(message, "toolName") ?? "tool";
	const text = extractMessageText(message.content) || fallback;
	if (!text) return `### Tool result: \`${toolName}\``;
	return `### Tool result: \`${toolName}\`\n\n${markdownCodeBlock("", text)}`;
}

function timestampSeconds(ms: number | undefined): number | null {
	return ms === undefined ? null : ms / 1000;
}

function roleFor(role: string | undefined): EuphonyRole {
	if (role === "assistant" || role === "system" || role === "developer" || role === "tool" || role === "user") {
		return role;
	}
	return role === "toolResult" ? "tool" : "system";
}

/** Convert a trace's OWN nodes (excluding subagents) into an Euphony conversation. */
function pushEuphonyNode(node: TraceNode, messages: EuphonyMessage[]): void {
	const metadata = { type: node.type, raw: node.entry };
	if (node.type === "session_init") {
		const entry = getEntryRecord(node.entry);
		const task = stringField(entry, "task");
		const systemPrompt = stringField(entry, "systemPrompt");
		if (task) {
			messages.push({
				id: `${node.id}:task`,
				role: "developer",
				content: contentForRole("developer", `### Session task\n\n${task}`),
				create_time: timestampSeconds(node.timestamp),
				metadata,
			});
		}
		if (systemPrompt) {
			messages.push({
				id: `${node.id}:system`,
				role: "system",
				content: contentForRole("system", systemPrompt),
				create_time: timestampSeconds(node.timestamp),
				metadata,
			});
		}
	}
	const message = getMessage(node.entry);
	if (message) {
		const role = stringField(message, "role");
		const euphonyRole = roleFor(role);
		const toolName = stringField(message, "toolName");
		const model = stringField(message, "model");
		const baseText = extractMessageText(message.content);
		const text = role === "toolResult" ? formatToolResultText(message, node.preview) : baseText || node.preview;
		messages.push({
			id: node.id,
			role: euphonyRole,
			...(toolName ? { recipient: toolName, channel: "tool" } : {}),
			...(model ? { name: model } : toolName ? { name: toolName } : {}),
			content: contentForRole(euphonyRole, text || safeJson(message)),
			create_time: timestampSeconds(node.timestamp),
			metadata,
		});
	}
	for (const child of node.children) {
		pushEuphonyNode(child, messages);
	}
}

function toEuphonyConversation(trace: SessionTrace): EuphonyConversationData {
	const messages: EuphonyMessage[] = [];
	for (const node of trace.nodes) {
		pushEuphonyNode(node, messages);
	}
	return {
		id: trace.summary.id,
		create_time: timestampSeconds(trace.summary.created),
		messages,
		metadata: {
			path: trace.summary.path,
			cwd: trace.summary.cwd,
			subagentCount: trace.summary.subagentCount,
		},
	};
}

interface PromptContext {
	id: string;
	label: string;
	text: string;
	timestamp?: number;
	tools: string[];
}

function traceDisplayName(trace: SessionTrace): string {
	if (trace.summary.depth === 0) return "Root session";
	return trace.summary.agentName || trace.summary.parentTaskId || trace.summary.title || "Subagent";
}

function collectPromptContextNode(node: TraceNode, prompts: PromptContext[], label: string): void {
	if (node.type === "session_init") {
		const entry = getEntryRecord(node.entry);
		const systemPrompt = stringField(entry, "systemPrompt");
		if (systemPrompt) {
			prompts.push({
				id: `${node.id}:system-prompt`,
				label: `${label} system prompt`,
				text: systemPrompt,
				timestamp: node.timestamp,
				tools: asStringArray(entry?.tools),
			});
		}
	}
	for (const child of node.children) {
		collectPromptContextNode(child, prompts, label);
	}
}

/** System prompts recorded in THIS trace only (subagents own their own panel). */
function collectPromptContexts(trace: SessionTrace): PromptContext[] {
	const prompts: PromptContext[] = [];
	const label = traceDisplayName(trace);
	for (const node of trace.nodes) {
		collectPromptContextNode(node, prompts, label);
	}
	return prompts;
}

/** Direct subagent traces spawned by THIS trace (attached to tool results + orphans). */
function collectDirectSubagents(trace: SessionTrace): SessionTrace[] {
	const subagents: SessionTrace[] = [];
	const walk = (nodes: TraceNode[]): void => {
		for (const node of nodes) {
			subagents.push(...node.subtraces);
			walk(node.children);
		}
	};
	walk(trace.nodes);
	subagents.push(...trace.orphanSubtraces);
	return subagents;
}

function countNestedSubagents(trace: SessionTrace): number {
	const direct = collectDirectSubagents(trace);
	let total = direct.length;
	for (const sub of direct) total += countNestedSubagents(sub);
	return total;
}

function isPrimaryTraceNode(node: TraceNode): boolean {
	return node.type === "message" || node.type === "session_init";
}

function collectEventNodes(nodes: TraceNode[]): TraceNode[] {
	const events: TraceNode[] = [];
	for (const node of nodes) {
		if (!isPrimaryTraceNode(node)) events.push(node);
		events.push(...collectEventNodes(node.children));
	}
	return events;
}

interface SubagentNav {
	open: (trace: SessionTrace) => void;
}

const SubagentNavContext = createContext<SubagentNav | null>(null);

function useSubagentNav(): SubagentNav {
	const ctx = useContext(SubagentNavContext);
	if (!ctx) throw new Error("SubagentNavContext is missing");
	return ctx;
}

export function TracesView({ onSelectRequest }: TracesViewProps) {
	void onSelectRequest;
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [query, setQuery] = useState("");
	const [loadingSessions, setLoadingSessions] = useState(true);
	const [trace, setTrace] = useState<SessionTrace | null>(null);
	const [traceLoading, setTraceLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [modalStack, setModalStack] = useState<SessionTrace[]>([]);

	const openSubagent = useCallback((sub: SessionTrace) => {
		setModalStack(stack => [...stack, sub]);
	}, []);
	const nav = useMemo<SubagentNav>(() => ({ open: openSubagent }), [openSubagent]);

	useEffect(() => {
		let cancelled = false;
		setLoadingSessions(true);
		getSessions(query, 150)
			.then(response => {
				if (cancelled) return;
				setSessions(response.sessions);
				setError(null);
			})
			.catch(err => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoadingSessions(false);
			});
		return () => {
			cancelled = true;
		};
	}, [query]);

	const loadTrace = useCallback(async (sessionPath: string) => {
		setTraceLoading(true);
		setModalStack([]);
		try {
			const nextTrace = await getSessionTrace(sessionPath);
			setTrace(nextTrace);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setTraceLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!trace && sessions[0]) void loadTrace(sessions[0].path);
	}, [trace, sessions, loadTrace]);

	return (
		<SubagentNavContext.Provider value={nav}>
			<div className="h-[calc(100vh-150px)] grid grid-cols-[300px_minmax(0,1fr)] gap-4 animate-fade-in">
				<SessionRail
					sessions={sessions}
					query={query}
					onQueryChange={setQuery}
					loading={loadingSessions}
					selectedPath={trace?.summary.path ?? null}
					onSelect={loadTrace}
				/>
				<section className="surface overflow-hidden flex flex-col min-w-0">
					<TraceHeader trace={trace} loading={traceLoading} error={error} />
					<div className="overflow-auto flex-1 p-5">
						{trace ? (
							<TraceConversation trace={trace} />
						) : (
							<EmptyState
								label={traceLoading ? "Loading trace..." : "Select a session to inspect its conversation."}
							/>
						)}
					</div>
				</section>
			</div>
			{modalStack.length > 0 && (
				<SubagentModal
					stack={modalStack}
					rootLabel={trace ? traceDisplayName(trace) : "Session"}
					onClose={() => setModalStack([])}
					onNavigate={index => setModalStack(stack => stack.slice(0, index + 1))}
				/>
			)}
		</SubagentNavContext.Provider>
	);
}

function SessionRail({
	sessions,
	query,
	onQueryChange,
	loading,
	selectedPath,
	onSelect,
}: {
	sessions: SessionSummary[];
	query: string;
	onQueryChange: (query: string) => void;
	loading: boolean;
	selectedPath: string | null;
	onSelect: (path: string) => void;
}) {
	return (
		<aside className="surface overflow-hidden flex flex-col min-w-0">
			<div className="p-4 border-b border-[var(--border-subtle)] space-y-3">
				<div>
					<div className="text-sm font-semibold text-[var(--text-primary)]">Conversations</div>
					<div className="text-xs text-[var(--text-muted)]">Sessions, prompts, and subagent runs</div>
				</div>
				<label className="flex items-center gap-2 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] px-3 py-2">
					<Search size={14} className="text-[var(--text-muted)]" />
					<input
						value={query}
						onChange={event => onQueryChange(event.target.value)}
						placeholder="Search sessions, prompts, models..."
						className="bg-transparent outline-none text-sm min-w-0 flex-1 text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
					/>
				</label>
			</div>
			<div className="overflow-auto flex-1">
				{loading && <EmptyState label="Loading sessions..." />}
				{!loading && sessions.length === 0 && <EmptyState label="No sessions found." />}
				{sessions.map(session => (
					<button
						key={session.path}
						type="button"
						onClick={() => onSelect(session.path)}
						className={`w-full text-left p-4 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] transition-colors ${
							selectedPath === session.path ? "bg-[var(--bg-active)]" : ""
						}`}
					>
						<div className="flex items-start justify-between gap-2">
							<div className="font-medium text-sm text-[var(--text-primary)] line-clamp-2">
								{session.title || session.firstUserMessage || session.task || "Untitled session"}
							</div>
							{session.subagentCount > 0 && (
								<span className="badge badge-info shrink-0">{session.subagentCount} agents</span>
							)}
						</div>
						<div className="text-xs text-[var(--text-muted)] mt-2 line-clamp-1">{compactPath(session.cwd)}</div>
						<div className="flex items-center gap-3 text-xs text-[var(--text-muted)] mt-3">
							<span>{formatTime(session.modified)}</span>
							<span>{session.stats?.totalRequests ?? session.assistantMessageCount} req</span>
							<span>{formatCost(session.stats?.totalCost)}</span>
						</div>
					</button>
				))}
			</div>
		</aside>
	);
}

function TraceHeader({
	trace,
	loading,
	error,
}: {
	trace: SessionTrace | null;
	loading: boolean;
	error: string | null;
}) {
	return (
		<div className="p-5 border-b border-[var(--border-subtle)] flex items-start justify-between gap-4">
			<div className="min-w-0 space-y-1">
				<div className="flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
					<FileJson size={17} className="text-[var(--accent-cyan)]" />
					<span className="truncate">
						{trace?.summary.title ||
							trace?.summary.firstUserMessage ||
							trace?.summary.task ||
							"Conversation trace"}
					</span>
				</div>
				<div className="text-xs text-[var(--text-muted)] truncate">
					{trace ? compactPath(trace.summary.path) : "Pick a session from the left rail"}
				</div>
				{error && <div className="text-xs text-[var(--accent-red)] mt-2">{error}</div>}
			</div>
			<div className="flex items-center gap-2 text-xs text-[var(--text-muted)] shrink-0">
				{loading && <span className="badge badge-info">Loading</span>}
				{trace && (
					<>
						<span className="badge badge-info">{trace.flatEntryCount} entries</span>
						{trace.summary.subagentCount > 0 && (
							<span className="badge badge-warning">{trace.summary.subagentCount} subagents</span>
						)}
					</>
				)}
			</div>
		</div>
	);
}

function TraceConversation({ trace }: { trace: SessionTrace }) {
	return (
		<div className="max-w-[1120px] mx-auto space-y-5">
			<TraceSummary trace={trace} />
			<SessionEvents nodes={trace.nodes} />
			<PromptContextPanel trace={trace} />
			<SubagentsPanel trace={trace} />
			<div className="pt-1">
				<h2 className="text-sm font-semibold text-[var(--text-primary)]">Conversation</h2>
				<p className="text-xs text-[var(--text-muted)] mt-1">
					This agent's own messages, Markdown-rendered. Subagents open in their own view above.
				</p>
			</div>
			<EuphonyConversationPanel trace={trace} />
		</div>
	);
}

function SubagentsPanel({ trace }: { trace: SessionTrace }) {
	const subagents = useMemo(() => collectDirectSubagents(trace), [trace]);
	const [expanded, setExpanded] = useState(true);
	if (subagents.length === 0) return null;
	return (
		<div className="surface-elevated overflow-hidden">
			<button
				type="button"
				className="w-full p-4 flex items-start justify-between gap-4 text-left hover:bg-[var(--bg-hover)] transition-colors"
				onClick={() => setExpanded(value => !value)}
			>
				<div className="min-w-0">
					<div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
						{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
						<Users size={14} className="text-[var(--accent-violet)]" />
						<span>Subagents</span>
						<span className="badge badge-info">{subagents.length}</span>
					</div>
					<p className="text-xs text-[var(--text-muted)] mt-1">
						Each subagent runs its own conversation. Click a card to open it in a modal.
					</p>
				</div>
			</button>
			{expanded && (
				<div className="px-4 pb-4 grid gap-3 sm:grid-cols-2">
					{subagents.map(sub => (
						<SubagentCard key={sub.summary.path} trace={sub} />
					))}
				</div>
			)}
		</div>
	);
}

function SubagentCard({ trace }: { trace: SessionTrace }) {
	const nav = useSubagentNav();
	const nested = useMemo(() => countNestedSubagents(trace), [trace]);
	const stats = trace.summary.stats;
	const label = traceDisplayName(trace);
	const task = trace.summary.task || trace.summary.firstUserMessage || compactPath(trace.summary.path);
	return (
		<button
			type="button"
			onClick={() => nav.open(trace)}
			className="text-left bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] p-3 hover:border-[var(--accent-violet)] hover:bg-[var(--bg-hover)] transition-colors"
		>
			<div className="flex items-center gap-2">
				<GitBranch size={14} className="text-[var(--accent-violet)] shrink-0" />
				<span className="text-sm font-semibold text-[var(--text-primary)] truncate">{label}</span>
			</div>
			<div className="text-sm text-[var(--text-secondary)] mt-2 line-clamp-2">{task}</div>
			<div className="flex flex-wrap items-center gap-2 mt-3 text-xs text-[var(--text-muted)]">
				<span className="badge badge-info">{trace.flatEntryCount} entries</span>
				<span>{stats?.totalRequests ?? trace.summary.assistantMessageCount} req</span>
				<span>{formatCost(stats?.totalCost)}</span>
				{nested > 0 && <span className="badge badge-warning">{nested} nested</span>}
			</div>
		</button>
	);
}

function SubagentModal({
	stack,
	rootLabel,
	onClose,
	onNavigate,
}: {
	stack: SessionTrace[];
	rootLabel: string;
	onClose: () => void;
	onNavigate: (index: number) => void;
}) {
	const active = stack[stack.length - 1];

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	if (!active) return null;
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button
				type="button"
				aria-label="Close subagent view"
				className="absolute inset-0 bg-black/60 backdrop-blur-sm"
				onClick={onClose}
			/>
			<div className="surface relative w-full max-w-[1180px] h-[calc(100vh-80px)] flex flex-col overflow-hidden animate-fade-in">
				<div className="p-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-4">
					<div className="min-w-0 flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)]">
						{stack.length > 1 && (
							<button
								type="button"
								className="btn btn-secondary text-xs py-1 px-2"
								onClick={() => onNavigate(stack.length - 2)}
							>
								<ArrowLeft size={13} /> Back
							</button>
						)}
						<span className="text-[var(--text-secondary)]">{rootLabel}</span>
						{stack.map((item, index) => (
							<span key={item.summary.path} className="flex items-center gap-2">
								<ChevronRight size={12} />
								<button
									type="button"
									className={`hover:text-[var(--text-primary)] transition-colors ${
										index === stack.length - 1 ? "text-[var(--text-primary)] font-semibold" : ""
									}`}
									onClick={() => onNavigate(index)}
								>
									{traceDisplayName(item)}
								</button>
							</span>
						))}
					</div>
					<button type="button" className="btn btn-secondary text-xs py-1 px-2 shrink-0" onClick={onClose}>
						<X size={14} /> Close
					</button>
				</div>
				<div className="overflow-auto flex-1 p-5">
					<TraceConversation key={active.summary.path} trace={active} />
				</div>
			</div>
		</div>
	);
}

function TraceSummary({ trace }: { trace: SessionTrace }) {
	const stats = trace.summary.stats;
	return (
		<div className="surface-elevated p-4 grid grid-cols-2 xl:grid-cols-5 gap-4">
			<Metric label="Requests" value={String(stats?.totalRequests ?? trace.summary.assistantMessageCount)} />
			<Metric label="Messages" value={String(trace.summary.messageCount)} />
			<Metric label="Tokens" value={(stats?.totalTokens ?? 0).toLocaleString()} />
			<Metric label="Cost" value={formatCost(stats?.totalCost)} />
			<Metric label="Avg latency" value={formatDuration(stats?.avgDuration)} />
		</div>
	);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">{label}</div>
			<div className="text-lg font-semibold text-[var(--text-primary)] mt-1">{value}</div>
		</div>
	);
}

function SessionEvents({ nodes }: { nodes: TraceNode[] }) {
	const events = useMemo(() => collectEventNodes(nodes), [nodes]);
	if (events.length === 0) return null;
	return (
		<DisclosurePanel title={`Session events (${events.length})`} icon={<MessageSquare size={12} />}>
			<div className="space-y-2">
				{events.map(event => (
					<CompactEventRow key={event.id} node={event} />
				))}
			</div>
		</DisclosurePanel>
	);
}

function CompactEventRow({ node }: { node: TraceNode }) {
	const entry = getEntryRecord(node.entry);
	const label = node.type.replaceAll("_", " ");
	const detail = stringField(entry, "model") ?? stringField(entry, "thinkingLevel") ?? node.preview ?? "";
	return (
		<div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] p-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0 flex items-center gap-2">
					<span className="badge badge-info">Event</span>
					<span className="text-sm font-medium text-[var(--text-primary)] capitalize">{label}</span>
					{detail && <span className="text-sm text-[var(--text-secondary)] truncate">{detail}</span>}
				</div>
				<span className="text-xs text-[var(--text-muted)] shrink-0">{formatTime(node.timestamp)}</span>
			</div>
			<RawJson title="Raw event" value={node.entry} />
		</div>
	);
}

function PromptContextPanel({ trace }: { trace: SessionTrace }) {
	const prompts = useMemo(() => collectPromptContexts(trace), [trace]);
	const isRoot = trace.summary.depth === 0;
	const tools = useMemo(() => [...new Set(prompts.flatMap(prompt => prompt.tools))], [prompts]);
	const conversation = useMemo<EuphonyConversationData>(
		() => ({
			id: `${trace.summary.id}:system-prompts`,
			create_time: timestampSeconds(trace.summary.created),
			messages: prompts.map(prompt => ({
				id: prompt.id,
				role: "assistant" as EuphonyRole,
				name: "system prompt",
				content: contentForRole("assistant", `## ${prompt.label}\n\n${prompt.text}`),
				create_time: timestampSeconds(prompt.timestamp),
				metadata: { tools: prompt.tools, systemPrompt: true },
			})),
			metadata: { panel: "system-prompts" },
		}),
		[prompts, trace.summary.id, trace.summary.created],
	);
	if (prompts.length === 0 && !isRoot) return null;
	const title =
		prompts.length > 0 ? `System prompts (${prompts.length})` : "System prompts (not logged for this session)";
	return (
		<DisclosurePanel title={title} icon={<FileJson size={12} />}>
			{prompts.length === 0 ? (
				<p className="text-sm text-[var(--text-secondary)]">
					This session predates system-prompt logging, so its root instructions were not recorded. New sessions
					capture the system prompt in their <code>session_init</code> entry.
				</p>
			) : (
				<>
					{tools.length > 0 && (
						<div className="mb-3 flex flex-wrap gap-2">
							{tools.slice(0, 60).map(tool => (
								<span key={tool} className="badge badge-info">
									{tool}
								</span>
							))}
						</div>
					)}
					<EuphonyHost conversation={conversation} />
				</>
			)}
		</DisclosurePanel>
	);
}

function EuphonyConversationPanel({ trace }: { trace: SessionTrace }) {
	const full = useMemo(() => toEuphonyConversation(trace), [trace]);
	const [pageSize, setPageSize] = useState<number>(DEFAULT_TRACE_PAGE_SIZE);
	const [page, setPage] = useState(0);
	useEffect(() => {
		setPage(0);
	}, [trace.summary.path]);
	const total = full.messages.length;
	const pageCount = Math.max(1, Math.ceil(total / pageSize));
	const safePage = Math.min(page, pageCount - 1);
	const start = safePage * pageSize;
	const end = Math.min(start + pageSize, total);
	const pageConversation = useMemo<EuphonyConversationData>(
		() => ({ ...full, messages: full.messages.slice(start, end) }),
		[full, start, end],
	);
	if (total === 0) {
		return <EmptyState label="No conversation messages recorded for this trace." />;
	}
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<span className="text-xs text-[var(--text-muted)]">
					Showing {start + 1}-{end} of {total} messages
				</span>
				<div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
					<label className="flex items-center gap-2">
						Page size
						<select
							value={pageSize}
							onChange={event => {
								setPageSize(Number(event.target.value));
								setPage(0);
							}}
							className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-primary)]"
						>
							{TRACE_PAGE_SIZE_OPTIONS.map(size => (
								<option key={size} value={size}>
									{size}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						className="btn btn-secondary text-xs py-1 px-2"
						disabled={safePage <= 0}
						onClick={() => setPage(value => Math.max(0, value - 1))}
					>
						Prev
					</button>
					<span>
						{safePage + 1}/{pageCount}
					</span>
					<button
						type="button"
						className="btn btn-secondary text-xs py-1 px-2"
						disabled={safePage >= pageCount - 1}
						onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}
					>
						Next
					</button>
				</div>
			</div>
			<div className="surface-elevated p-3 overflow-hidden">
				<EuphonyHost conversation={pageConversation} />
			</div>
		</div>
	);
}

function EuphonyHost({ conversation }: { conversation: EuphonyConversationData }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const elementRef = useRef<EuphonyConversationElement | null>(null);
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let element = elementRef.current;
		if (!element) {
			element = document.createElement("euphony-conversation") as unknown as EuphonyConversationElement;
			element.shouldRenderMarkdown = true;
			element.theme = "auto";
			element.conversationLabel = "Trace";
			element.disableMarkdownButton = false;
			element.disableTranslationButton = true;
			element.disableShareButton = true;
			element.disableMetadataButton = false;
			element.disablePreferenceButton = true;
			element.disableTokenWindow = true;
			element.disableEditingModeSaveButton = true;
			element.style.display = "block";
			element.style.width = "100%";
			container.appendChild(element);
			elementRef.current = element;
		}
		element.conversationData = conversation;
	}, [conversation]);
	useEffect(() => {
		return () => {
			const element = elementRef.current;
			element?.parentElement?.removeChild(element);
			elementRef.current = null;
		};
	}, []);
	return <div ref={containerRef} className="euphony-host w-full" />;
}

function DisclosurePanel({
	title,
	icon,
	defaultOpen = false,
	children,
}: {
	title: string;
	icon?: ReactNode;
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="surface-elevated overflow-hidden">
			<button
				type="button"
				onClick={() => setOpen(value => !value)}
				className="w-full px-4 py-3 flex items-center gap-2 text-left hover:bg-[var(--bg-hover)] transition-colors"
			>
				{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				{icon}
				<span className="text-sm font-medium text-[var(--text-primary)] truncate">{title}</span>
			</button>
			{open && <div className="px-4 pb-4">{children}</div>}
		</div>
	);
}

function RawJson({ title, value }: { title: string; value: unknown }) {
	const [open, setOpen] = useState(false);
	const text = useMemo(() => safeJson(value), [value]);
	return (
		<div className="mt-2">
			<button
				type="button"
				onClick={() => setOpen(prev => !prev)}
				className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
			>
				<Braces size={12} /> {open ? "Hide raw" : title}
			</button>
			{open && (
				<pre className="mt-2 max-h-[320px] overflow-auto text-xs bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-sm)] p-3 text-[var(--text-secondary)] whitespace-pre-wrap break-words">
					{text}
				</pre>
			)}
		</div>
	);
}

function EmptyState({ label }: { label: string }) {
	return <div className="p-8 text-center text-sm text-[var(--text-muted)]">{label}</div>;
}
