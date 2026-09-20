/**
 * Eval tasks for `jev_scout` against this repository.
 *
 * Each task is one "I know the behavior, not the location" question plus the
 * scope a caller would realistically pass. A task passes on the OBSERVABLE
 * contract of the tool: the excerpt it returns must come from the expected file
 * and contain the expected declaration — not merely mention the topic.
 *
 * `expect: null` marks an absence task: the behavior does not exist in the
 * given scope, and the only correct answer is `no_match`. These are the tasks
 * that catch a model that always picks something.
 */

export interface EvalTask {
	id: string;
	title: string;
	/** Question handed to the tool; phrased as behavior, never as a symbol name. */
	query: string;
	/** Search scope, repo-relative — a file for pinpoint tasks, a directory for navigation tasks. */
	path: string;
	maxFiles?: number;
	/** Expected hit, or null when the correct answer is `no_match`. */
	expect: { file: string; contains: string; startLine?: number } | null;
	/** What this task stresses. */
	notes: string;
	/** Optional same-behavior comparison metadata for eval reports. */
	comparison?: { group: string; variant: "original" | "atomic" };
}

export const TASKS: EvalTask[] = [
	{
		id: "workspace-tree-file",
		title: "Locate the workspace tree builder inside one file",
		query: "Which function builds the working-directory tree shown in the system prompt?",
		path: "packages/coding-agent/src/workspace-tree.ts",
		maxFiles: 1,
		expect: { file: "packages/coding-agent/src/workspace-tree.ts", contains: "function buildWorkspaceTree" },
		notes: "Baseline: scope is one file, so only outline ranking is under test.",
	},
	{
		id: "workspace-tree-dir",
		title: "Find the workspace tree builder by navigating a large directory",
		query: "Which function builds the working-directory tree shown in the system prompt?",
		path: "packages/coding-agent/src",
		expect: { file: "packages/coding-agent/src/workspace-tree.ts", contains: "function buildWorkspaceTree" },
		notes: "Navigation under breadth: the root listing has many plausible directories.",
	},
	{
		id: "systemone-post",
		title: "Find the retrying HTTP client for System One",
		query: "Where is the System One request sent and retried after a 429 or 503 response?",
		path: "packages/coding-agent/src/jev",
		expect: { file: "packages/coding-agent/src/jev/systemone.ts", contains: "function postSystemOne" },
		notes: "Behavior described by its failure handling, not by its name.",
	},
	{
		id: "secret-masking",
		title: "Find where a stored secret is shortened for display",
		query: "Where is a stored secret value shortened so only its first and last characters are shown?",
		path: "packages/coding-agent/src/secrets",
		expect: { file: "packages/coding-agent/src/secrets/vault.ts", contains: "function maskSecretValue" },
		notes: "Small declaration inside a large module; competing secret-handling files in scope.",
	},
	{
		id: "vault-open",
		title: "Find where the encrypted vault file is decrypted on open",
		query: "Where is the encrypted secrets file decrypted when the vault is opened?",
		path: "packages/coding-agent/src/secrets/vault.ts",
		maxFiles: 1,
		expect: { file: "packages/coding-agent/src/secrets/vault.ts", contains: "decryptVault" },
		notes: "Ranking inside one long file where many ranges mention secrets.",
	},
	{
		id: "tool-timeout-clamp",
		title: "Find where a requested tool timeout is capped",
		query: "Where is a tool's requested timeout clamped to the configured maximum?",
		path: "packages/coding-agent/src/tools",
		expect: { file: "packages/coding-agent/src/tools/tool-timeouts.ts", contains: "clampTimeout" },
		notes: "Directory with hundreds of files; the target is a small utility module.",
	},
	{
		id: "absent-in-file",
		title: "Reject a behavior that is not in the given file",
		query: "Which function computes interplanetary spacecraft orbital trajectories?",
		path: "packages/coding-agent/src/workspace-tree.ts",
		maxFiles: 1,
		expect: null,
		notes: "Absence inside a single file: the outline offers ranges, all of them wrong.",
	},
	{
		id: "absent-in-dir",
		title: "Reject a behavior that is not in the given directory",
		query: "Where does this package charge a customer's credit card?",
		path: "packages/coding-agent/src/jev",
		expect: null,
		notes: "Absence under navigation: every listed path is plausible-looking source.",
	},
];

export function tasksFor(ids: string[], available: EvalTask[] = TASKS): EvalTask[] {
	if (ids.length === 0) return available;
	return ids.map(id => {
		const task = available.find(candidate => candidate.id === id);
		if (!task) throw new Error(`Unknown task: ${id} (have ${available.map(t => t.id).join(", ")})`);
		return task;
	});
}
