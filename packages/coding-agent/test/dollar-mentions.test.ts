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

const skill: DollarMentionSkill = {
	name: "analyze",
	description: "Run read-only repository analysis",
	filePath: "/tmp/analyze/SKILL.md",
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
});
