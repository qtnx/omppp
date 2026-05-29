import { prompt } from "@oh-my-pi/pi-utils";
import { buildSkillPromptMessage } from "../extensibility/skills";
import agentMentionsTemplate from "../prompts/system/agent-mentions.md" with { type: "text" };
import { type CustomMessage, SKILL_PROMPT_MESSAGE_TYPE } from "./messages";

export interface DollarMentionSkill {
	name: string;
	description: string;
	filePath: string;
}

export interface DollarMentionAgent {
	name: string;
	description: string;
}

export interface DollarMentionCatalog {
	skills: readonly DollarMentionSkill[];
	agents: readonly DollarMentionAgent[];
}

export interface DollarMentionExtraction {
	skills: DollarMentionSkill[];
	agents: DollarMentionAgent[];
}

const DOLLAR_MENTION_REGEX = /(^|[\s([{<"'`])\$(skill|agent):([^\s$]+)/g;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;

function normalizeMentionName(rawName: string): string {
	return rawName.replace(TRAILING_PUNCTUATION_REGEX, "");
}

export function extractDollarMentions(text: string, catalog: DollarMentionCatalog): DollarMentionExtraction {
	const skillByName = new Map(catalog.skills.map(skill => [skill.name, skill]));
	const agentByName = new Map(catalog.agents.map(agent => [agent.name, agent]));
	const seenSkills = new Set<string>();
	const seenAgents = new Set<string>();
	const skills: DollarMentionSkill[] = [];
	const agents: DollarMentionAgent[] = [];

	for (const match of text.matchAll(DOLLAR_MENTION_REGEX)) {
		const kind = match[2];
		const name = normalizeMentionName(match[3] ?? "");
		if (kind === "skill") {
			const skill = skillByName.get(name);
			if (skill && !seenSkills.has(name)) {
				seenSkills.add(name);
				skills.push(skill);
			}
			continue;
		}

		const agent = agentByName.get(name);
		if (agent && !seenAgents.has(name)) {
			seenAgents.add(name);
			agents.push(agent);
		}
	}

	return { skills, agents };
}

export async function buildDollarMentionContextMessages(
	text: string,
	catalog: DollarMentionCatalog,
): Promise<CustomMessage[]> {
	const mentions = extractDollarMentions(text, catalog);
	const messages: CustomMessage[] = [];

	for (const skill of mentions.skills) {
		const built = await buildSkillPromptMessage(skill, "");
		messages.push({
			role: "custom",
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: false,
			details: built.details,
			attribution: "agent",
			timestamp: Date.now(),
		});
	}

	if (mentions.agents.length > 0) {
		messages.push({
			role: "custom",
			customType: "agent-mention-context",
			content: prompt.render(agentMentionsTemplate, { agents: mentions.agents }),
			display: false,
			details: { agents: mentions.agents.map(agent => agent.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
	}

	return messages;
}
