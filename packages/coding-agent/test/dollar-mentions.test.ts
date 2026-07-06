import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "../src/config/keybindings";
import { createPromptActionAutocompleteProvider } from "../src/modes/prompt-action-autocomplete";
import {
	buildDollarMentionContextMessages,
	type DollarMentionAgent,
	type DollarMentionSkill,
	extractDollarMentions,
} from "../src/session/dollar-mentions";
import { convertToLlm } from "../src/session/messages";

const skill: DollarMentionSkill = {
	name: "analyze",
	description: "Run read-only repository analysis",
	filePath: "/tmp/analyze/SKILL.md",
	baseDir: "/tmp/analyze",
};

const agent: DollarMentionAgent = {
	name: "reviewer",
	description: "Review code for correctness and maintainability",
};

describe("dollar mention autocomplete", () => {
	it("suggests skills and agents from a dollar token anywhere in the prompt", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: KeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
			dollarMentions: { skills: [skill], agents: [agent] },
		});

		const suggestions = await provider.getSuggestions(["please use $rev"], 0, 15);

		expect(suggestions?.prefix).toBe("$rev");
		expect(suggestions?.items.map(item => item.value)).toContain("$agent:reviewer");
		expect(suggestions?.items.find(item => item.value === "$agent:reviewer")?.description).toBe(
			"Agent — Review code for correctness and maintainability",
		);
	});

	it("applies skill mention completion without replacing surrounding text", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: KeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
			dollarMentions: { skills: [skill], agents: [agent] },
		});
		const suggestions = await provider.getSuggestions(["run $ana on this"], 0, 8);
		const item = suggestions?.items.find(entry => entry.value === "$skill:analyze");
		expect(item).toBeDefined();
		if (!suggestions || !item) throw new Error("expected skill mention suggestion");

		const result = provider.applyCompletion(["run $ana on this"], 0, 8, item, suggestions.prefix);

		expect(result.lines).toEqual(["run $skill:analyze on this"]);
		expect(result.cursorCol).toBe(18);
	});
});

describe("dollar mention extraction", () => {
	it("extracts exact skill and agent mentions and ignores unknown names", () => {
		const result = extractDollarMentions("Use $skill:analyze with $agent:reviewer and $skill:missing", {
			skills: [skill],
			agents: [agent],
		});

		expect(result.skills.map(entry => entry.name)).toEqual(["analyze"]);
		expect(result.agents.map(entry => entry.name)).toEqual(["reviewer"]);
	});

	it("builds hidden context messages for mentioned skills and agents", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "omp-dollar-mention-"));
		const skillPath = path.join(tempDir, "SKILL.md");
		await writeFile(
			skillPath,
			"---\nname: analyze\ndescription: Analyze repos\n---\n\nSkill body instructions",
			"utf-8",
		);

		const messages = await buildDollarMentionContextMessages("Use $skill:analyze with $agent:reviewer", {
			skills: [{ ...skill, filePath: skillPath }],
			agents: [agent],
		});

		expect(messages.map(message => message.customType)).toEqual(["skill-prompt", "agent-mention-context"]);
		expect(messages[0]?.content).toContain("Skill body instructions");
		expect(messages[1]?.content).toContain("reviewer");
		expect(messages.every(message => message.display === false)).toBe(true);
	});

	it("loads dollar-mentioned skills as user-invoked submit context with prompt args", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "omp-dollar-mention-skill-"));
		const skillPath = path.join(tempDir, "SKILL.md");
		const uniqueBody = "UNIQUE_SYSTEM_PROMPTS_DOLLAR_MENTION_INSTRUCTION";
		await writeFile(
			skillPath,
			`---\nname: system-prompts\ndescription: System prompt house style\n---\n\n${uniqueBody}`,
			"utf-8",
		);

		const messages = await buildDollarMentionContextMessages("tighten this prompt $skill:system-prompts now", {
			skills: [
				{
					name: "system-prompts",
					description: "System prompt house style",
					filePath: skillPath,
					baseDir: tempDir,
				},
			],
			agents: [],
		});

		expect(messages).toHaveLength(1);
		const message = messages[0];
		expect(message).toBeDefined();
		if (!message) throw new Error("expected dollar-mentioned skill prompt");
		if (typeof message.content !== "string") throw new Error("expected text-only skill prompt");
		expect(message.customType).toBe("skill-prompt");
		expect(message.content).toContain(uniqueBody);
		expect(message.content).toContain(`[Skill directory: ${tempDir}]`);
		expect(message.content).toContain("User: tighten this prompt now");
		expect(message.attribution).toBe("user");

		const llmMessages = convertToLlm([
			message,
			{ role: "user", content: "tighten this prompt $skill:system-prompts now", timestamp: Date.now() },
		]);
		expect(llmMessages[0]?.role).toBe("user");
		expect(llmMessages[0]?.content).toEqual([{ type: "text", text: message.content }]);
		expect(llmMessages[1]?.role).toBe("user");
	});
});
