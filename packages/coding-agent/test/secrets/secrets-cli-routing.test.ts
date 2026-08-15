/**
 * `ompx secrets …` must be consumed by CLI routing, never forwarded to the
 * model as a launch prompt.
 *
 * This is the #1496 argv-leak class with the worst possible payload: an
 * unregistered subcommand is rewritten to `launch <argv>`, so
 * `ompx secrets add DB_PASS hunter2` would send the secret NAME and VALUE to
 * the provider as a chat message — the exact disclosure the vault exists to
 * prevent.
 */
import { describe, expect, test } from "bun:test";
import { commands, isSubcommand, resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";

/** `resolveCliArgv` returns `{ argv } | { error }`; routing failures must surface as such. */
function routedArgv(argv: string[]): string[] {
	const resolved = resolveCliArgv(argv);
	if (!("argv" in resolved)) throw new Error(`expected routing, got error: ${resolved.error}`);
	return resolved.argv;
}

describe("secrets CLI routing", () => {
	test("secrets is a registered subcommand", () => {
		expect(isSubcommand("secrets")).toBe(true);
		expect(commands.some(command => command.name === "secrets")).toBe(true);
	});

	test("reveal and copy invocations dispatch to the command, not to launch", () => {
		expect(resolveCliArgv(["secrets", "get", "GITHUB_TOKEN", "--reveal"])).toEqual({
			argv: ["secrets", "get", "GITHUB_TOKEN", "--reveal"],
		});
		expect(resolveCliArgv(["secrets", "copy", "GITHUB_TOKEN"])).toEqual({
			argv: ["secrets", "copy", "GITHUB_TOKEN"],
		});
	});

	test("a stored value never becomes a launch prompt", () => {
		const argv = routedArgv(["secrets", "add", "DB_PASS", "hunter2-very-secret"]);

		expect(argv[0]).toBe("secrets");
		expect(argv).not.toContain("launch");
	});

	test("a leading global flag still routes to secrets", () => {
		// The resolver hoists the subcommand and re-appends the leading flags; only
		// the dispatch target is contractual here, not the flag/arg ordering.
		const argv = routedArgv(["--profile", "work", "secrets", "list"]);

		expect(argv[0]).toBe("secrets");
		expect(argv).toContain("list");
		expect(argv).not.toContain("launch");
	});
});
