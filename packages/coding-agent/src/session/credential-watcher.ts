import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "./auth-storage";

export interface CredentialWatcherHandle {
	stop(): void;
}

export type CredentialWatchEventListener = (eventType: string, filename: string | Buffer | null) => void;

export interface CredentialFsWatcher {
	close(): void;
	on(event: "error", listener: (error: unknown) => void): void;
}

export type CredentialWatchFactory = (directory: string, listener: CredentialWatchEventListener) => CredentialFsWatcher;

export interface StartCredentialWatcherOptions {
	authStorage: AuthStorage;
	dbPath: string;
	debounceMs?: number;
	/** Test seam: production reloads AuthStorage, while focused tests count deterministic reload calls. */
	reload?: () => Promise<void>;
	onError?: (error: unknown) => void;
	/** Test seam: production uses fs.watch, while focused tests can inject deterministic directory events. */
	watch?: CredentialWatchFactory;
}

function watchedCredentialFilename(filename: string, dbBaseName: string): boolean {
	return filename === dbBaseName || filename === `${dbBaseName}-wal` || filename === `${dbBaseName}-shm`;
}

function filenameToString(filename: string | Buffer | null): string | undefined {
	if (typeof filename === "string") return filename;
	if (Buffer.isBuffer(filename)) return filename.toString();
	return undefined;
}

export function startCredentialWatcher(options: StartCredentialWatcherOptions): CredentialWatcherHandle {
	const dbDir = path.dirname(options.dbPath);
	const dbBaseName = path.basename(options.dbPath);
	const debounceMs = options.debounceMs ?? 400;
	const reload = options.reload ?? (() => options.authStorage.reload());
	let timer: NodeJS.Timeout | undefined;
	let stopped = false;

	const reportError = (error: unknown): void => {
		options.onError?.(error);
		logger.warn("credential watcher failed", { dbPath: options.dbPath, error: String(error) });
	};

	const runReload = (): void => {
		timer = undefined;
		if (stopped) return;
		// External SQLite/WAL writes only need a read-only AuthStorage reload; failures stay contained to the watcher.
		void reload().catch(reportError);
	};

	const scheduleReload = (): void => {
		if (stopped) return;
		clearTimeout(timer);
		// SQLite WAL commits can emit several db/-wal/-shm directory events; debounce them into one reload.
		timer = setTimeout(runReload, debounceMs);
	};

	const watch =
		options.watch ?? ((directory: string, listener: CredentialWatchEventListener) => fs.watch(directory, listener));
	let watcher: CredentialFsWatcher;
	try {
		// Watch the containing directory rather than the DB file because WAL commits update agent.db-wal before checkpoint.
		watcher = watch(dbDir, (_eventType, filename) => {
			const changed = filenameToString(filename);
			if (changed && !watchedCredentialFilename(changed, dbBaseName)) return;
			// Some platforms omit directory event filenames; reload because the event is unfilterable but credential-relevant.
			scheduleReload();
		});
	} catch (error) {
		reportError(error);
		return {
			stop(): void {},
		};
	}
	watcher.on("error", reportError);

	return {
		stop(): void {
			if (stopped) return;
			stopped = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			// Closing the fs watcher releases the session's extra event-loop handle on teardown.
			watcher.close();
		},
	};
}
