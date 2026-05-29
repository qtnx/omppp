/**
 * Discover workflows: bundled (embedded) + project (.omp/workflows/*.js) +
 * user (~/.omp/agent/workflows/*.js). Project shadows user shadows bundled, by name.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import bugfixScript from "./bundled/bugfix.js.txt" with { type: "text" };
import investigateScript from "./bundled/investigate.js.txt" with { type: "text" };
import { extractMeta } from "./meta";
import { readWorkflowScript } from "./storage";
import type { WorkflowMeta, WorkflowSource } from "./types";

export interface DiscoveredWorkflow {
	name: string;
	description: string;
	whenToUse?: string;
	source: WorkflowSource;
	/** Absolute path for disk workflows; undefined for bundled. */
	filePath?: string;
	/** Inline source for bundled workflows. */
	bundledSource?: string;
}

const BUNDLED: Array<{ source: string }> = [{ source: bugfixScript }, { source: investigateScript }];

function toMeta(source: string): WorkflowMeta | undefined {
	return extractMeta(source).meta;
}

async function loadDir(dir: string, source: WorkflowSource): Promise<DiscoveredWorkflow[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const out: DiscoveredWorkflow[] = [];
	for (const entry of entries) {
		if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith(".js")) continue;
		const filePath = path.join(dir, entry.name);
		const { script } = await readWorkflowScript(filePath);
		const meta = script ? toMeta(script) : undefined;
		if (!meta) continue;
		out.push({ name: meta.name, description: meta.description, whenToUse: meta.whenToUse, source, filePath });
	}
	return out;
}

export async function discoverWorkflows(cwd: string, home: string = os.homedir()): Promise<DiscoveredWorkflow[]> {
	const byName = new Map<string, DiscoveredWorkflow>();
	for (const { source } of BUNDLED) {
		const meta = toMeta(source);
		if (meta) {
			byName.set(meta.name, {
				name: meta.name,
				description: meta.description,
				whenToUse: meta.whenToUse,
				source: "bundled",
				bundledSource: source,
			});
		}
	}
	for (const w of await loadDir(path.join(home, ".omp", "agent", "workflows"), "user")) byName.set(w.name, w);
	for (const w of await loadDir(path.join(cwd, ".omp", "workflows"), "project")) byName.set(w.name, w);
	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export interface WorkflowSourceResult {
	source?: string;
	error?: string;
}

/** Resolve a workflow name to its script source (project > user > bundled). */
export async function getWorkflowSource(
	cwd: string,
	name: string,
	home: string = os.homedir(),
): Promise<WorkflowSourceResult> {
	const found = (await discoverWorkflows(cwd, home)).find(w => w.name === name);
	if (!found) return { error: `Unknown workflow: "${name}".` };
	if (found.bundledSource) return { source: found.bundledSource };
	if (found.filePath) return readWorkflowScript(found.filePath);
	return { error: `Workflow "${name}" has no readable source.` };
}
