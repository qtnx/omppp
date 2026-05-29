/**
 * Filesystem layout:
 *   <artifactsDir>/workflows/scripts/<slug>-<runId>.js  persisted script
 *   <artifactsDir>/workflows/<runId>/                   subagent transcripts + journal
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { MAX_WORKFLOW_SCRIPT_BYTES } from "./types";

export function slugify(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "workflow";
}

export function workflowDir(artifactsDir: string): string {
	return path.join(artifactsDir, "workflows");
}

export function subagentTranscriptDir(artifactsDir: string, runId: string): string {
	return path.join(workflowDir(artifactsDir), runId);
}

export async function persistWorkflowScript(
	artifactsDir: string,
	name: string,
	runId: string,
	source: string,
): Promise<string> {
	const dir = path.join(workflowDir(artifactsDir), "scripts");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${slugify(name)}-${runId}.js`);
	await Bun.write(file, source);
	return file;
}

export interface ReadScriptResult {
	script?: string;
	error?: string;
}

export async function readWorkflowScript(scriptPath: string): Promise<ReadScriptResult> {
	try {
		const file = Bun.file(scriptPath);
		if (file.size > MAX_WORKFLOW_SCRIPT_BYTES) {
			return { error: `Workflow script file ${scriptPath} exceeds ${MAX_WORKFLOW_SCRIPT_BYTES} bytes.` };
		}
		return { script: await file.text() };
	} catch (error) {
		if (isEnoent(error)) return { error: `Workflow script file not found: ${scriptPath}` };
		return { error: `Failed to read workflow script file ${scriptPath}: ${error}` };
	}
}
