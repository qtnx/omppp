import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, CheckCircle2, Database, FileText, Search, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getLearningAuditDetail, getLearningAudits } from "../api";
import type { LearningAuditDetail, LearningAuditSummary } from "../types";

type FileKey = keyof LearningAuditDetail["files"] | "auditJson";

const fileTabs: Array<{ key: FileKey; label: string }> = [
	{ key: "candidate", label: "Candidate" },
	{ key: "classifierRequest", label: "Classifier req" },
	{ key: "classifierResponse", label: "Classifier res" },
	{ key: "writerRequest", label: "Writer req" },
	{ key: "writerResult", label: "Writer result" },
	{ key: "writerSession", label: "Writer JSONL" },
	{ key: "writerOutput", label: "Writer output" },
	{ key: "auditJson", label: "Audit JSON" },
];

export function LearningAuditView() {
	const [audits, setAudits] = useState<LearningAuditSummary[]>([]);
	const [total, setTotal] = useState(0);
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detail, setDetail] = useState<LearningAuditDetail | null>(null);
	const [loadingList, setLoadingList] = useState(true);
	const [loadingDetail, setLoadingDetail] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [activeFile, setActiveFile] = useState<FileKey>("classifierResponse");

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			setLoadingList(true);
			try {
				const response = await getLearningAudits(query, 100);
				if (cancelled) return;
				setAudits(response.audits);
				setTotal(response.total);
				setSelectedId(current => current ?? response.audits[0]?.id ?? null);
				setError(null);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (!cancelled) setLoadingList(false);
			}
		};
		load();
		const interval = setInterval(load, 30000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [query]);

	useEffect(() => {
		if (!selectedId) {
			setDetail(null);
			return;
		}
		let cancelled = false;
		const load = async () => {
			setLoadingDetail(true);
			try {
				const response = await getLearningAuditDetail(selectedId);
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

	const selectedAudit = useMemo(
		() => audits.find(audit => audit.id === selectedId) ?? detail?.audit ?? null,
		[audits, detail, selectedId],
	);

	return (
		<div className="animate-fade-in space-y-5">
			<section className="surface p-5 overflow-hidden relative">
				<div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[var(--accent-cyan)] via-[var(--accent-violet)] to-[var(--accent-pink)]" />
				<div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
					<div className="flex items-start gap-4">
						<div className="w-12 h-12 rounded-2xl bg-[rgba(34,211,238,0.12)] border border-[rgba(34,211,238,0.25)] flex items-center justify-center">
							<ShieldCheck className="w-6 h-6 text-[var(--accent-cyan)]" />
						</div>
						<div>
							<div className="flex items-center gap-3">
								<h2 className="text-2xl font-semibold text-[var(--text-primary)]">Learning Audit</h2>
								<span className="badge badge-info">{total.toLocaleString()} events</span>
							</div>
							<p className="text-sm text-[var(--text-muted)] max-w-3xl mt-1">
								Raw local artifacts for live-learning classification and writer runs. Use this to inspect what
								the classifier saw, what it decided, and the exact writer-agent JSONL transcript.
							</p>
						</div>
					</div>
					<label className="relative min-w-[280px]">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
						<input
							value={query}
							onChange={event => setQuery(event.target.value)}
							placeholder="Filter by session, cwd, model, trigger..."
							className="w-full pl-10 pr-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-default)] text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)]"
						/>
					</label>
				</div>
			</section>

			{error && (
				<div className="surface p-4 border-[rgba(248,113,113,0.3)] text-[var(--accent-red)] flex items-center gap-2">
					<AlertTriangle className="w-4 h-4" />
					<span className="text-sm">{error}</span>
				</div>
			)}

			<div className="grid xl:grid-cols-[440px_1fr] gap-5 h-[calc(100vh-230px)] min-h-[620px]">
				<section className="surface overflow-hidden flex flex-col">
					<div className="px-4 py-3 border-b border-[var(--border-subtle)] flex items-center justify-between">
						<div>
							<h3 className="font-semibold text-[var(--text-primary)]">Audit events</h3>
							<p className="text-xs text-[var(--text-muted)]">Newest first</p>
						</div>
						{loadingList && (
							<div className="w-4 h-4 border-2 border-[var(--border-default)] border-t-[var(--accent-cyan)] rounded-full spin" />
						)}
					</div>
					<div className="overflow-auto divide-y divide-[var(--border-subtle)]">
						{audits.length === 0 && !loadingList ? (
							<EmptyState />
						) : (
							audits.map(audit => (
								<button
									key={audit.id}
									type="button"
									onClick={() => setSelectedId(audit.id)}
									className={`w-full text-left px-4 py-3 transition-colors ${selectedId === audit.id ? "bg-[var(--bg-active)]" : "hover:bg-[var(--bg-hover)]"}`}
								>
									<div className="flex items-center justify-between gap-3">
										<StatusBadge value={audit.outcome} positive={audit.stored} />
										<span className="text-xs text-[var(--text-muted)] whitespace-nowrap">
											{formatDistanceToNow(audit.createdAt * 1000, { addSuffix: true })}
										</span>
									</div>
									<p className="mt-2 text-sm text-[var(--text-primary)] line-clamp-2">
										{audit.userMessagePreview}
									</p>
									<div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
										<span>
											{audit.scope || "none"}/{audit.trigger || "none"}
										</span>
										<span>classifier: {audit.classifierStatus}</span>
										<span>writer: {audit.writerStatus}</span>
									</div>
								</button>
							))
						)}
					</div>
				</section>

				<section className="surface overflow-hidden flex flex-col">
					{selectedAudit ? (
						<>
							<AuditHeader audit={selectedAudit} loading={loadingDetail} />
							{detail ? (
								<AuditFiles detail={detail} activeFile={activeFile} onActiveFileChange={setActiveFile} />
							) : (
								<div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
									Loading audit detail...
								</div>
							)}
						</>
					) : (
						<div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
							Select an audit event.
						</div>
					)}
				</section>
			</div>
		</div>
	);
}

function AuditHeader({ audit, loading }: { audit: LearningAuditSummary; loading: boolean }) {
	return (
		<div className="p-4 border-b border-[var(--border-subtle)] space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<StatusBadge value={audit.outcome} positive={audit.stored} />
					<span className="text-xs font-mono text-[var(--text-muted)]">{audit.id}</span>
				</div>
				<div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
					{loading && (
						<div className="w-3.5 h-3.5 border-2 border-[var(--border-default)] border-t-[var(--accent-cyan)] rounded-full spin" />
					)}
					<span>{new Date(audit.createdAt * 1000).toLocaleString()}</span>
				</div>
			</div>
			<div className="grid md:grid-cols-4 gap-3">
				<MiniMetric
					label="Classifier"
					value={audit.classifierStatus}
					detail={audit.classifierModel || "no model"}
				/>
				<MiniMetric label="Writer" value={audit.writerStatus} detail={audit.writerModel || "not run"} />
				<MiniMetric label="Decision" value={audit.scope || "none"} detail={audit.trigger || "none"} />
				<MiniMetric
					label="Confidence"
					value={audit.confidence === null ? "n/a" : `${Math.round(audit.confidence * 100)}%`}
					detail={audit.stored ? "stored" : "not stored"}
				/>
			</div>
			<p className="text-sm text-[var(--text-secondary)]">{audit.userMessagePreview}</p>
			<p className="text-xs font-mono text-[var(--text-muted)] truncate" title={audit.auditDir}>
				{audit.auditDir}
			</p>
		</div>
	);
}

function AuditFiles({
	detail,
	activeFile,
	onActiveFileChange,
}: {
	detail: LearningAuditDetail;
	activeFile: FileKey;
	onActiveFileChange: (key: FileKey) => void;
}) {
	const file = activeFile === "auditJson" ? null : detail.files[activeFile];
	const content = activeFile === "auditJson" ? JSON.stringify(detail.auditJson, null, 2) : (file?.content ?? "");
	const filePath = activeFile === "auditJson" ? detail.audit.auditJsonPath : (file?.path ?? "");
	const error = activeFile === "auditJson" ? undefined : file?.error;
	const truncated = activeFile === "auditJson" ? false : (file?.truncated ?? false);
	const size = activeFile === "auditJson" ? content.length : (file?.size ?? 0);

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<div className="px-4 py-3 border-b border-[var(--border-subtle)] flex flex-wrap gap-2">
				{fileTabs.map(tab => (
					<button
						key={tab.key}
						type="button"
						onClick={() => onActiveFileChange(tab.key)}
						className={`tab-btn text-xs ${activeFile === tab.key ? "active" : ""}`}
					>
						{tab.label}
					</button>
				))}
			</div>
			<div className="px-4 py-2 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
				<div className="flex items-center gap-2 min-w-0">
					<FileText className="w-4 h-4 shrink-0" />
					<span className="font-mono truncate" title={filePath}>
						{filePath || "No file recorded"}
					</span>
				</div>
				<div className="flex items-center gap-3">
					<span>{formatBytes(size)}</span>
					{truncated && <span className="badge badge-warning">preview truncated</span>}
				</div>
			</div>
			<div className="flex-1 min-h-0 overflow-auto bg-[var(--bg-elevated)]">
				{error ? (
					<div className="m-4 surface p-4 text-sm text-[var(--accent-red)] flex items-center gap-2">
						<XCircle className="w-4 h-4" />
						{error}
					</div>
				) : (
					<pre className="p-4 text-xs leading-5 text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono">
						{content || "(empty)"}
					</pre>
				)}
			</div>
		</div>
	);
}

function MiniMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
	return (
		<div className="surface-elevated p-3">
			<div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
			<div className="mt-1 text-sm font-semibold text-[var(--text-primary)] truncate" title={value}>
				{value}
			</div>
			<div className="text-xs text-[var(--text-muted)] truncate" title={detail}>
				{detail}
			</div>
		</div>
	);
}

function StatusBadge({ value, positive }: { value: string; positive?: boolean }) {
	const className = positive
		? "badge badge-success"
		: value.includes("failed") || value.includes("unavailable")
			? "badge badge-error"
			: value.includes("skipped") || value.includes("threshold")
				? "badge badge-warning"
				: "badge badge-info";
	const Icon = positive
		? CheckCircle2
		: value.includes("failed") || value.includes("unavailable")
			? XCircle
			: Database;
	return (
		<span className={`${className} gap-1.5`}>
			<Icon className="w-3.5 h-3.5" />
			{value || "unknown"}
		</span>
	);
}

function EmptyState() {
	return (
		<div className="p-8 text-center text-sm text-[var(--text-muted)]">
			<Database className="w-8 h-8 mx-auto mb-3 opacity-60" />
			No learning audit events yet. Trigger a live-learning classify/write run and refresh this tab.
		</div>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
