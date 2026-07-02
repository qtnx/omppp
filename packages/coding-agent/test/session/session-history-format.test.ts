/**
 * Contracts: history:// transcript serializer (rework-contracts.md §5).
 *
 * - `## user` / `## assistant` headers carry full text.
 * - Thinking blocks are elided entirely.
 * - Each toolCall collapses with its toolResult into ONE `→ name(…) ⇒ …`
 *   line (ok and error variants); result bodies are never dumped.
 * - Custom messages render as one-liners (`[irc] from → me: …`).
 * - No system prompt / tool catalog sections.
 */
import { describe, expect, it } from "bun:test";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

function buildMessages(): unknown[] {
	return [
		{ role: "user", content: "Please read the config.", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "SECRET-THOUGHT about the approach" },
				{ type: "text", text: "Reading it now." },
				{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "src/config.ts" } },
				{ type: "toolCall", id: "tc-2", name: "bash", arguments: { command: "bun test" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "const a = 1;\nconst b = 2;\nconst c = 3;" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "tc-2",
			toolName: "bash",
			content: [{ type: "text", text: "FAIL: 1 test failed" }],
			isError: true,
			timestamp: 4,
		},
		{
			role: "custom",
			customType: "irc:incoming",
			content: "full rendered irc prompt that must not appear",
			details: { from: "Main", message: "status update please" },
			timestamp: 5,
		},
	];
}

describe("formatSessionHistoryMarkdown", () => {
	it("renders role headers, collapses tool pairs to one line, and elides thinking", () => {
		const output = formatSessionHistoryMarkdown(buildMessages());

		expect(output).toContain("## user");
		expect(output).toContain("Please read the config.");
		expect(output).toContain("## assistant");
		expect(output).toContain("Reading it now.");

		// Thinking is elided entirely.
		expect(output).not.toContain("SECRET-THOUGHT");

		// Tool call + result collapse to one line each; bodies are not dumped.
		expect(output).toContain("→ read(src/config.ts) ⇒ ok · 3 lines");
		expect(output).not.toContain("const a = 1;");

		// Error variant carries the first line of the error output.
		expect(output).toContain("→ bash(bun test) ⇒ error · 1 line — FAIL: 1 test failed");

		// Consumed toolResults do not render a second orphan line.
		const toolLines = output.split("\n").filter(line => line.startsWith("→ "));
		expect(toolLines).toHaveLength(2);

		// Custom messages are one-liners; the rendered prompt body is dropped.
		expect(output).toContain("[irc] Main → me: status update please");
		expect(output).not.toContain("full rendered irc prompt");

		// Concise transcript: no prompt/tool-catalog sections.
		expect(output).not.toContain("System Prompt");
		expect(output).not.toContain("Available Tools");
	});

	it("prefixes an H1 title when requested", () => {
		const output = formatSessionHistoryMarkdown(buildMessages(), { title: "Spawnling (idle)" });
		expect(output.startsWith("# Spawnling (idle)\n")).toBe(true);
	});

	it("renders watched roles using bold text rather than level-2 headers when watchedRoles is true", () => {
		const output = formatSessionHistoryMarkdown(buildMessages(), { watchedRoles: true });
		expect(output).toContain("**user**:");
		expect(output).toContain("**agent**:");
		expect(output).not.toContain("## user");
		expect(output).not.toContain("## assistant");
	});

	it("renders an orphan toolResult (truncated history) as its own line", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "toolResult",
				toolCallId: "tc-orphan",
				toolName: "grep",
				content: [{ type: "text", text: "one match" }],
				isError: false,
				timestamp: 1,
			},
		]);
		expect(output).toContain("→ grep() ⇒ ok · 1 line");
	});

	it("renders find paths without falling back to JSON arguments", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-glob",
						name: "glob",
						arguments: { paths: ["packages/coding-agent/src/**/*.ts"] },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-glob",
				toolName: "glob",
				content: [{ type: "text", text: "session-history-format.ts" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(output).toContain("→ glob(packages/coding-agent/src/**/*.ts) ⇒ ok · 1 line");
		expect(output).not.toContain('{"paths"');
	});

	it("renders search path scope alongside the pattern", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-grep",
						name: "grep",
						arguments: { pattern: "PRIMARY_ARG_KEYS", paths: ["packages/coding-agent/src/session"] },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-grep",
				toolName: "grep",
				content: [{ type: "text", text: "timed out" }],
				isError: true,
				timestamp: 2,
			},
		]);

		expect(output).toContain(
			"→ grep(PRIMARY_ARG_KEYS @ packages/coding-agent/src/session) ⇒ error · 1 line — timed out",
		);
	});

	it("keeps the ast_grep pattern visible instead of only its paths scope", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-astgrep",
						name: "ast_grep",
						arguments: { pat: "console.log($$$)", paths: ["packages/coding-agent/src/**/*.ts"] },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-astgrep",
				toolName: "ast_grep",
				content: [{ type: "text", text: "match" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(output).toContain("→ ast_grep(console.log($$$)) ⇒ ok · 1 line");
	});

	it("keeps the ast_edit op pattern visible instead of only its paths scope", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-astedit",
						name: "ast_edit",
						arguments: {
							ops: [{ pat: "oldApi($$$A)", out: "newApi($$$A)" }],
							paths: ["packages/coding-agent/src/**/*.ts"],
						},
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-astedit",
				toolName: "ast_edit",
				content: [{ type: "text", text: "1 change" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(output).toContain("oldApi($$$A)");
		expect(output).not.toContain("→ ast_edit(packages/coding-agent/src/**/*.ts)");
	});

	it("renders tool intent comments immediately before tool call lines when includeToolIntent is true", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-intent",
						name: "read",
						arguments: { path: "src/config.ts", [INTENT_FIELD]: "reading config file" },
					},
					{
						type: "toolCall",
						id: "tc-long-intent",
						name: "read",
						arguments: {
							path: "src/config.ts",
							[INTENT_FIELD]:
								"reading config file with a very very long and descriptive intent that will exceed the maximum length limit of eighty characters",
						},
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "tc-intent",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
			{
				role: "toolResult",
				toolCallId: "tc-long-intent",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
		];

		const outputWithIntent = formatSessionHistoryMarkdown(messages, { includeToolIntent: true });
		expect(outputWithIntent).toContain("// reading config file\n→ read(src/config.ts) ⇒ ok · 1 line");
		// The long intent should be flattened to one line and truncated to 80 characters (including ellipsis).
		expect(outputWithIntent).toContain(
			"// reading config file with a very very long and descriptive intent that will exce…\n→ read(src/config.ts) ⇒ ok · 1 line",
		);

		const outputWithoutIntent = formatSessionHistoryMarkdown(messages);
		expect(outputWithoutIntent).not.toContain("// reading config file");
		expect(outputWithoutIntent).toContain("→ read(src/config.ts) ⇒ ok · 1 line");
	});
	it("summarizes advise tool calls by their note and severity", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-advise-1",
						name: "advise",
						// Severity is intentionally placed before note so the test proves
						// PRIMARY_ARG_KEYS / the special-case picks the note, not insertion order.
						arguments: { severity: "concern", note: "Avoid shadowing the outer variable." },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-advise-1",
				toolName: "advise",
				content: [{ type: "text", text: "Recorded." }],
				isError: false,
				timestamp: 2,
			},
		];

		const output = formatSessionHistoryMarkdown(messages);
		expect(output).toContain("→ advise(concern: Avoid shadowing the outer variable.) ⇒ ok · 1 line");
		expect(output).not.toContain("Recorded.");
	});
});

describe("formatSessionHistoryMarkdown advisor feed options", () => {
	function thinkingMessages(): unknown[] {
		return [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "raw private reasoning" },
					{ type: "text", text: "answer" },
				],
				timestamp: 1,
			},
		];
	}

	it("passes thinking text through renderThinking when includeThinking is set", () => {
		const output = formatSessionHistoryMarkdown(thinkingMessages(), {
			includeThinking: true,
			renderThinking: text => `[[${text.toUpperCase()}]]`,
		});
		expect(output).toContain("_thinking:_ [[RAW PRIVATE REASONING]]");
		expect(output).not.toContain("_thinking:_ raw private reasoning");
	});

	it("renders thinking verbatim when renderThinking is absent", () => {
		const output = formatSessionHistoryMarkdown(thinkingMessages(), { includeThinking: true });
		expect(output).toContain("_thinking:_ raw private reasoning");
	});

	it("does not render thinking at all by default (renderThinking is inert without includeThinking)", () => {
		const output = formatSessionHistoryMarkdown(thinkingMessages(), {
			renderThinking: () => "SHOULD-NOT-APPEAR",
		});
		expect(output).not.toContain("_thinking:_");
		expect(output).not.toContain("SHOULD-NOT-APPEAR");
	});

	function errorMessages(): unknown[] {
		return [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-err", name: "bash", arguments: { command: "bun test" } }],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc-err",
				toolName: "bash",
				content: [{ type: "text", text: "L1\nL2\nL3\nL4\nL5\nL6" }],
				isError: true,
				timestamp: 2,
			},
		];
	}

	it("appends no error excerpt by default", () => {
		const output = formatSessionHistoryMarkdown(errorMessages());
		expect(output).toContain("→ bash(bun test) ⇒ error · 6 lines — L1");
		expect(output).not.toContain("    L2");
	});

	it("shows all error lines indented when the count is within errorResultLines", () => {
		const output = formatSessionHistoryMarkdown(errorMessages(), { errorResultLines: 10 });
		expect(output).toContain("→ bash(bun test) ⇒ error · 6 lines — L1");
		for (const line of ["    L1", "    L2", "    L3", "    L4", "    L5", "    L6"]) {
			expect(output).toContain(line);
		}
		expect(output).not.toContain("lines) …");
	});

	it("elides the middle of the error excerpt when it exceeds errorResultLines", () => {
		const output = formatSessionHistoryMarkdown(errorMessages(), { errorResultLines: 4 });
		// ceil(4/2)=2 head, floor(4/2)=2 tail, 2 elided.
		expect(output).toContain("    L1");
		expect(output).toContain("    L2");
		expect(output).toContain("    … (+2 lines) …");
		expect(output).toContain("    L5");
		expect(output).toContain("    L6");
		expect(output).not.toContain("    L3");
	});

	function asyncResultMessage(content: string): unknown[] {
		return [
			{
				role: "custom",
				customType: "async-result",
				content,
				details: { jobs: [{ label: "qa-review" }] },
				timestamp: 1,
			},
		];
	}

	it("shows only the async-result label by default", () => {
		const output = formatSessionHistoryMarkdown(asyncResultMessage("verdict: PASS\nno regressions"));
		expect(output).toContain("[async-result] qa-review");
		expect(output).not.toContain("verdict: PASS");
	});

	it("appends the async-result content excerpt when expandAsyncResults is set", () => {
		const output = formatSessionHistoryMarkdown(asyncResultMessage("verdict: PASS\nno regressions"), {
			expandAsyncResults: true,
		});
		expect(output).toContain("[async-result] qa-review");
		expect(output).toContain("verdict: PASS");
		expect(output).toContain("no regressions");
		expect(output).not.toContain("… (+truncated)");
	});

	it("caps the async-result excerpt at 15 lines and marks the truncation", () => {
		const many = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join("\n");
		const output = formatSessionHistoryMarkdown(asyncResultMessage(many), { expandAsyncResults: true });
		expect(output).toContain("line-15");
		expect(output).not.toContain("line-16");
		expect(output).toContain("… (+truncated)");
	});
});
