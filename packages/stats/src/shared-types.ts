/**
 * Shared type definitions consumed by both the server-side stats code and the
 * standalone client bundle. Keep this file free of any imports from server-only
 * packages (e.g. `@oh-my-pi/pi-ai`, `bun:sqlite`) so the client can import it
 * without dragging server dependencies into its bundle.
 */

/**
 * Aggregated stats for a model or folder.
 */
export interface AggregatedStats {
	/** Total number of requests */
	totalRequests: number;
	/** Number of successful requests */
	successfulRequests: number;
	/** Number of failed requests */
	failedRequests: number;
	/** Error rate (0-1) */
	errorRate: number;
	/** Total input tokens */
	totalInputTokens: number;
	/** Total output tokens */
	totalOutputTokens: number;
	/** Total cache read tokens */
	totalCacheReadTokens: number;
	/** Total cache write tokens */
	totalCacheWriteTokens: number;
	/** Cache hit rate (0-1) */
	cacheRate: number;
	/** Total cost */
	totalCost: number;
	/** Total premium requests */
	totalPremiumRequests: number;
	/** Average duration in ms */
	avgDuration: number | null;
	/** Average TTFT in ms */
	avgTtft: number | null;
	/** Average tokens per second (output tokens / duration) */
	avgTokensPerSecond: number | null;
	/** Time range */
	firstTimestamp: number;
	lastTimestamp: number;
}

/**
 * Stats grouped by model.
 */
export interface ModelStats extends AggregatedStats {
	model: string;
	provider: string;
}

/**
 * Stats grouped by folder.
 */
export interface FolderStats extends AggregatedStats {
	folder: string;
}

/**
 * Time series data point.
 */
export interface TimeSeriesPoint {
	/** Bucket timestamp (start of hour/day) */
	timestamp: number;
	/** Request count */
	requests: number;
	/** Error count */
	errors: number;
	/** Total tokens */
	tokens: number;
	/** Total cost */
	cost: number;
}

/**
 * Model usage time series data point (daily buckets).
 */
export interface ModelTimeSeriesPoint {
	/** Bucket timestamp (start of day) */
	timestamp: number;
	/** Model name */
	model: string;
	/** Provider name */
	provider: string;
	/** Request count */
	requests: number;
}

/**
 * Model performance time series data point (daily buckets).
 */
export interface ModelPerformancePoint {
	/** Bucket timestamp (start of day) */
	timestamp: number;
	/** Model name */
	model: string;
	/** Provider name */
	provider: string;
	/** Request count */
	requests: number;
	/** Average TTFT in ms */
	avgTtft: number | null;
	/** Average tokens per second */
	avgTokensPerSecond: number | null;
}

/**
 * Cost time series data point (daily buckets).
 */
export interface CostTimeSeriesPoint {
	/** Bucket timestamp (start of day) */
	timestamp: number;
	/** Model name */
	model: string;
	/** Provider name */
	provider: string;
	/** Total cost for this bucket */
	cost: number;
	/** Cost breakdown */
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	/** Request count */
	requests: number;
}

/**
 * Overall dashboard stats.
 */
export interface DashboardStats {
	overall: AggregatedStats;
	byModel: ModelStats[];
	byFolder: FolderStats[];
	timeSeries: TimeSeriesPoint[];
	modelSeries: ModelTimeSeriesPoint[];
	modelPerformanceSeries: ModelPerformancePoint[];
	costSeries: CostTimeSeriesPoint[];
}

/**
 * Behavior time-series point (daily bucket, per responding model).
 */
export interface BehaviorTimeSeriesPoint {
	/** Bucket timestamp (start of day) */
	timestamp: number;
	/** Responding model ("unknown" if user msg never got a reply) */
	model: string;
	/** Responding provider */
	provider: string;
	/** Number of user messages in bucket */
	messages: number;
	/** Total yelling sentences in bucket */
	yelling: number;
	/** Total profanity hits in bucket */
	profanity: number;
	/** Total anguish signal in bucket */
	anguish: number;
	/** Total corrective-negation hits in bucket */
	negation: number;
	/** Total user-repeating-themselves hits in bucket */
	repetition: number;
	/** Total second-person blame hits in bucket */
	blame: number;
	/** Total characters in bucket */
	chars: number;
}

export interface BehaviorOverallStats {
	totalMessages: number;
	totalYelling: number;
	totalProfanity: number;
	totalAnguish: number;
	totalNegation: number;
	totalRepetition: number;
	totalBlame: number;
	totalChars: number;
	firstTimestamp: number;
	lastTimestamp: number;
}

/**
 * Per-model behavioral aggregate over the active range.
 */
export interface BehaviorModelStats {
	model: string;
	provider: string;
	totalMessages: number;
	totalYelling: number;
	totalProfanity: number;
	totalAnguish: number;
	totalNegation: number;
	totalRepetition: number;
	totalBlame: number;
	totalChars: number;
	lastTimestamp: number;
}

export interface BehaviorDashboardStats {
	overall: BehaviorOverallStats;
	byModel: BehaviorModelStats[];
	behaviorSeries: BehaviorTimeSeriesPoint[];
}

export interface LearningAuditSummary {
	id: string;
	createdAt: number;
	updatedAt: number;
	sessionId: string;
	cwd: string;
	sourceMessageHash: string;
	userMessagePreview: string;
	scope: string;
	trigger: string;
	confidence: number | null;
	reason: string;
	classifierStatus: string;
	classifierModel: string;
	classifierError: string;
	writerStatus: string;
	writerModel: string;
	writerExitCode: number | null;
	stored: boolean;
	outcome: string;
	auditDir: string;
	auditJsonPath: string;
	classifierRequestPath: string;
	classifierResponsePath: string;
	writerRequestPath: string;
	writerResultPath: string;
	writerSessionPath: string;
	writerOutputPath: string;
}

export interface LearningAuditListResponse {
	audits: LearningAuditSummary[];
	total: number;
}

export interface LearningAuditFile {
	path: string;
	content: string;
	truncated: boolean;
	size: number;
	error?: string;
}

export interface LearningAuditDetail {
	audit: LearningAuditSummary;
	auditJson: unknown;
	files: {
		candidate: LearningAuditFile;
		classifierRequest: LearningAuditFile;
		classifierResponse: LearningAuditFile;
		writerRequest: LearningAuditFile;
		writerResult: LearningAuditFile;
		writerSession: LearningAuditFile;
		writerOutput: LearningAuditFile;
	};
}

export interface SessionStatsAggregate {
	sessionFile: string;
	folder: string;
	totalRequests: number;
	failedRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalTokens: number;
	totalCost: number;
	totalPremiumRequests: number;
	avgDuration: number | null;
	avgTtft: number | null;
	firstTimestamp: number;
	lastTimestamp: number;
	models: string[];
}

export interface SessionSummary {
	id: string;
	path: string;
	title?: string;
	cwd: string;
	created: number;
	modified: number;
	size: number;
	depth: number;
	parentPath?: string;
	parentTaskId?: string;
	agentName?: string;
	task?: string;
	firstUserMessage?: string;
	messageCount: number;
	userMessageCount: number;
	assistantMessageCount: number;
	toolResultCount: number;
	subagentCount: number;
	stats?: SessionStatsAggregate;
}

export interface SessionListResponse {
	sessions: SessionSummary[];
	total: number;
}

export interface TraceNode {
	id: string;
	parentId: string | null;
	type: string;
	role?: string;
	timestamp?: number;
	title: string;
	preview: string;
	entry: unknown;
	children: TraceNode[];
	subtraces: SessionTrace[];
}

export interface SessionTrace {
	summary: SessionSummary;
	nodes: TraceNode[];
	flatEntryCount: number;
	orphanSubtraces: SessionTrace[];
	truncatedSubtraces: boolean;
}
