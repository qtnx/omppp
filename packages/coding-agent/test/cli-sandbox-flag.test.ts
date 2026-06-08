import { describe, expect, it } from "bun:test";
import { extractRootNoSandboxFlag, parseArgs } from "../src/cli/args";

describe("--no-sandbox", () => {
	it("parses as a boolean CLI flag without consuming the prompt", () => {
		const parsed = parseArgs(["--no-sandbox", "run", "tests"]);

		expect(parsed.noSandbox).toBe(true);
		expect(parsed.messages).toEqual(["run", "tests"]);
	});

	it("parses equals-form boolean opt-out", () => {
		const parsed = parseArgs(["--no-sandbox=true", "run"]);

		expect(parsed.noSandbox).toBe(true);
		expect(parsed.messages).toEqual(["run"]);
	});

	it("extracts a root no-sandbox flag before subcommands", () => {
		expect(extractRootNoSandboxFlag(["--no-sandbox", "read", "file.txt"])).toEqual({
			argv: ["read", "file.txt"],
			noSandbox: true,
		});
		expect(extractRootNoSandboxFlag(["--no-sandbox=true", "read", "file.txt"])).toEqual({
			argv: ["read", "file.txt"],
			noSandbox: true,
		});
	});

	it("does not extract no-sandbox when it is not the root flag", () => {
		expect(extractRootNoSandboxFlag(["--append-system-prompt", "--no-sandbox", "prompt"])).toEqual({
			argv: ["--append-system-prompt", "--no-sandbox", "prompt"],
			noSandbox: false,
		});
	});

	it("does not let a value passed to another flag become the sandbox opt-out", () => {
		const parsed = parseArgs(["--append-system-prompt", "--no-sandbox", "prompt"]);

		expect(parsed.noSandbox).toBeUndefined();
		expect(parsed.appendSystemPrompt).toBe("--no-sandbox");
		expect(parsed.messages).toEqual(["prompt"]);
	});
});
