import { formatDistanceToNow } from "date-fns";
import { Activity, AlertTriangle, BookMarked, CheckCircle2, Search, ShieldAlert, Terminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	generateReviewFindingLesson,
	getReviewFindingDetail,
	getReviewFindingGenerationEvents,
	getReviewFindings,
} from "../api";
import type {
	ReviewFindingDetail,
	ReviewFindingLessonGenerationEvent,
	ReviewFindingRepoSummary,
	ReviewFindingStatus,
	ReviewFindingSummary,
} from "../types";

const statusOptions: Array<{ label: string; value: ReviewFindingStatus }> = [
	{ label: "All", value: "all" },
	{ label: "Pending", value: "pending" },
	{ label: "Saved", value: "saved" },
];

function generationIsActive(detail: ReviewFindingDetail): boolean {
	return detail.generation.status === "queued" || detail.generation.status === "running";
}

export function mergeGenerationEvents(
	current: ReviewFindingLessonGenerationEvent[],
	incoming: ReviewFindingLessonGenerationEvent[],
): ReviewFindingLessonGenerationEvent[] {
	if (incoming.length === 0) return current;
	const bySequence = new Map<number, ReviewFindingLessonGenerationEvent>();
	for (const event of current) bySequence.set(event.sequence, event);
	for (const event of incoming) bySequence.set(event.sequence, event);
	return Array.from(bySequence.values()).sort((left, right) => left.sequence - right.sequence);
}

export function ReviewFindingsView() {
	const [findings, setFindings] = useState<ReviewFindingSummary[]>([]);
	const [repos, setRepos] = useState<ReviewFindingRepoSummary[]>([]);
	const [total, setTotal] = useState(0);
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<ReviewFindingStatus>("pending");
	const [repoRoot, setRepoRoot] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selectedIdRef = useRef<string | null>(null);
	const [detail, setDetail] = useState<ReviewFindingDetail | null>(null);
	const [loadingList, setLoadingList] = useState(true);
	const [loadingDetail, setLoadingDetail] = useState(false);
	const [generating, setGenerating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		selectedIdRef.current = selectedId;
	}, [selectedId]);
	const loadFindings = useCallback(
		async (preferredSelection?: string | null, isCancelled?: () => boolean): Promise<boolean> => {
			setLoadingList(true);
			try {
				const response = await getReviewFindings(query, status, repoRoot, 100);
				if (isCancelled?.()) return false;
				setFindings(response.findings);
				setRepos(response.repos);
				setTotal(response.total);
				setSelectedId(current => {
					const candidate = preferredSelection === undefined ? current : preferredSelection;
					if (
						candidate &&
						(preferredSelection !== undefined || response.findings.some(finding => finding.id === candidate))
					) {
						return candidate;
					}
					return response.findings[0]?.id ?? null;
				});
				setError(null);
				return true;
			} catch (err) {
				if (!isCancelled?.()) setError(err instanceof Error ? err.message : String(err));
				return false;
			} finally {
				if (!isCancelled?.()) setLoadingList(false);
			}
		},
		[query, repoRoot, status],
	);

	useEffect(() => {
		let cancelled = false;
		const load = () => {
			void loadFindings(undefined, () => cancelled);
		};
		load();
		const interval = setInterval(load, 30000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [loadFindings]);

	useEffect(() => {
		if (!selectedId) {
			setDetail(null);
			return;
		}
		let cancelled = false;
		const load = async () => {
			setLoadingDetail(true);
			setDetail(null);
			try {
				const response = await getReviewFindingDetail(selectedId);
				if (cancelled) return;
				setDetail(response);
				setError(null);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (!cancelled) setLoadingDetail(false);
			}
		};
		load();
		return () => {
			cancelled = true;
		};
	}, [selectedId]);

	useEffect(() => {
		if (!selectedId || !detail || !generationIsActive(detail)) return;
		let cancelled = false;
		let cursor = detail.generation.events.at(-1)?.sequence ?? 0;
		let intervalId: number | undefined;
		const loadEvents = async () => {
			try {
				const response = await getReviewFindingGenerationEvents(selectedId, cursor);
				if (cancelled) return;
				setError(null);
				for (const event of response.events) cursor = Math.max(cursor, event.sequence);
				setDetail(current => {
					if (!current || current.finding.id !== selectedId) return current;
					return {
						...current,
						generation: {
							...response.generation,
							events: mergeGenerationEvents(current.generation.events, response.events),
						},
					};
				});
				if (response.generation.status === "succeeded" || response.generation.status === "failed") {
					cancelled = true;
					if (intervalId !== undefined) window.clearInterval(intervalId);
					const finalDetail = await getReviewFindingDetail(selectedId);
					if (selectedIdRef.current === selectedId) setDetail(finalDetail);
					await loadFindings(finalDetail.finding.id);
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		};
		void loadEvents();
		intervalId = window.setInterval(() => {
			void loadEvents();
		}, 750);
		return () => {
			cancelled = true;
			if (intervalId !== undefined) window.clearInterval(intervalId);
		};
	}, [detail?.finding.id, detail?.generation.jobId, detail?.generation.status, loadFindings, selectedId]);

	const selectedDetail = detail?.finding.id === selectedId ? detail : null;
	const selectedFinding = useMemo(() => {
		if (!selectedId) return null;
		if (selectedDetail) return selectedDetail.finding;
		return findings.find(finding => finding.id === selectedId) ?? null;
	}, [findings, selectedDetail, selectedId]);

	const generateSelected = async () => {
		if (!selectedId) return;
		const requestId = selectedId;
		setGenerating(true);
		try {
			const generated = await generateReviewFindingLesson(requestId);
			if (selectedIdRef.current !== requestId) {
				await loadFindings();
				return;
			}
			setDetail({
				finding: generated.finding,
				lessonPreview: generated.lessonPreview,
				generation: generated.generation,
			});
			await loadFindings(generated.finding.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setGenerating(false);
		}
	};

	return (
		<div className="animate-fade-in space-y-5">
			<section className="surface p-5 overflow-hidden relative">
				<div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[var(--accent-red)] via-[var(--accent-violet)] to-[var(--accent-cyan)]" />
				<div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
					<div className="flex items-start gap-4">
						<div className="w-12 h-12 rounded-2xl bg-[rgba(248,113,113,0.12)] border border-[rgba(248,113,113,0.25)] flex items-center justify-center">
							<ShieldAlert className="w-6 h-6 text-[var(--accent-red)]" />
						</div>
						<div>
							<div className="flex items-center gap-3">
								<h2 className="text-2xl font-semibold text-[var(--text-primary)]">Review Findings</h2>
								<span className="badge badge-info">{total.toLocaleString()} findings</span>
							</div>
							<p className="text-sm text-[var(--text-muted)] max-w-3xl mt-1">
								Findings reported by reviewer and code-reviewer tasks. Review each item, then trigger an agent
								to distill durable repo lessons.
							</p>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-3">
						<label className="relative min-w-[260px]">
							<Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
							<input
								value={query}
								onChange={event => setQuery(event.target.value)}
								placeholder="Filter by repo, file, agent, title..."
								className="w-full pl-10 pr-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-default)] text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)]"
							/>
						</label>
						<select
							value={repoRoot}
							onChange={event => setRepoRoot(event.target.value)}
							className="px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-default)] text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)]"
						>
							<option value="">All repos</option>
							{repos.map(repo => (
								<option key={repo.repoRoot} value={repo.repoRoot}>
									{repo.repoName} ({repo.pendingCount} pending, {repo.savedCount} saved)
								</option>
							))}
						</select>
						<div className="flex bg-[var(--bg-surface)] rounded-[var(--radius-md)] p-1 border border-[var(--border-subtle)]">
							{statusOptions.map(option => (
								<button
									key={option.value}
									type="button"
									onClick={() => setStatus(option.value)}
									className={`tab-btn text-xs ${status === option.value ? "active" : ""}`}
								>
									{option.label}
								</button>
							))}
						</div>
					</div>
				</div>
			</section>

			{error && (
				<div className="surface p-4 border-[rgba(248,113,113,0.3)] text-[var(--accent-red)] flex items-center gap-2">
					<AlertTriangle className="w-4 h-4" />
					<span className="text-sm">{error}</span>
				</div>
			)}

			<div className="grid xl:grid-cols-[460px_1fr] gap-5 h-[calc(100vh-230px)] min-h-[620px]">
				<section className="surface overflow-hidden flex flex-col">
					<div className="px-4 py-3 border-b border-[var(--border-subtle)] flex items-center justify-between">
						<div>
							<h3 className="font-semibold text-[var(--text-primary)]">Reviewer findings</h3>
							<p className="text-xs text-[var(--text-muted)]">Newest first, deduped by repo and location</p>
						</div>
						{loadingList && (
							<div className="w-4 h-4 border-2 border-[var(--border-default)] border-t-[var(--accent-cyan)] rounded-full spin" />
						)}
					</div>
					<div className="overflow-auto divide-y divide-[var(--border-subtle)]">
						{findings.length === 0 && !loadingList ? (
							<EmptyState />
						) : (
							findings.map(finding => (
								<button
									key={finding.id}
									type="button"
									onClick={() => setSelectedId(finding.id)}
									className={`w-full text-left px-4 py-3 transition-colors ${selectedId === finding.id ? "bg-[var(--bg-active)]" : "hover:bg-[var(--bg-hover)]"}`}
								>
									<div className="flex items-center justify-between gap-3">
										<PriorityBadge finding={finding} />
										<span className="text-xs text-[var(--text-muted)] whitespace-nowrap">
											{formatDistanceToNow(finding.lastSeenAt * 1000, { addSuffix: true })}
										</span>
									</div>
									<p className="mt-2 text-sm text-[var(--text-primary)] line-clamp-2">{finding.title}</p>
									<p className="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">{finding.bodyPreview}</p>
									<div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
										<span>{finding.repoName}</span>
										<span>
											{finding.filePath}:{finding.lineStart}
										</span>
										<span>{finding.agent}</span>
										<span>{finding.occurrenceCount}x</span>
									</div>
								</button>
							))
						)}
					</div>
				</section>

				<section className="surface overflow-hidden flex flex-col">
					{selectedFinding ? (
						<ReviewFindingDetailPanel
							detail={selectedDetail}
							finding={selectedFinding}
							loading={loadingDetail}
							generating={generating}
							onGenerate={generateSelected}
						/>
					) : (
						<div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
							Select a review finding.
						</div>
					)}
				</section>
			</div>
		</div>
	);
}

function ReviewFindingDetailPanel({
	detail,
	finding,
	loading,
	generating,
	onGenerate,
}: {
	detail: ReviewFindingDetail | null;
	finding: ReviewFindingSummary;
	loading: boolean;
	generating: boolean;
	onGenerate: () => void;
}) {
	const record = detail?.finding;
	const saved = Boolean(finding.learningSavedAt);
	const generationPending = detail?.generation.status === "queued" || detail?.generation.status === "running";
	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<div className="p-4 border-b border-[var(--border-subtle)] space-y-4">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<PriorityBadge finding={finding} />
							<span className="text-xs font-mono text-[var(--text-muted)]">{finding.id}</span>
						</div>
						<h3 className="text-lg font-semibold text-[var(--text-primary)]">{finding.title}</h3>
					</div>
					<div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
						{loading && (
							<div className="w-3.5 h-3.5 border-2 border-[var(--border-default)] border-t-[var(--accent-cyan)] rounded-full spin" />
						)}
						<span>{new Date(finding.lastSeenAt * 1000).toLocaleString()}</span>
					</div>
				</div>
				<div className="grid md:grid-cols-4 gap-3">
					<MiniMetric label="Repo" value={finding.repoName} detail={finding.repoRoot} />
					<MiniMetric
						label="Location"
						value={`${finding.filePath}:${finding.lineStart}`}
						detail={`lines ${finding.lineStart}-${finding.lineEnd}`}
					/>
					<MiniMetric label="Agent" value={finding.agent} detail={record?.resolvedModel || "unknown model"} />
					<MiniMetric
						label="Learning"
						value={saved ? "saved" : generationPending ? "generating" : "pending"}
						detail={
							saved && finding.learningSavedAt
								? new Date(finding.learningSavedAt * 1000).toLocaleString()
								: detail?.generation.status === "failed"
									? detail.generation.error || "generation failed"
									: "agent generation required"
						}
					/>
				</div>
			</div>

			{detail ? (
				<div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
					<section className="space-y-2">
						<h4 className="text-sm font-semibold text-[var(--text-primary)]">Finding body</h4>
						<p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
							{detail.finding.body}
						</p>
					</section>
					<section className="space-y-2">
						<div className="flex items-center justify-between gap-3">
							<h4 className="text-sm font-semibold text-[var(--text-primary)]">Generated repo lesson</h4>
							<button
								type="button"
								className="btn btn-primary"
								onClick={onGenerate}
								disabled={saved || generating || generationPending}
							>
								{saved ? <CheckCircle2 size={16} /> : <BookMarked size={16} />}
								{saved
									? "Saved"
									: generating || generationPending
										? "Generating..."
										: detail.generation.status === "failed"
											? "Retry generation"
											: "Generate lesson"}
							</button>
						</div>
						{detail.lessonPreview ? (
							<pre className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-sm text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
								{detail.lessonPreview}
							</pre>
						) : (
							<div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-sm text-[var(--text-muted)]">
								No generated lesson yet. Click Generate lesson to ask an agent to extract reusable facts,
								lesson, rationale, and source context.
							</div>
						)}
					</section>
					<GenerationDebugStream detail={detail} />
					<section className="grid md:grid-cols-2 gap-3 text-xs text-[var(--text-muted)]">
						<MiniMetric
							label="Task"
							value={detail.finding.taskId}
							detail={detail.finding.taskDescription || "no description"}
						/>
						<MiniMetric
							label="Output"
							value={detail.finding.outputPath || "not persisted"}
							detail={detail.finding.sessionFile || "no session file"}
						/>
					</section>
				</div>
			) : (
				<div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
					Loading finding detail...
				</div>
			)}
		</div>
	);
}

function GenerationDebugStream({ detail }: { detail: ReviewFindingDetail }) {
	const events = detail.generation.events;
	const active = generationIsActive(detail);
	return (
		<section className="space-y-2">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<Terminal className="w-4 h-4 text-[var(--accent-cyan)]" />
					<h4 className="text-sm font-semibold text-[var(--text-primary)]">Agent debug stream</h4>
				</div>
				<div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
					{active && (
						<div className="w-3 h-3 border-2 border-[var(--border-default)] border-t-[var(--accent-cyan)] rounded-full spin" />
					)}
					<span className="badge badge-info">{detail.generation.status}</span>
					{detail.generation.jobId && <span className="font-mono">#{detail.generation.jobId.slice(0, 18)}</span>}
				</div>
			</div>
			<div className="rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] overflow-hidden">
				{events.length === 0 ? (
					<div className="p-4 text-sm text-[var(--text-muted)]">
						No agent events yet. Start generation to stream tool use, intent, model output tail, and token/cost
						counters for prompt tuning.
					</div>
				) : (
					<div className="max-h-[360px] overflow-auto divide-y divide-[var(--border-subtle)]">
						{events.map(event => (
							<GenerationEventRow key={event.sequence} event={event} />
						))}
					</div>
				)}
			</div>
		</section>
	);
}

function GenerationEventRow({ event }: { event: ReviewFindingLessonGenerationEvent }) {
	const progress = event.progress;
	return (
		<div className="p-3 space-y-2">
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs">
				<div className="flex items-center gap-2 min-w-0">
					<Activity className="w-3.5 h-3.5 text-[var(--accent-violet)] shrink-0" />
					<span className="font-mono text-[var(--text-muted)]">#{event.sequence}</span>
					<span className={`badge ${event.kind === "error" ? "badge-error" : "badge-info"}`}>{event.kind}</span>
				</div>
				<span className="text-[var(--text-muted)]">{new Date(event.createdAt * 1000).toLocaleTimeString()}</span>
			</div>
			<p className="text-sm text-[var(--text-primary)] break-words">{event.message}</p>
			{progress && (
				<div className="space-y-2">
					<div className="grid md:grid-cols-4 gap-2 text-xs text-[var(--text-muted)]">
						<MiniMetric
							label="Tool"
							value={progress.currentTool || "none"}
							detail={progress.currentToolArgs || "idle"}
						/>
						<MiniMetric
							label="Model"
							value={progress.resolvedModel || "resolving"}
							detail={progress.lastIntent || progress.status}
						/>
						<MiniMetric
							label="Tokens"
							value={progress.tokens.toLocaleString()}
							detail={`${progress.toolCount} tool calls`}
						/>
						<MiniMetric
							label="Cost"
							value={`$${progress.cost.toFixed(4)}`}
							detail={`${Math.round(progress.durationMs)}ms`}
						/>
					</div>
					{progress.recentOutput.length > 0 && (
						<pre className="p-3 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
							{progress.recentOutput.join("\n")}
						</pre>
					)}
					{progress.recentTools.length > 0 && (
						<div className="flex flex-wrap gap-2 text-xs text-[var(--text-muted)]">
							{progress.recentTools.map(tool => (
								<span key={`${tool.tool}-${tool.endMs}`} className="badge badge-info">
									{tool.tool}: {tool.args || "no args"}
								</span>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function PriorityBadge({ finding }: { finding: ReviewFindingSummary }) {
	const saved = Boolean(finding.learningSavedAt);
	const color = finding.priority <= 1 ? "badge-error" : finding.priority === 2 ? "badge-warning" : "badge-info";
	return (
		<div className="flex items-center gap-2">
			<span className={`badge ${color}`}>{finding.priorityLabel}</span>
			<span className={`badge ${saved ? "badge-success" : "badge-warning"}`}>{saved ? "saved" : "pending"}</span>
		</div>
	);
}

function MiniMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
	return (
		<div className="p-3 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] min-w-0">
			<p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
			<p className="mt-1 text-sm font-semibold text-[var(--text-primary)] truncate" title={value}>
				{value}
			</p>
			<p className="mt-1 text-xs text-[var(--text-muted)] truncate" title={detail}>
				{detail}
			</p>
		</div>
	);
}

function EmptyState() {
	return (
		<div className="p-10 text-center text-sm text-[var(--text-muted)]">
			<ShieldAlert className="w-8 h-8 mx-auto mb-3 opacity-60" />
			No review findings match the current filters.
		</div>
	);
}
