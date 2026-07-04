import { afterEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CredentialFsWatcher,
	type CredentialWatchEventListener,
	type CredentialWatcherHandle,
	startCredentialWatcher,
} from "@oh-my-pi/pi-coding-agent/session/credential-watcher";

class FakeCredentialFsWatcher implements CredentialFsWatcher {
	closed = false;
	errorListener: ((error: unknown) => void) | undefined;

	constructor(private readonly listener: CredentialWatchEventListener) {}

	on(event: "error", listener: (error: unknown) => void): void {
		if (event === "error") this.errorListener = listener;
	}

	emit(filename: string | Buffer | null): void {
		if (this.closed) return;
		// The injected event seam models fs.watch events from the watched directory without real wall-clock waits.
		this.listener("change", filename);
	}

	close(): void {
		this.closed = true;
	}
}

interface WatcherHarness {
	dbPath: string;
	watchedDirectory: string | undefined;
	watcher: FakeCredentialFsWatcher | undefined;
	start(reload: () => Promise<void>): CredentialWatcherHandle;
}

function createHarness(): WatcherHarness {
	const dbPath = path.join("/tmp", "omp-credential-watcher", "agent.db");
	let watchedDirectory: string | undefined;
	let watcher: FakeCredentialFsWatcher | undefined;
	return {
		dbPath,
		get watchedDirectory() {
			return watchedDirectory;
		},
		get watcher() {
			return watcher;
		},
		start(reload: () => Promise<void>): CredentialWatcherHandle {
			return startCredentialWatcher({
				authStorage: { reload: async () => {} } as unknown as AuthStorage,
				dbPath,
				debounceMs: 25,
				reload,
				watch: (directory, listener) => {
					watchedDirectory = directory;
					watcher = new FakeCredentialFsWatcher(listener);
					return watcher;
				},
			});
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("startCredentialWatcher", () => {
	test("reloads once for an external db-directory event", () => {
		vi.useFakeTimers();
		const harness = createHarness();
		let reloads = 0;
		harness.start(async () => {
			reloads += 1;
		});

		harness.watcher?.emit("agent.db");
		vi.advanceTimersByTime(25);

		expect(harness.watchedDirectory).toBe(path.dirname(harness.dbPath));
		expect(reloads).toBe(1);
	});

	test.each(["agent.db", "agent.db-wal", "agent.db-shm"])("reloads for watched credential filename %s", filename => {
		vi.useFakeTimers();
		const harness = createHarness();
		let reloads = 0;
		harness.start(async () => {
			reloads += 1;
		});

		harness.watcher?.emit(filename);
		vi.advanceTimersByTime(25);

		expect(reloads).toBe(1);
	});

	test("reloads when fs.watch omits the changed filename", () => {
		vi.useFakeTimers();
		const harness = createHarness();
		let reloads = 0;
		harness.start(async () => {
			reloads += 1;
		});

		harness.watcher?.emit(null);
		vi.advanceTimersByTime(25);

		expect(reloads).toBe(1);
	});

	test("debounces a WAL burst into one reload", () => {
		vi.useFakeTimers();
		const harness = createHarness();
		let reloads = 0;
		harness.start(async () => {
			reloads += 1;
		});

		harness.watcher?.emit("agent.db");
		harness.watcher?.emit("agent.db-wal");
		harness.watcher?.emit("agent.db-shm");
		vi.advanceTimersByTime(24);
		expect(reloads).toBe(0);
		vi.advanceTimersByTime(1);

		expect(reloads).toBe(1);
	});

	test("stop prevents further reloads", () => {
		vi.useFakeTimers();
		const harness = createHarness();
		let reloads = 0;
		const handle = harness.start(async () => {
			reloads += 1;
		});

		harness.watcher?.emit("agent.db-wal");
		handle.stop();
		vi.advanceTimersByTime(25);
		harness.watcher?.emit("agent.db");
		vi.advanceTimersByTime(25);

		expect(reloads).toBe(0);
		expect(harness.watcher?.closed).toBe(true);
	});

	test("ignores unrelated filenames", () => {
		vi.useFakeTimers();
		const harness = createHarness();
		let reloads = 0;
		harness.start(async () => {
			reloads += 1;
		});

		harness.watcher?.emit("unrelated.db-wal");
		vi.advanceTimersByTime(25);

		expect(reloads).toBe(0);
	});

	test("returns an inert handle when fs.watch setup fails", () => {
		const errors: unknown[] = [];
		const handle = startCredentialWatcher({
			authStorage: { reload: async () => {} } as unknown as AuthStorage,
			dbPath: path.join("/tmp", "omp-credential-watcher", "agent.db"),
			onError: error => errors.push(error),
			watch: () => {
				throw new Error("inotify exhausted");
			},
		});

		expect(errors).toHaveLength(1);
		expect(() => handle.stop()).not.toThrow();
		expect(() => handle.stop()).not.toThrow();
	});
});
