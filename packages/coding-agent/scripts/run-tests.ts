#!/usr/bin/env bun

const SERIAL_TEST_FILES = [
	"test/sdk-credential-disabled-bridge.test.ts",
	"src/eval/__tests__/shared-executors.test.ts",
	"test/agent-session-concurrent.test.ts",
	"test/task/worktree.test.ts",
	"test/core/python-executor-per-call.test.ts",
	"test/sdk-session-isolation.test.ts",
	"test/sdk-model-selection.test.ts",
	"test/sdk-tool-activation.test.ts",
	"test/agent-session-openai-responses-replay.test.ts",
	"test/agent-session-user-shortcut-hooks.test.ts",
	"test/cli/completions.test.ts",
	"test/task/review-gate.test.ts",
	"test/tools/schema-validation.test.ts",
	"test/tools/search-path-lists.test.ts",
] as const;

const ROOT_PATH_IGNORE_PATTERNS = ["**/node_modules/**", "python/robomp/data/**", ".wt/**", ".worktrees/**"] as const;

async function runTest(args: readonly string[]): Promise<number> {
	const child = Bun.spawn(["bun", "test", ...args], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return await child.exited;
}

for (const file of SERIAL_TEST_FILES) {
	const exitCode = await runTest(["--timeout=60000", `./${file}`]);
	if (exitCode !== 0) process.exit(exitCode);
}

const ignoreArgs = [...ROOT_PATH_IGNORE_PATTERNS, ...SERIAL_TEST_FILES].map(
	pattern => `--path-ignore-patterns=${pattern}`,
);
const parallelExit = await runTest(["--parallel=8", "--timeout=60000", ...ignoreArgs]);
process.exit(parallelExit);
