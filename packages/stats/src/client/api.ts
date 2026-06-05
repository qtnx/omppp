import type {
	BehaviorDashboardStats,
	CostDashboardStats,
	DashboardStats,
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
} from "./types";

const API_BASE = "/api";

export async function getStats(range = "24h"): Promise<DashboardStats> {
	const res = await fetch(`${API_BASE}/stats?range=${encodeURIComponent(range)}`);
	if (!res.ok) throw new Error("Failed to fetch stats");
	return res.json() as Promise<DashboardStats>;
}

export async function getOverviewStats(range = "24h"): Promise<OverviewStats> {
	const res = await fetch(`${API_BASE}/stats/overview?range=${encodeURIComponent(range)}`);
	if (!res.ok) throw new Error("Failed to fetch overview stats");
	return res.json() as Promise<OverviewStats>;
}

export async function getModelDashboardStats(range = "24h"): Promise<ModelDashboardStats> {
	const res = await fetch(`${API_BASE}/stats/model-dashboard?range=${encodeURIComponent(range)}`);
	if (!res.ok) throw new Error("Failed to fetch model stats");
	return res.json() as Promise<ModelDashboardStats>;
}

export async function getCostDashboardStats(range = "24h"): Promise<CostDashboardStats> {
	const res = await fetch(`${API_BASE}/stats/costs?range=${encodeURIComponent(range)}`);
	if (!res.ok) throw new Error("Failed to fetch cost stats");
	return res.json() as Promise<CostDashboardStats>;
}

export async function getRecentRequests(limit = 50): Promise<MessageStats[]> {
	const res = await fetch(`${API_BASE}/stats/recent?limit=${limit}`);
	if (!res.ok) throw new Error("Failed to fetch recent requests");
	return res.json() as Promise<MessageStats[]>;
}

export async function getRecentErrors(limit = 50): Promise<MessageStats[]> {
	const res = await fetch(`${API_BASE}/stats/errors?limit=${limit}`);
	if (!res.ok) throw new Error("Failed to fetch recent errors");
	return res.json() as Promise<MessageStats[]>;
}

export async function getRequestDetails(id: number): Promise<RequestDetails> {
	const res = await fetch(`${API_BASE}/request/${id}`);
	if (!res.ok) throw new Error("Failed to fetch request details");
	return res.json() as Promise<RequestDetails>;
}

export async function sync(): Promise<any> {
	const res = await fetch(`${API_BASE}/sync`);
	if (!res.ok) throw new Error("Failed to sync");
	return res.json();
}

export async function getBehaviorDashboardStats(range = "24h"): Promise<BehaviorDashboardStats> {
	const res = await fetch(`${API_BASE}/stats/behavior?range=${encodeURIComponent(range)}`);
	if (!res.ok) throw new Error("Failed to fetch behavior stats");
	return res.json() as Promise<BehaviorDashboardStats>;
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
