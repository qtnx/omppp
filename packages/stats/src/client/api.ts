import type {
	BehaviorDashboardStats,
	CostDashboardStats,
	FolderStats,
	LearningAuditDetail,
	LearningAuditListResponse,
	MessageStats,
	ModelDashboardStats,
	OverviewStats,
	RequestDetails,
	ReviewFindingDetail,
	ReviewFindingGenerateResponse,
	ReviewFindingGenerationEventsResponse,
	ReviewFindingListResponse,
	ReviewFindingStatus,
	SessionListResponse,
	SessionTrace,
	TimeRange,
} from "./types";

const API_BASE = "/api";

export class ApiError extends Error {
	status: number;
	endpoint: string;

	constructor(status: number, endpoint: string, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.endpoint = endpoint;
	}
}

async function fetchJson<T>(endpoint: string, options?: RequestInit): Promise<T> {
	const res = await fetch(endpoint, options);
	if (!res.ok) {
		throw new ApiError(res.status, endpoint, `HTTP error ${res.status} on ${endpoint}`);
	}
	return res.json() as Promise<T>;
}

export async function getOverviewStats(range: TimeRange = "24h", signal?: AbortSignal): Promise<OverviewStats> {
	return fetchJson<OverviewStats>(`${API_BASE}/stats/overview?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

export async function getModelDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<ModelDashboardStats> {
	return fetchJson<ModelDashboardStats>(`${API_BASE}/stats/model-dashboard?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

export async function getCostDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<CostDashboardStats> {
	return fetchJson<CostDashboardStats>(`${API_BASE}/stats/costs?range=${encodeURIComponent(range)}`, { signal });
}

export async function getRecentRequests(limit = 50, signal?: AbortSignal): Promise<MessageStats[]> {
	return fetchJson<MessageStats[]>(`${API_BASE}/stats/recent?limit=${limit}`, { signal });
}

export async function getRecentErrors(limit = 50, signal?: AbortSignal): Promise<MessageStats[]> {
	return fetchJson<MessageStats[]>(`${API_BASE}/stats/errors?limit=${limit}`, { signal });
}

export async function getRequestDetails(id: number, signal?: AbortSignal): Promise<RequestDetails> {
	return fetchJson<RequestDetails>(`${API_BASE}/request/${id}`, { signal });
}

export async function sync(signal?: AbortSignal): Promise<{ processed: number; files: number; totalMessages: number }> {
	return fetchJson<{ processed: number; files: number; totalMessages: number }>(`${API_BASE}/sync`, { signal });
}

export async function getBehaviorDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<BehaviorDashboardStats> {
	return fetchJson<BehaviorDashboardStats>(`${API_BASE}/stats/behavior?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

export async function getFolderStats(range: TimeRange = "24h", signal?: AbortSignal): Promise<FolderStats[]> {
	return fetchJson<FolderStats[]>(`${API_BASE}/stats/folders?range=${encodeURIComponent(range)}`, { signal });
}

export async function getSessions(query = "", limit = 100): Promise<SessionListResponse> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (query.trim()) params.set("query", query.trim());
	const res = await fetch(`${API_BASE}/sessions?${params.toString()}`);
	if (!res.ok) throw new Error("Failed to fetch sessions");
	return res.json() as Promise<SessionListResponse>;
}

export async function getSessionTrace(path: string): Promise<SessionTrace> {
	const params = new URLSearchParams({ path });
	const res = await fetch(`${API_BASE}/sessions/trace?${params.toString()}`);
	if (!res.ok) throw new Error("Failed to fetch session trace");
	return res.json() as Promise<SessionTrace>;
}

export async function getLearningAudits(query = "", limit = 100): Promise<LearningAuditListResponse> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (query.trim()) params.set("query", query.trim());
	const res = await fetch(`${API_BASE}/learnings/audit?${params.toString()}`);
	if (!res.ok) throw new Error("Failed to fetch learning audit events");
	return res.json() as Promise<LearningAuditListResponse>;
}

export async function getLearningAuditDetail(id: string): Promise<LearningAuditDetail> {
	const res = await fetch(`${API_BASE}/learnings/audit/${encodeURIComponent(id)}`);
	if (!res.ok) throw new Error("Failed to fetch learning audit detail");
	return res.json() as Promise<LearningAuditDetail>;
}

async function parseApiError(res: Response, fallback: string): Promise<Error> {
	try {
		const body = (await res.json()) as { error?: unknown };
		return new Error(typeof body.error === "string" ? body.error : fallback);
	} catch {
		return new Error(fallback);
	}
}

export async function getReviewFindings(
	query = "",
	status: ReviewFindingStatus = "all",
	repoRoot = "",
	limit = 100,
): Promise<ReviewFindingListResponse> {
	const params = new URLSearchParams({ limit: String(limit), status });
	if (query.trim()) params.set("query", query.trim());
	if (repoRoot.trim()) params.set("repoRoot", repoRoot.trim());
	const res = await fetch(`${API_BASE}/review-findings?${params.toString()}`);
	if (!res.ok) throw await parseApiError(res, "Failed to fetch review findings");
	return res.json() as Promise<ReviewFindingListResponse>;
}

export async function getReviewFindingDetail(id: string): Promise<ReviewFindingDetail> {
	const res = await fetch(`${API_BASE}/review-findings/${encodeURIComponent(id)}`);
	if (!res.ok) throw await parseApiError(res, "Failed to fetch review finding detail");
	return res.json() as Promise<ReviewFindingDetail>;
}

export async function getReviewFindingGenerationEvents(
	id: string,
	afterSequence: number,
): Promise<ReviewFindingGenerationEventsResponse> {
	const params = new URLSearchParams({ after: String(Math.max(0, Math.floor(afterSequence))) });
	const res = await fetch(
		`${API_BASE}/review-findings/${encodeURIComponent(id)}/generation-events?${params.toString()}`,
	);
	if (!res.ok) throw await parseApiError(res, "Failed to fetch review finding generation events");
	return res.json() as Promise<ReviewFindingGenerationEventsResponse>;
}

export async function generateReviewFindingLesson(id: string): Promise<ReviewFindingGenerateResponse> {
	const res = await fetch(`${API_BASE}/review-findings/${encodeURIComponent(id)}/generate-learning`, {
		method: "POST",
	});
	if (!res.ok) throw await parseApiError(res, "Failed to generate review finding lesson");
	return res.json() as Promise<ReviewFindingGenerateResponse>;
}
