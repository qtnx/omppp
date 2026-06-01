/**
 * Build the helper globals injected into a workflow script's VM context, bound to
 * a WorkflowRun. parallel() is a barrier; pipeline() runs each item through stages
 * with no barrier; both feed run.spawn() and inherit its concurrency/agent caps.
 */
import type { WorkflowRun } from "./engine";
import type { WorkflowAgentOpts } from "./types";

export interface WorkflowGlobalDeps {
	/** Run a sub-workflow inline. Default throws (nesting wired by the tool). */
	runWorkflow?: (nameOrRef: string | { scriptPath: string }, args: unknown) => Promise<unknown>;
}

export interface WorkflowGlobals {
	agent: (prompt: string, opts?: WorkflowAgentOpts) => Promise<unknown | null>;
	parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<(T | null)[]>;
	pipeline: (
		items: unknown[],
		...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>
	) => Promise<unknown[]>;
	phase: (title: string) => void;
	log: (message: string) => void;
	budget: WorkflowRun["budget"];
	workflow: (nameOrRef: string | { scriptPath: string }, args?: unknown) => Promise<unknown>;
	args: unknown;
}

export function createWorkflowGlobals(run: WorkflowRun, args: unknown, deps: WorkflowGlobalDeps = {}): WorkflowGlobals {
	const agent = (prompt: string, opts: WorkflowAgentOpts = {}) => run.spawn(prompt, opts);

	const parallel = async <T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> => {
		if (!Array.isArray(thunks)) {
			throw new TypeError(
				"parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)",
			);
		}
		const settled = await Promise.allSettled(thunks.map(t => t()));
		return settled.map(r => (r.status === "fulfilled" ? r.value : null));
	};

	const pipeline = async (
		items: unknown[],
		...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>
	): Promise<unknown[]> => {
		if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument.");
		// Each item flows through all stages independently — NO barrier between stages.
		const runItem = async (item: unknown, index: number): Promise<unknown> => {
			let acc: unknown = item;
			for (let s = 0; s < stages.length; s++) {
				try {
					acc = await stages[s](acc, item, index);
				} catch {
					return null; // drop this item; skip its remaining stages
				}
			}
			return acc;
		};
		return Promise.all(items.map(runItem));
	};

	const workflow = async (nameOrRef: string | { scriptPath: string }, subArgs?: unknown): Promise<unknown> => {
		if (!deps.runWorkflow) throw new Error("workflow() nesting is not available in this build.");
		return deps.runWorkflow(nameOrRef, subArgs);
	};

	return {
		agent,
		parallel,
		pipeline,
		phase: (title: string) => run.nextPhase(title),
		log: (message: string) => run.log(message),
		budget: run.budget,
		workflow,
		args,
	};
}
