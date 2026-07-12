import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const REPO_KEY_BY_CWD = new Map<string, string>();

export async function resolveRepoKey(cwd: string): Promise<string> {
	const cached = REPO_KEY_BY_CWD.get(cwd);
	if (cached !== undefined) return cached;

	const repoKey = await resolveUncachedRepoKey(cwd);
	REPO_KEY_BY_CWD.set(cwd, repoKey);
	return repoKey;
}

async function resolveUncachedRepoKey(cwd: string): Promise<string> {
	const timeout = AbortSignal.timeout(2_000);
	try {
		const result = await awaitWithAbort($`git rev-parse --git-common-dir`.cwd(cwd).quiet().nothrow(), timeout);
		if (result.exitCode !== 0) return cwd;
		const commonDir = result.text().trim();
		if (!commonDir) return cwd;
		return await fs.realpath(path.dirname(path.resolve(cwd, commonDir)));
	} catch {
		return cwd;
	}
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw signal.reason;
	const timedOut = Promise.withResolvers<T>();
	const abort = () => timedOut.reject(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([promise, timedOut.promise]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
