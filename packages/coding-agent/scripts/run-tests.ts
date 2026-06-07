#!/usr/bin/env bun

const serialTestPaths = [
	"test/sdk-credential-disabled-bridge.test.ts",
	"src/eval/__tests__/shared-executors.test.ts",
	"test/agent-session-concurrent.test.ts",
];

async function runBunTest(args: readonly string[]): Promise<number> {
	const child = Bun.spawn(["bun", "test", ...args], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return child.exited;
}

const forwardedArgs = Bun.argv.slice(2);
const hasExplicitTestTarget = forwardedArgs.some(arg => !arg.startsWith("-"));
if (hasExplicitTestTarget) {
	process.exit(await runBunTest(["--timeout=60000", ...forwardedArgs]));
}

const ignoredSerialTests = serialTestPaths.map(path => `--path-ignore-patterns=${path}`);
const parallelExitCode = await runBunTest(["--parallel", "--timeout=60000", ...forwardedArgs, ...ignoredSerialTests]);
if (parallelExitCode !== 0) {
	process.exit(parallelExitCode);
}

process.exit(await runBunTest(["--timeout=60000", ...forwardedArgs, ...serialTestPaths]));
