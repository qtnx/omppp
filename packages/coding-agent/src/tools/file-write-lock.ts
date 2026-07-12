/**
 * Process-local file-mutation locks. Normal callers acquire one canonical file
 * key; atomic patch renames are the sole two-key exception and acquire source
 * and destination in lexical key order to avoid deadlock.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { canonicalSnapshotKey } from "../edit/file-snapshot-store";
import { Semaphore } from "../task/parallel";

interface FileWriteLockEntry {
	semaphore: Semaphore;
	participants: number;
}

const fileWriteLocks = new Map<string, FileWriteLockEntry>();

/**
 * Return the process-wide lock key for a file mutation.
 *
 * This uses the snapshot store's realpath-aware canonicalization so `edit` and
 * `write` contend when different path spellings resolve to the same file.
 */
export function fileWriteLockKey(absolutePath: string): string {
	return canonicalSnapshotKey(absolutePath);
}

/**
 * Serialize one file's read/validate → apply → write critical section in this
 * process only. It intentionally does not coordinate separate OMPx processes:
 * callers in another process require their own cross-process safety mechanism.
 *
 * Queued callers respect `signal`; after `fn` starts it runs to completion so a
 * cancellation cannot release the file while its mutation is still in flight.
 */
export function withFileWriteLock<T>(
	absolutePath: string,
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	return withFileWriteLockKey(fileWriteLockKey(absolutePath), signal, fn);
}

/**
 * Serialize an atomic multi-file mutation in this process only.
 *
 * This is the sole exception to the one-file-lock rule: patch rename operations
 * mutate a source and destination together. Keys are canonicalized, deduplicated,
 * and acquired in lexical order so simultaneous inverse renames cannot deadlock.
 */
export function withFileWriteLocks<T>(
	absolutePaths: readonly string[],
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	const keys = Array.from(new Set(absolutePaths.map(fileWriteLockKey))).sort();
	const acquireNext = (index: number): Promise<T> => {
		if (index === keys.length) return fn();
		return withFileWriteLockKey(keys[index]!, signal, () => acquireNext(index + 1));
	};
	return acquireNext(0);
}

async function withFileWriteLockKey<T>(key: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
	let entry = fileWriteLocks.get(key);
	if (!entry) {
		entry = { semaphore: new Semaphore(1), participants: 0 };
		fileWriteLocks.set(key, entry);
	}

	const queueDepth = entry.participants;
	entry.participants++;
	if (queueDepth > 0) {
		logger.debug("file write lock: waiting for same-file mutation", { key, queueDepth });
	}

	let acquired = false;
	try {
		await entry.semaphore.acquire(signal);
		acquired = true;
		return await fn();
	} finally {
		if (acquired) entry.semaphore.release();
		entry.participants--;
		if (entry.participants === 0 && fileWriteLocks.get(key) === entry) {
			fileWriteLocks.delete(key);
		}
	}
}
