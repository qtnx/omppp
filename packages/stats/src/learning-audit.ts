import { Database } from "bun:sqlite";
import * as path from "node:path";
import { getAgentDbPath, isEnoent } from "@oh-my-pi/pi-utils";
import type {
	LearningAuditDetail,
	LearningAuditFile,
	LearningAuditListResponse,
	LearningAuditSummary,
} from "./shared-types";

interface LearningAuditRow {
	id: string;
	created_at: number;
	updated_at: number;
	session_id: string;
	cwd: string;
	source_message_hash: string;
	user_message_preview: string;
	scope: string;
	trigger: string;
	confidence: number | null;
	reason: string;
	classifier_status: string;
	classifier_model: string;
	classifier_error: string;
	writer_status: string;
	writer_model: string;
	writer_exit_code: number | null;
	stored: number;
	outcome: string;
	audit_dir: string;
	audit_json_path: string;
	classifier_request_path: string;
	classifier_response_path: string;
	writer_request_path: string;
	writer_result_path: string;
	writer_session_path: string;
	writer_output_path: string;
}

const AUDIT_TABLE = "live_learning_audit_events";
const MAX_AUDIT_FILE_BYTES = 1024 * 1024;

export async function listLearningAudits(options?: {
	query?: string | null;
	limit?: number;
	offset?: number;
	agentDbPath?: string;
}): Promise<LearningAuditListResponse> {
	const dbPath = options?.agentDbPath ?? getAgentDbPath();
	if (!(await Bun.file(dbPath).exists())) return { audits: [], total: 0 };
	const db = new Database(dbPath);
	try {
		if (!hasAuditTable(db)) return { audits: [], total: 0 };
		const limit = clampLimit(options?.limit ?? 100);
		const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
		const query = options?.query?.trim();
		const whereParts: string[] = [];
		const params: Array<string | number> = [];
		if (query) {
			const like = `%${query}%`;
			whereParts.push(`(
				id LIKE ? OR
				session_id LIKE ? OR
				cwd LIKE ? OR
				user_message_preview LIKE ? OR
				outcome LIKE ? OR
				trigger LIKE ? OR
				classifier_model LIKE ? OR
				writer_model LIKE ?
			)`);
			params.push(like, like, like, like, like, like, like, like);
		}
		const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
		const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM ${AUDIT_TABLE} ${whereSql}`).get(...params) as
			| { total: number }
			| undefined;
		const rows = db
			.prepare(`SELECT * FROM ${AUDIT_TABLE} ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
			.all(...params, limit, offset) as LearningAuditRow[];
		return {
			audits: rows.map(rowToSummary),
			total: totalRow?.total ?? 0,
		};
	} finally {
		db.close();
	}
}

export async function getLearningAuditDetail(
	id: string,
	options?: { agentDbPath?: string },
): Promise<LearningAuditDetail | null> {
	const dbPath = options?.agentDbPath ?? getAgentDbPath();
	if (!(await Bun.file(dbPath).exists())) return null;
	const db = new Database(dbPath);
	try {
		if (!hasAuditTable(db)) return null;
		const row = db.prepare(`SELECT * FROM ${AUDIT_TABLE} WHERE id = ?`).get(id) as LearningAuditRow | undefined;
		if (!row) return null;
		const audit = rowToSummary(row);
		const candidatePath = audit.auditDir ? path.join(audit.auditDir, "candidate.json") : "";
		const [
			candidate,
			classifierRequest,
			classifierResponse,
			writerRequest,
			writerResult,
			writerSession,
			writerOutput,
		] = await Promise.all([
			readAuditFile(candidatePath),
			readAuditFile(audit.classifierRequestPath),
			readAuditFile(audit.classifierResponsePath),
			readAuditFile(audit.writerRequestPath),
			readAuditFile(audit.writerResultPath),
			readAuditFile(audit.writerSessionPath),
			readAuditFile(audit.writerOutputPath),
		]);
		const auditJsonFile = await readAuditFile(audit.auditJsonPath);
		return {
			audit,
			auditJson: parseAuditJson(auditJsonFile.content),
			files: {
				candidate,
				classifierRequest,
				classifierResponse,
				writerRequest,
				writerResult,
				writerSession,
				writerOutput,
			},
		};
	} finally {
		db.close();
	}
}

function hasAuditTable(db: Database): boolean {
	const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(AUDIT_TABLE) as
		| { name?: string }
		| undefined;
	return row?.name === AUDIT_TABLE;
}

function rowToSummary(row: LearningAuditRow): LearningAuditSummary {
	return {
		id: row.id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		sessionId: row.session_id,
		cwd: row.cwd,
		sourceMessageHash: row.source_message_hash,
		userMessagePreview: row.user_message_preview,
		scope: row.scope,
		trigger: row.trigger,
		confidence: row.confidence,
		reason: row.reason,
		classifierStatus: row.classifier_status,
		classifierModel: row.classifier_model,
		classifierError: row.classifier_error,
		writerStatus: row.writer_status,
		writerModel: row.writer_model,
		writerExitCode: row.writer_exit_code,
		stored: row.stored !== 0,
		outcome: row.outcome,
		auditDir: row.audit_dir,
		auditJsonPath: row.audit_json_path,
		classifierRequestPath: row.classifier_request_path,
		classifierResponsePath: row.classifier_response_path,
		writerRequestPath: row.writer_request_path,
		writerResultPath: row.writer_result_path,
		writerSessionPath: row.writer_session_path,
		writerOutputPath: row.writer_output_path,
	};
}

async function readAuditFile(filePath: string): Promise<LearningAuditFile> {
	if (!filePath) {
		return { path: "", content: "", truncated: false, size: 0, error: "Not recorded" };
	}
	try {
		const file = Bun.file(filePath);
		const size = file.size;
		const truncated = size > MAX_AUDIT_FILE_BYTES;
		const content = truncated ? await file.slice(0, MAX_AUDIT_FILE_BYTES).text() : await file.text();
		return { path: filePath, content, truncated, size };
	} catch (error) {
		if (isEnoent(error)) {
			return { path: filePath, content: "", truncated: false, size: 0, error: "File not found" };
		}
		return {
			path: filePath,
			content: "",
			truncated: false,
			size: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function parseAuditJson(content: string): unknown {
	if (!content.trim()) return null;
	try {
		return JSON.parse(content);
	} catch {
		return null;
	}
}

function clampLimit(limit: number): number {
	const normalized = Math.trunc(limit);
	if (!Number.isFinite(normalized)) return 100;
	return Math.max(1, Math.min(500, normalized));
}
