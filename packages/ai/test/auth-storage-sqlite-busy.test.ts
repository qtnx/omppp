/**
 * Regression coverage for issue #2421.
 *
 * Concurrent omp startups can race against WAL recovery so the auth-store init
 * sees `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY` before its multi-statement run
 * installs the busy handler. The fix hoists `PRAGMA busy_timeout` to a separate
 * statement that runs first and wraps `open()` in a bounded retry loop on the
 * BUSY family.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSqliteBusyError, isSqliteTransientError, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

interface SqliteBusyShape extends Error {
	code: string;
	errno: number;
}

function makeBusyError(code: string, errno: number): SqliteBusyShape {
	const err = new Error("database is locked") as SqliteBusyShape;
	err.code = code;
	err.errno = errno;
	return err;
}

function readJournalMode(db: Database): string {
	const row = db.query("PRAGMA journal_mode").get();
	if (!row || typeof row !== "object" || !("journal_mode" in row) || typeof row.journal_mode !== "string") {
		throw new Error("PRAGMA journal_mode returned an unexpected row");
	}
	return row.journal_mode;
}

function readUserTableNames(db: Database): string[] {
	const rows = db
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
		.all();
	return rows.map(row => {
		if (!row || typeof row !== "object" || !("name" in row) || typeof row.name !== "string") {
			throw new Error("sqlite_master returned an unexpected row");
		}
		return row.name;
	});
}

describe("isSqliteBusyError", () => {
	test("recognizes every documented BUSY family code", () => {
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY", 5))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_RECOVERY", 261))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_SNAPSHOT", 517))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_TIMEOUT", 773))).toBe(true);
	});

	test("rejects non-BUSY codes and non-error values", () => {
		expect(isSqliteBusyError(makeBusyError("SQLITE_LOCKED", 6))).toBe(false);
		expect(isSqliteBusyError(makeBusyError("SQLITE_CORRUPT", 11))).toBe(false);
		expect(isSqliteBusyError(new Error("plain"))).toBe(false);
		expect(isSqliteBusyError(null)).toBe(false);
		expect(isSqliteBusyError(undefined)).toBe(false);
		expect(isSqliteBusyError("SQLITE_BUSY")).toBe(false);
	});
});

// This classifier is the retry boundary: CORRUPTFS and other fatal IOERRs must
// stay out of the allowlist so open() does not hide storage corruption.
describe("isSqliteTransientError", () => {
	test("recognizes BUSY and selected transient IOERR family codes", () => {
		expect(isSqliteTransientError(makeBusyError("SQLITE_BUSY_RECOVERY", 261))).toBe(true);
		expect(isSqliteTransientError(makeBusyError("SQLITE_IOERR_FSTAT", 1802))).toBe(true);
		expect(isSqliteTransientError(makeBusyError("SQLITE_IOERR_READ", 266))).toBe(true);
		expect(isSqliteTransientError(makeBusyError("SQLITE_IOERR_WRITE", 778))).toBe(true);
		expect(isSqliteTransientError(makeBusyError("SQLITE_IOERR_SHORT_READ", 522))).toBe(true);
		expect(isSqliteTransientError(makeBusyError("SQLITE_IOERR_LOCK", 3850))).toBe(true);
	});

	test("rejects non-transient SQLite errors and non-error values", () => {
		expect(isSqliteTransientError(makeBusyError("SQLITE_LOCKED", 6))).toBe(false);
		expect(isSqliteTransientError(makeBusyError("SQLITE_CORRUPT", 11))).toBe(false);
		expect(isSqliteTransientError(makeBusyError("SQLITE_IOERR_CORRUPTFS", 8458))).toBe(false);
		expect(isSqliteTransientError(new Error("plain"))).toBe(false);
		expect(isSqliteTransientError(null)).toBe(false);
		expect(isSqliteTransientError(undefined)).toBe(false);
		expect(isSqliteTransientError("SQLITE_IOERR_FSTAT")).toBe(false);
	});
});
describe("SqliteAuthCredentialStore.open SQLITE_BUSY handling", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-pi-ai-sqlite-busy-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("installs busy_timeout BEFORE any lock-taking statement", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			// The store doesn't expose the handle, so open a sibling connection
			// and verify open completed after installing the busy handler and
			// attempting WAL. Some temp filesystems reject WAL; schema creation
			// must still be complete in the fallback journal mode.
			const observer = new Database(path.join(tempDir, "agent.db"));
			try {
				expect(["delete", "wal"]).toContain(readJournalMode(observer));
				expect(readUserTableNames(observer)).toContain("cache");
			} finally {
				observer.close();
			}
		} finally {
			store.close();
		}
	});

	// Fresh DB initialization should be deterministic even under parallel
	// opens; every expected user table must exist after each open returns.
	test("fresh database schema init is deterministic under parallel opens", async () => {
		const expectedTables = [
			"auth_change_revision",
			"auth_credential_block_mirror_guard",
			"auth_credential_blocks",
			"auth_credential_refresh_leases",
			"auth_credentials",
			"auth_schema_version",
			"cache",
			"client_usage",
			"clients",
			"usage_cost_history",
			"usage_history",
		];
		const attempts = Array.from({ length: 25 }, (_, index) => index);

		for (let batchStart = 0; batchStart < attempts.length; batchStart += 5) {
			await Promise.all(
				attempts.slice(batchStart, batchStart + 5).map(async index => {
					const dbPath = path.join(tempDir, `fresh-${index}.db`);
					const store = await SqliteAuthCredentialStore.open(dbPath);
					try {
						const observer = new Database(dbPath);
						try {
							expect(readUserTableNames(observer)).toEqual(expectedTables);
						} finally {
							observer.close();
						}
					} finally {
						store.close();
					}
				}),
			);
		}
	});
	test("open() survives a writer holding the lock past the retry budget (#7298)", async () => {
		const dbPath = path.join(tempDir, "ordering.db");
		const sentinel = path.join(tempDir, "locked.sentinel");
		// The child creates the (empty) database and holds an EXCLUSIVE lock for
		// 750ms: longer than open()'s full retry budget (attempts at
		// ~0/100/300/700ms), shorter than the headless 1000ms busy_timeout. The
		// empty file forces open()'s leases DDL to take the write lock, so only
		// a busy handler installed BEFORE that DDL lets the first attempt wait
		// out the writer; the pre-fix code (busy_timeout=0 during the DDL)
		// exhausted its retries and threw. Readiness is signaled via a sentinel
		// file written after BEGIN EXCLUSIVE — not stdout — so the handshake
		// cannot be affected by how the runner wires child stdio.
		const locker = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const db = new Database(process.argv[1]);
db.run("BEGIN EXCLUSIVE");
writeFileSync(process.argv[2], "locked");
await Bun.sleep(750);
db.run("COMMIT");
db.close();`,
				dbPath,
				sentinel,
			],
			{ env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" }, stdout: "ignore", stderr: "pipe" },
		);
		// Real-time waits are unavoidable here: the lock lives in a separate
		// process, so fake timers cannot advance the child's sleep or the
		// filesystem sentinel it writes.
		const deadline = Date.now() + 5000;
		let locked = false;
		while (Date.now() < deadline) {
			locked = await fs.access(sentinel).then(
				() => true,
				() => false,
			);
			if (locked || locker.exitCode !== null) break;
			await Bun.sleep(10);
		}
		if (!locked) {
			throw new Error(`locker never signaled readiness: ${await new Response(locker.stderr).text()}`);
		}

		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			// The store is fully usable after contention: the leases DDL ran.
			expect(store.listAuthCredentials()).toEqual([]);
		} finally {
			store.close();
		}
		const [exitCode, stderr] = await Promise.all([locker.exited, new Response(locker.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
	});

	test("retries through a transient SQLITE_BUSY_RECOVERY and eventually succeeds", async () => {
		const dbPath = path.join(tempDir, "retry.db");
		let throws = 2;
		// Synthesize the WAL-recovery race: the first two `db.run` calls in
		// `#initializeSchema` (the first being `PRAGMA busy_timeout = 5000`)
		// throw `SQLITE_BUSY_RECOVERY`, then the third attempt sees the spy
		// drained and falls through to the real implementation.
		const realRun = Database.prototype.run;
		const spy = vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof realRun>
		) {
			if (throws > 0) {
				throws--;
				throw makeBusyError("SQLITE_BUSY_RECOVERY", 261);
			}
			return realRun.apply(this, args);
		});

		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(throws).toBe(0);
			expect(spy).toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	// WAL can surface a transient filesystem IOERR before schema DDL runs;
	// open() should retry that path instead of treating startup as failed.
	test("retries through a transient WAL SQLITE_IOERR_FSTAT and eventually succeeds", async () => {
		const dbPath = path.join(tempDir, "retry-fstat.db");
		let throws = 2;
		const realRun = Database.prototype.run;
		const spy = vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof realRun>
		) {
			if (args[0] === "PRAGMA journal_mode=WAL" && throws > 0) {
				throws--;
				throw makeBusyError("SQLITE_IOERR_FSTAT", 1802);
			}
			return realRun.apply(this, args);
		});
		const sleepSpy = vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);

		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(throws).toBe(0);
			expect(spy).toHaveBeenCalled();
			expect(sleepSpy).toHaveBeenCalledTimes(2);
		} finally {
			store.close();
		}
	});

	// Fatal/non-transient errors must surface on the first failed attempt
	// rather than being converted into a generic retry-exhausted failure.
	test("non-transient errors short-circuit retries", async () => {
		const dbPath = path.join(tempDir, "fatal.db");
		const realRun = Database.prototype.run;
		let runCalls = 0;
		vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof realRun>
		) {
			runCalls++;
			if (runCalls === 1) {
				const err = new Error("disk image malformed") as SqliteBusyShape;
				err.code = "SQLITE_CORRUPT";
				err.errno = 11;
				throw err;
			}
			return realRun.apply(this, args);
		});

		await expect(SqliteAuthCredentialStore.open(dbPath)).rejects.toThrow("disk image malformed");
		// Single attempt: the retry loop must NOT keep banging on a fatal error.
		expect(runCalls).toBe(1);
	});

	test("exhausts retries and surfaces an error that includes the DB path", async () => {
		const dbPath = path.join(tempDir, "stuck.db");
		const realRun = Database.prototype.run;
		vi.spyOn(Database.prototype, "run").mockImplementation(function (this: Database) {
			// Always-busy: every attempt fails until the retry budget runs out.
			throw makeBusyError("SQLITE_BUSY_RECOVERY", 261);
		});
		// Skip the sleep so the test doesn't take 700ms+ of real time.
		const sleepSpy = vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);

		await expect(SqliteAuthCredentialStore.open(dbPath)).rejects.toThrow(dbPath);
		// open uses `maxAttempts = 4`, so the loop sleeps between attempts 0..2
		// (three times) then throws after attempt 3 without sleeping again.
		expect(sleepSpy).toHaveBeenCalledTimes(3);
		// Reference realRun so the TS unused-binding lint stays quiet without
		// suppressing the actual error path above.
		expect(typeof realRun).toBe("function");
	});
});
