/**
 * Hidden argv selectors for internal re-entry into the single CLI entrypoint
 * (`cli.ts` declares itself the worker host; worker threads and worker
 * subprocesses re-enter `Bun.main` with one of these as argv[0]).
 *
 * Keep these strings independent of each worker's protocol module: the CLI must
 * recognize a worker before importing protocol/runtime graphs whose top-level
 * evaluation is unnecessary in an ordinary interactive process.
 *
 * These never start a user session: they must be dispatched before — and
 * excluded from — the macOS self-sandbox relaunch. Otherwise a worker thread
 * re-entering the CLI inside an unsandboxed macOS process (e.g. the
 * `--smoke-test` probe) wraps itself into a detached `sandbox-exec` clone
 * that can never receive the thread's postMessage traffic, and the parent
 * hangs waiting for a pong (v1.2.0 darwin release smoke failure).
 */
/** Blob-broker selector shared by the CLI dispatcher and worker launcher. */
export const BLOB_BROKER_WORKER_ARG = "__omp_worker_blob_broker";
/** Computer-worker selector shared by the CLI dispatcher and worker launcher. */
export const COMPUTER_WORKER_ARG = "__omp_worker_computer";
/** Daemon-broker selector shared by the CLI dispatcher and worker launcher. */
export const DAEMON_BROKER_WORKER_ARG = "__omp_worker_daemon_broker";
/** LSP-multiplexer selector shared by the CLI dispatcher and worker launcher. */
export const LSP_MUX_WORKER_ARG = "__omp_worker_lsp_mux";
/** Activity-worker selector shared by the CLI dispatcher and worker launcher. */
export const STATS_ACTIVITY_WORKER_ARG = "__omp_worker_stats_activity";
/** Terminal-output selector shared by the CLI dispatcher and worker launcher. */
export const TERMINAL_OUTPUT_WORKER_ARG = "__omp_worker_terminal_output";

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
