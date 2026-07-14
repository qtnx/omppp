/**
 * Hidden argv selectors for internal re-entry into the single CLI entrypoint
 * (`cli.ts` declares itself the worker host; worker threads and worker
 * subprocesses re-enter `Bun.main` with one of these as argv[0]).
 *
 * These never start a user session: they must be dispatched before — and
 * excluded from — the macOS self-sandbox relaunch. Otherwise a worker thread
 * re-entering the CLI inside an unsandboxed macOS process (e.g. the
 * `--smoke-test` probe) wraps itself into a detached `sandbox-exec` clone
 * that can never receive the thread's postMessage traffic, and the parent
 * hangs waiting for a pong (v1.2.0 darwin release smoke failure).
 */
export const TINY_WORKER_ARG = "__omp_worker_tiny_inference";
export const TINY_WORKER_ARGS: Record<string, true> = {
	[TINY_WORKER_ARG]: true,
	"--tiny-worker": true,
	__tiny_worker: true,
};
export const STATS_SYNC_WORKER_ARG = "__omp_worker_stats_sync";
export const TAB_WORKER_ARG = "__omp_worker_tab";
export const JS_EVAL_WORKER_ARG = "__omp_worker_js_eval";

/** Every internal worker re-entry selector (thread and subprocess forms). */
export const INTERNAL_WORKER_ENTRY_ARGS: Record<string, true> = {
	...TINY_WORKER_ARGS,
	[STATS_SYNC_WORKER_ARG]: true,
	[TAB_WORKER_ARG]: true,
	[JS_EVAL_WORKER_ARG]: true,
};
