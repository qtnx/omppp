import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";

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

	it("does not let a value passed to another flag become the sandbox opt-out", () => {
		const parsed = parseArgs(["--append-system-prompt", "--no-sandbox", "prompt"]);

		expect(parsed.noSandbox).toBeUndefined();
		expect(parsed.appendSystemPrompt).toBe("--no-sandbox");
		expect(parsed.messages).toEqual(["prompt"]);
	});
});
