import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getLearningAuditDetail, listLearningAudits } from "../src/learning-audit";

const tempDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-learning-audit-"));
	tempDirs.add(dir);
	return dir;
}

describe("learning audit stats API model", () => {
	afterEach(async () => {
		for (const dir of tempDirs) {
			await fs.rm(dir, { recursive: true, force: true });
		}
		tempDirs.clear();
	});

	test("lists audit events and loads raw audit files", async () => {
		const dir = await makeTempDir();
		const dbPath = path.join(dir, "agent.db");
		const auditDir = path.join(dir, "audit");
		await Promise.all([
			Bun.write(path.join(auditDir, "candidate.json"), JSON.stringify({ userMessage: "audit me" })),
			Bun.write(path.join(auditDir, "classifier-request.json"), JSON.stringify({ request: "classifier" })),
			Bun.write(path.join(auditDir, "classifier-response.json"), JSON.stringify({ decision: "store" })),
			Bun.write(path.join(auditDir, "writer-request.json"), JSON.stringify({ task: "writer" })),
			Bun.write(path.join(auditDir, "writer-result.json"), JSON.stringify({ status: "store" })),
			Bun.write(path.join(auditDir, "learning-writer.jsonl"), '{"type":"session"}\n'),
			Bun.write(path.join(auditDir, "learning-writer.md"), "stored learning"),
			Bun.write(path.join(auditDir, "audit.json"), JSON.stringify({ outcome: "stored" })),
		]);

		const db = new Database(dbPath);
		try {
			db.exec(`
CREATE TABLE live_learning_audit_events (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	source_message_hash TEXT NOT NULL,
	user_message_preview TEXT NOT NULL,
	scope TEXT NOT NULL,
	trigger TEXT NOT NULL,
	confidence REAL,
	reason TEXT NOT NULL,
	classifier_status TEXT NOT NULL,
	classifier_model TEXT NOT NULL,
	classifier_error TEXT NOT NULL,
	writer_status TEXT NOT NULL,
	writer_model TEXT NOT NULL,
	writer_exit_code INTEGER,
	stored INTEGER NOT NULL,
	outcome TEXT NOT NULL,
	audit_dir TEXT NOT NULL,
	audit_json_path TEXT NOT NULL,
	classifier_request_path TEXT NOT NULL,
	classifier_response_path TEXT NOT NULL,
	writer_request_path TEXT NOT NULL,
	writer_result_path TEXT NOT NULL,
	writer_session_path TEXT NOT NULL,
	writer_output_path TEXT NOT NULL
);
`);
			db.prepare(`
INSERT INTO live_learning_audit_events (
	id, created_at, updated_at, session_id, cwd, source_message_hash, user_message_preview,
	scope, trigger, confidence, reason, classifier_status, classifier_model, classifier_error,
	writer_status, writer_model, writer_exit_code, stored, outcome, audit_dir, audit_json_path,
	classifier_request_path, classifier_response_path, writer_request_path, writer_result_path,
	writer_session_path, writer_output_path
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
				"audit-1",
				100,
				101,
				"session-1",
				"/repo",
				"hash",
				"audit me",
				"repo",
				"guideline",
				0.93,
				"reason",
				"success",
				"openai/smol",
				"",
				"store",
				"openai/plan",
				0,
				1,
				"stored",
				auditDir,
				path.join(auditDir, "audit.json"),
				path.join(auditDir, "classifier-request.json"),
				path.join(auditDir, "classifier-response.json"),
				path.join(auditDir, "writer-request.json"),
				path.join(auditDir, "writer-result.json"),
				path.join(auditDir, "learning-writer.jsonl"),
				path.join(auditDir, "learning-writer.md"),
			);
		} finally {
			db.close();
		}

		const list = await listLearningAudits({ agentDbPath: dbPath, query: "smol" });
		expect(list.total).toBe(1);
		expect(list.audits[0]).toMatchObject({ id: "audit-1", stored: true, classifierStatus: "success" });

		const detail = await getLearningAuditDetail("audit-1", { agentDbPath: dbPath });
		expect(detail?.auditJson).toEqual({ outcome: "stored" });
		expect(detail?.files.classifierRequest.content).toContain("classifier");
		expect(detail?.files.writerSession.content).toContain("session");
	});
});
