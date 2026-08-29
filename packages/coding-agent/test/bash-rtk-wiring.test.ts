import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolDetails } from "@oh-my-pi/pi-coding-agent/tools/bash";

// The seam under test lives in BashTool.execute: after internal-URL expansion it
// swaps `command` for `rewriteCommandWithRtk(command)` when `rtk.enabled`. These
// tests drive the real tool with a fake `rtk` on PATH so the assertions are on
// what the shell actually ran, not on the pure helper.
const MARKER = "rtk-wiring-marker";
const ORIGINAL_COMMAND = `printf original-${MARKER}`;
const ORIGINAL_OUTPUT = `original-${MARKER}`;
const REWRITTEN_OUTPUT = "rewritten-by-rtk";
const IGNORED_OUTPUT = "rtk-stdout-should-be-ignored";

// Rewrites only when RTK actually receives the model's command, so a seam that
// forwarded the wrong string would fall through to "no equivalent".
const REWRITING_RTK = `#!/bin/sh
[ "$1" = "rewrite" ] || exit 1
case "$2" in
	*${MARKER}*) printf 'printf %s\\n' '${REWRITTEN_OUTPUT}'; exit 0 ;;
esac
exit 1
`;

// Prints a usable-looking rewrite but exits non-zero: the fail-open contract says
// the original command still runs.
const FAILING_RTK = `#!/bin/sh
printf 'printf %s\\n' '${IGNORED_OUTPUT}'
exit 2
`;

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

afterEach(() => {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * Put a fake `rtk` where the production seam looks for it. `$which` keys its
 * cache on the resolved PATH string, and every call gets a unique directory, so
 * no lookup is served from another test's cache entry.
 */
function installFakeRtk(script: string): void {
	const binDir = makeTempDir("omp-rtk-bin-");
	const rtk = path.join(binDir, "rtk");
	fs.writeFileSync(rtk, script, { mode: 0o755 });
	process.env.PATH = originalPath ? `${binDir}${path.delimiter}${originalPath}` : binDir;
}

function makeBashTool(rtkEnabled: boolean): BashTool {
	const cwd = makeTempDir("omp-rtk-cwd-");
	const session = {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getArtifactsDir: () => path.join(cwd, "session"),
		getClientBridge: () => undefined,
		settings: Settings.isolated({ "rtk.enabled": rtkEnabled }),
	} as unknown as ToolSession;
	return new BashTool(session);
}

function textOf(result: AgentToolResult<BashToolDetails>): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

describe("BashTool RTK rewrite wiring", () => {
	// Catches: the seam being deleted, or moved somewhere the executed command no
	// longer picks it up (helper tests stay green in both cases).
	it("executes the RTK rewrite instead of the model's command when rtk.enabled", async () => {
		installFakeRtk(REWRITING_RTK);

		const result = await makeBashTool(true).execute("rtk-on", { command: ORIGINAL_COMMAND });

		const output = textOf(result);
		expect(output).toContain(REWRITTEN_OUTPUT);
		expect(output).not.toContain(ORIGINAL_OUTPUT);
	});

	// Catches: a rewrite written back onto the tool arguments, which would make the
	// transcript show a command the model never issued.
	it("leaves the recorded tool arguments as the model wrote them", async () => {
		installFakeRtk(REWRITING_RTK);
		const args = { command: ORIGINAL_COMMAND };

		const result = await makeBashTool(true).execute("rtk-args", args);

		expect(textOf(result)).toContain(REWRITTEN_OUTPUT);
		expect(args.command).toBe(ORIGINAL_COMMAND);
	});

	// Catches: an inverted or dropped `rtk.enabled` gate — the fake is reachable,
	// so an ungated seam would rewrite here too.
	it("runs the original command when rtk.enabled is off even with rtk reachable", async () => {
		installFakeRtk(REWRITING_RTK);

		const result = await makeBashTool(false).execute("rtk-off", { command: ORIGINAL_COMMAND });

		const output = textOf(result);
		expect(output).toContain(ORIGINAL_OUTPUT);
		expect(output).not.toContain(REWRITTEN_OUTPUT);
	});

	// Catches: a seam that throws on RTK failure, or that trusts RTK stdout without
	// checking the exit code — either way the model's command must still run.
	it("runs the original command when rtk exits non-zero", async () => {
		installFakeRtk(FAILING_RTK);

		const result = await makeBashTool(true).execute("rtk-fail", { command: ORIGINAL_COMMAND });

		const output = textOf(result);
		expect(output).toContain(ORIGINAL_OUTPUT);
		expect(output).not.toContain(IGNORED_OUTPUT);
	});
});
