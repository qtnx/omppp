/**
 * node:vm sandbox for deterministic workflow scripts.
 *
 * The script begins with `export const meta = {...}` then a body using injected
 * helper globals. We strip the `export` keyword(s), wrap the body in an async IIFE
 * (enabling top-level `await` and a top-level `return`), and run it in a context
 * whose Date/Math.random are shimmed to throw — Claude's determinism contract that
 * makes journal-based resume sound.
 */
import * as vm from "node:vm";

export type SyntaxResult = { ok: true } | { ok: false; error: string };

export function transformSource(source: string): string {
	const stripped = source.replace(/^\s*export\s+(?=(const|let|var|function|class)\b)/gm, "");
	return `(async () => {\n${stripped}\n})()`;
}

/**
 * Parse-check the script. Bun's `vm.Script` compiles lazily and does NOT throw on
 * syntax errors at construction time, so we use Bun's transpiler to parse instead.
 */
const syntaxTranspiler = new Bun.Transpiler({ loader: "js" });

export function validateSyntax(source: string): SyntaxResult {
	try {
		syntaxTranspiler.transformSync(transformSource(source));
		return { ok: true };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `SyntaxError: ${msg.split("\n")[0]}` };
	}
}

const DETERMINISM_INIT = `
"use strict";
Math.random = () => {
	throw new Error("Math.random() is unavailable in workflow scripts (it breaks deterministic resume). Pass random values via args.");
};
const __OrigDate = Date;
class ShimDate extends __OrigDate {
	constructor(...a) {
		if (a.length === 0) {
			throw new Error("new Date() is unavailable in workflow scripts (it breaks deterministic resume). Pass timestamps via args.");
		}
		super(...a);
	}
	static now() {
		throw new Error("Date.now() is unavailable in workflow scripts (it breaks deterministic resume). Pass timestamps via args.");
	}
}
globalThis.Date = ShimDate;
try { delete globalThis.WebAssembly; } catch (_) {}
try { delete globalThis.ShadowRealm; } catch (_) {}
`;

export function createWorkflowContext(globals: Record<string, unknown>): vm.Context {
	const sandbox: Record<string, unknown> = { ...globals };
	if (!("console" in sandbox)) sandbox.console = console;
	const ctx = vm.createContext(sandbox);
	vm.runInContext(DETERMINISM_INIT, ctx, { filename: "workflow-init.js" });
	return ctx;
}

/** Transform, contextualize, and run. Resolves to the script's top-level return value. */
export async function runWorkflowScript(
	source: string,
	globals: Record<string, unknown>,
	args: unknown,
	options: { filename?: string } = {},
): Promise<unknown> {
	const ctx = createWorkflowContext({ ...globals, args });
	return await vm.runInContext(transformSource(source), ctx, { filename: options.filename ?? "workflow.js" });
}
