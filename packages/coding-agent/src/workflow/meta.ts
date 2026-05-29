/**
 * Parse and validate the `export const meta = {...}` header of a workflow script.
 *
 * `meta` MUST be a pure object literal (no variables, calls, spreads, template
 * interpolation) so it can be statically extracted without running the body.
 */
import * as vm from "node:vm";
import type { WorkflowMeta } from "./types";

export interface ExtractMetaResult {
	meta?: WorkflowMeta;
	metaError?: string;
}

/** Find the balanced `{...}` literal starting at `start`. Returns end index (inclusive) or -1. */
function matchBalancedBraces(source: string, start: number): number {
	let depth = 0;
	let inStr: string | null = null;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (inStr) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === inStr) inStr = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inStr = ch;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return i;
	}
	return -1;
}

export function extractMeta(source: string): ExtractMetaResult {
	const decl = source.match(/export\s+const\s+meta\s*=\s*/);
	if (!decl || decl.index === undefined) {
		return {
			metaError: "Workflow script must begin with `export const meta = { name, description }` (a pure literal).",
		};
	}
	const braceStart = source.indexOf("{", decl.index + decl[0].length);
	if (braceStart === -1) return { metaError: "`meta` must be an object literal." };
	const braceEnd = matchBalancedBraces(source, braceStart);
	if (braceEnd === -1) return { metaError: "Unterminated `meta` object literal." };

	const literal = source.slice(braceStart, braceEnd + 1);
	try {
		// Evaluate ONLY the literal in a clean context. A pure literal cannot reference
		// identifiers; any variable/call throws → reported as a non-pure-literal error.
		const value = vm.runInContext(`(${literal})`, vm.createContext(Object.create(null)), {
			filename: "workflow-meta.js",
			timeout: 50,
		});
		if (!value || typeof value !== "object") return { metaError: "`meta` must be an object literal." };
		return { meta: value as WorkflowMeta };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { metaError: `\`meta\` must be a PURE LITERAL (no variables, calls, spreads, or interpolation): ${msg}` };
	}
}

export function validateMeta(meta: WorkflowMeta): string | null {
	if (typeof meta.name !== "string" || !meta.name.trim()) {
		return "`meta.name` is required and must be a non-empty string.";
	}
	if (typeof meta.description !== "string" || !meta.description.trim()) {
		return "`meta.description` is required and must be a non-empty string.";
	}
	if (meta.phases !== undefined && !Array.isArray(meta.phases)) {
		return "`meta.phases` must be an array when present.";
	}
	return null;
}
