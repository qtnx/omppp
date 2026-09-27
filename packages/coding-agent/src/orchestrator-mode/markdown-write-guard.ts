import type { ToolSession } from "../tools";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { ToolError } from "../tools/tool-errors";

export type OrchestratorModeMarkdownWriteOptions = {
	move?: string;
	op?: "create" | "update" | "delete";
};

const MARKDOWN_FILE_EXTENSION_RE = /\.md$/i;
const AGENT_COORDINATION_TARGET_RE = /^agent:\/\/.+$/i;
const PROC_JOB_KILL_TARGET_RE = /^proc:\/\/[^/]+\/kill$/i;

function assertMarkdownTarget(session: ToolSession, targetPath: string): void {
	if (
		AGENT_COORDINATION_TARGET_RE.test(targetPath) ||
		PROC_JOB_KILL_TARGET_RE.test(targetPath) ||
		MARKDOWN_FILE_EXTENSION_RE.test(targetPath)
	)
		return;

	const displayPath = formatPathRelativeToCwd(targetPath, session.cwd);
	throw new ToolError(
		`In orchestrator mode, only Markdown (.md) files, agent:// messages, and proc://<job>/kill may be written directly — "${displayPath}" is not an allowed target. Delegate non-Markdown changes to a subagent.`,
	);
}

/**
 * Safe orchestrator mode exposes write/edit for Markdown planning notes only.
 * This guard lives at the enforcePlanModeWrite seam because every file mutation
 * already routes through that single gate before committing filesystem changes.
 */
export function enforceOrchestratorModeMarkdownWrite(
	session: ToolSession,
	targetPath: string,
	opts?: OrchestratorModeMarkdownWriteOptions,
): void {
	const state = session.getOrchestratorModeState?.();
	if (!state?.enabled) return;

	const affectedPaths = opts?.move ? [opts.move, targetPath] : [targetPath];
	for (const affectedPath of affectedPaths) {
		assertMarkdownTarget(session, affectedPath);
	}
}
