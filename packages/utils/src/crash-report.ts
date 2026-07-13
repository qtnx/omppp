import * as fs from "node:fs";
import * as path from "node:path";
import { getCrashReportsDir, VERSION } from "./dirs";

export type CrashKind = "uncaught_exception" | "unhandled_rejection" | "soft";

export interface CrashRecord {
	ts: string;
	tsMs: number;
	version: string;
	pid: number;
	kind: CrashKind;
	label: string;
	name: string;
	message: string;
	stack: string;
	cwd: string;
	sessionFile?: string;
	context?: Record<string, string | number | boolean | null>;
	count: number;
}

export interface CrashArtifact {
	path: string;
	source: "js" | "native";
	tsMs: number;
	kind: string;
	summary: string;
}

interface CrashReportInput {
	kind: CrashKind;
	label: string;
	error: unknown;
	sessionFile?: string;
	context?: Record<string, string | number | boolean | null>;
}

interface SoftCrashInput {
	label: string;
	error: unknown;
	sessionFile?: string;
	context?: Record<string, string | number | boolean | null>;
}

interface SoftCrashState {
	path: string | null;
	count: number;
}

const CRASH_FILE_RE = /^crash-([a-z_]+)-(\d+)-(\d+)\.jsonl$/;
const NATIVE_FILE_RE = /^native-([a-z_]+)-(\d+)-(\d+)\.log$/;
const SEEN_MARKER_FILE = "crash-seen.json";
const MAX_SOFT_CRASH_KEYS = 20;
const MAX_CRASH_FILES = 50;
const MAX_MESSAGE_LENGTH = 8 * 1024;
const MAX_STACK_LENGTH = 64 * 1024;
const softCrashStates = new Map<string, SoftCrashState>();
let alreadyReportingFatal = false;

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…[truncated]`;
}

function redact(value: string): string {
	return value
		.replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/\b(api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
		.replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}\b/g, "[REDACTED]");
}

function normalizeError(error: unknown): { name: string; message: string; stack: string } {
	if (error instanceof Error) {
		return {
			name: error.name || "Error",
			message: redact(truncate(error.message || "(no message)", MAX_MESSAGE_LENGTH)),
			stack: redact(truncate(error.stack || "", MAX_STACK_LENGTH)),
		};
	}

	const message = typeof error === "string" ? error : String(error);
	return { name: "Error", message: redact(truncate(message, MAX_MESSAGE_LENGTH)), stack: "" };
}

function getSeenMarkerPath(): string {
	return path.join(getCrashReportsDir(), SEEN_MARKER_FILE);
}

function readSeenUntilMs(): number | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(getSeenMarkerPath(), "utf8")) as { seenUntilMs?: unknown };
		return typeof parsed.seenUntilMs === "number" && Number.isFinite(parsed.seenUntilMs) ? parsed.seenUntilMs : null;
	} catch {
		return null;
	}
}

function nextCrashTimestamp(dir: string): number {
	let timestamp = Math.max(Date.now(), (readSeenUntilMs() ?? 0) + 1);
	while (fs.existsSync(path.join(dir, `crash-soft-${process.pid}-${timestamp}.jsonl`))) {
		timestamp++;
	}
	return timestamp;
}

function pruneCrashReports(dir: string): void {
	try {
		const entries = fs
			.readdirSync(dir)
			.map(name => ({ name, match: CRASH_FILE_RE.exec(name) }))
			.filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
			.sort((left, right) => Number(right.match[3]) - Number(left.match[3]));
		for (const entry of entries.slice(MAX_CRASH_FILES)) {
			try {
				fs.unlinkSync(path.join(dir, entry.name));
			} catch {}
		}
	} catch {}
}

function readCrashArtifact(filePath: string, name: string, tsMs: number): CrashArtifact | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").trim()) as Partial<CrashRecord>;
		const recordTsMs = typeof parsed.tsMs === "number" && Number.isFinite(parsed.tsMs) ? parsed.tsMs : tsMs;
		const kind = typeof parsed.kind === "string" ? parsed.kind : "crash";
		const label = typeof parsed.label === "string" ? parsed.label : kind;
		const message = typeof parsed.message === "string" ? parsed.message : name;
		return { path: filePath, source: "js", tsMs: recordTsMs, kind, summary: `${label}: ${message}` };
	} catch {
		return null;
	}
}

function listArtifacts(): CrashArtifact[] {
	const dir = getCrashReportsDir();
	try {
		return fs
			.readdirSync(dir)
			.flatMap(name => {
				const filePath = path.join(dir, name);
				const crashMatch = CRASH_FILE_RE.exec(name);
				if (crashMatch) {
					const artifact = readCrashArtifact(filePath, name, Number(crashMatch[3]));
					return artifact ? [artifact] : [];
				}
				const nativeMatch = NATIVE_FILE_RE.exec(name);
				if (!nativeMatch) return [];
				let tsMs = Number(nativeMatch[3]);
				if (!Number.isFinite(tsMs)) {
					try {
						tsMs = fs.statSync(filePath).mtimeMs;
					} catch {
						return [];
					}
				}
				return [
					{
						path: filePath,
						source: "native" as const,
						tsMs,
						kind: nativeMatch[1],
						summary: `Native ${nativeMatch[1]} crash: ${name}`,
					},
				];
			})
			.sort((left, right) => right.tsMs - left.tsMs);
	} catch {
		return [];
	}
}

export { getCrashLogPath, getCrashReportsDir } from "./dirs";

/** Write a single local crash report, returning its path or null when persistence fails. */
export function writeCrashReportSync(input: CrashReportInput): string | null {
	try {
		if (input.kind !== "soft") {
			if (alreadyReportingFatal) return null;
			alreadyReportingFatal = true;
		}

		const dir = getCrashReportsDir();
		fs.mkdirSync(dir, { recursive: true });
		// First write seeds seenUntilMs so this report stays unread after restart.
		ensureCrashSeenMarker();
		const error = normalizeError(input.error);
		let tsMs = nextCrashTimestamp(dir);
		let filePath = path.join(dir, `crash-${input.kind}-${process.pid}-${tsMs}.jsonl`);
		while (fs.existsSync(filePath)) {
			tsMs++;
			filePath = path.join(dir, `crash-${input.kind}-${process.pid}-${tsMs}.jsonl`);
		}
		const record: CrashRecord = {
			ts: new Date(tsMs).toISOString(),
			tsMs,
			version: VERSION,
			pid: process.pid,
			kind: input.kind,
			label: input.label,
			name: error.name,
			message: error.message,
			stack: error.stack,
			cwd: process.cwd(),
			...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
			...(input.context ? { context: input.context } : {}),
			count: 1,
		};
		fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		pruneCrashReports(dir);
		return filePath;
	} catch {
		return null;
	}
}

/** Persist a whitelisted soft failure once per redacted label/message pair. */
export function reportSoftCrash(input: SoftCrashInput): { path: string | null; deduped: boolean } {
	const normalized = normalizeError(input.error);
	const key = `${input.label}\0${normalized.message}`;
	const existing = softCrashStates.get(key);
	if (existing) {
		existing.count++;
		return { path: existing.path, deduped: true };
	}
	if (softCrashStates.size >= MAX_SOFT_CRASH_KEYS) {
		return { path: null, deduped: true };
	}

	const reportPath = writeCrashReportSync({ ...input, kind: "soft" });
	softCrashStates.set(key, { path: reportPath, count: 1 });
	return { path: reportPath, deduped: false };
}

/** Initialize the seen marker to now on first use, hiding historical artifacts. */
export function ensureCrashSeenMarker(): { seenUntilMs: number } {
	const existing = readSeenUntilMs();
	if (existing !== null) return { seenUntilMs: existing };
	const seenUntilMs = Date.now();
	try {
		fs.mkdirSync(getCrashReportsDir(), { recursive: true });
		fs.writeFileSync(getSeenMarkerPath(), `${JSON.stringify({ seenUntilMs })}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {}
	return { seenUntilMs };
}

/** List JS and native crash artifacts newer than the shared seen marker. */
export function listUnreadCrashArtifacts(): CrashArtifact[] {
	const marker = ensureCrashSeenMarker();
	return listArtifacts().filter(artifact => artifact.tsMs > marker.seenUntilMs);
}

/** Advance the shared marker through all current artifacts, or a supplied timestamp. */
export function markCrashArtifactsSeen(upToMs?: number): void {
	const current = ensureCrashSeenMarker().seenUntilMs;
	const newestArtifact = listArtifacts().reduce((latest, artifact) => Math.max(latest, artifact.tsMs), current);
	const seenUntilMs = Math.max(current, newestArtifact, upToMs ?? current, Date.now());
	try {
		fs.mkdirSync(getCrashReportsDir(), { recursive: true });
		fs.writeFileSync(getSeenMarkerPath(), `${JSON.stringify({ seenUntilMs })}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {}
}

/** Human-readable stderr line emitted after a successful fatal crash write. */
export function formatCrashReportPathLine(reportPath: string): string {
	return `Crash report: ${reportPath}`;
}

/** Test-only reset for in-process soft dedupe and fatal reentrancy state. */
export function __resetCrashReportStateForTests(): void {
	softCrashStates.clear();
	alreadyReportingFatal = false;
}
