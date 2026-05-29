import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	getKeybindings,
	type SlashCommand,
	type WorkspaceAutocompleteRoot,
} from "@oh-my-pi/pi-tui";
import { formatKeyHints, type KeybindingsManager } from "../config/keybindings";
import { isSettingsInitialized, settings } from "../config/settings";
import type { DollarMentionAgent, DollarMentionSkill } from "../session/dollar-mentions";
import { applyEmojiCompletion, getEmojiSuggestions, isEmojiPrefix, tryEmojiInlineReplace } from "./emoji-autocomplete";
import {
	applyInternalUrlCompletion,
	getInternalUrlSuggestions,
	isInternalUrlPrefix,
} from "./internal-url-autocomplete";

interface PromptActionDefinition {
	id: string;
	label: string;
	description: string;
	keywords: string[];
	execute: (prefix: string) => void;
}

interface PromptActionAutocompleteItem extends AutocompleteItem {
	actionId: string;
	execute: (prefix: string) => void;
}

interface DollarMentionAutocompleteOptions {
	skills: readonly DollarMentionSkill[];
	agents: readonly DollarMentionAgent[];
}

interface PromptActionAutocompleteOptions {
	dollarMentions?: DollarMentionAutocompleteOptions;
	commands: SlashCommand[];
	basePath: string;
	keybindings: KeybindingsManager;
	workspaceRoots?: readonly WorkspaceAutocompleteRoot[];
	copyCurrentLine: () => void;
	copyPrompt: () => void;
	undo: (prefix: string) => void;
	moveCursorToMessageEnd: () => void;
	moveCursorToMessageStart: () => void;
	moveCursorToLineStart: () => void;
	moveCursorToLineEnd: () => void;
}

function fuzzyMatch(query: string, target: string): boolean {
	if (query.length === 0) return true;
	if (query.length > target.length) return false;

	let queryIndex = 0;
	for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex += 1) {
		if (query[queryIndex] === target[targetIndex]) {
			queryIndex += 1;
		}
	}

	return queryIndex === query.length;
}

function fuzzyScore(query: string, target: string): number {
	if (query.length === 0) return 1;
	if (target === query) return 100;
	if (target.startsWith(query)) return 80;
	if (target.includes(query)) return 60;

	let queryIndex = 0;
	let gaps = 0;
	let lastMatchIndex = -1;
	for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex += 1) {
		if (query[queryIndex] === target[targetIndex]) {
			if (lastMatchIndex >= 0 && targetIndex - lastMatchIndex > 1) {
				gaps += 1;
			}
			lastMatchIndex = targetIndex;
			queryIndex += 1;
		}
	}

	if (queryIndex !== query.length) return 0;
	return Math.max(1, 40 - gaps * 5);
}

function isPromptActionItem(item: AutocompleteItem): item is PromptActionAutocompleteItem {
	return "actionId" in item && "execute" in item && typeof item.execute === "function";
}

function getPromptActionPrefix(textBeforeCursor: string): string | null {
	const hashIndex = textBeforeCursor.lastIndexOf("#");
	if (hashIndex === -1) return null;

	const query = textBeforeCursor.slice(hashIndex + 1);
	if (/[\s]/.test(query)) {
		return null;
	}

	return textBeforeCursor.slice(hashIndex);
}

function getDollarMentionPrefix(textBeforeCursor: string): string | null {
	const dollarIndex = textBeforeCursor.lastIndexOf("$");
	if (dollarIndex === -1) return null;
	if (dollarIndex > 0 && !/[\s([{<"'`]/.test(textBeforeCursor[dollarIndex - 1] ?? "")) return null;

	const query = textBeforeCursor.slice(dollarIndex + 1);
	if (query.startsWith("{") || /[\s]/.test(query)) {
		return null;
	}

	return textBeforeCursor.slice(dollarIndex);
}

function buildDollarMentionItems(
	prefix: string,
	options: DollarMentionAutocompleteOptions | undefined,
): AutocompleteItem[] {
	if (!options) return [];
	const query = prefix.slice(1).toLowerCase();
	const candidates: Array<AutocompleteItem & { score: number }> = [];

	for (const skill of options.skills) {
		const value = `$skill:${skill.name}`;
		const searchable = `skill ${skill.name} ${skill.description}`.toLowerCase();
		if (!fuzzyMatch(query, searchable)) continue;
		candidates.push({
			value,
			label: `skill:${skill.name}`,
			description: skill.description ? `Skill — ${skill.description}` : "Skill",
			score: fuzzyScore(query, searchable),
		});
	}

	for (const agent of options.agents) {
		const value = `$agent:${agent.name}`;
		const searchable = `agent ${agent.name} ${agent.description}`.toLowerCase();
		if (!fuzzyMatch(query, searchable)) continue;
		candidates.push({
			value,
			label: `agent:${agent.name}`,
			description: agent.description ? `Agent — ${agent.description}` : "Agent",
			score: fuzzyScore(query, searchable),
		});
	}

	return candidates.sort((a, b) => b.score - a.score).map(({ score: _score, ...item }) => item);
}

export class PromptActionAutocompleteProvider implements AutocompleteProvider {
	#dollarMentions?: DollarMentionAutocompleteOptions;
	#baseProvider: CombinedAutocompleteProvider;
	#actions: PromptActionDefinition[];

	constructor(
		commands: SlashCommand[],
		basePath: string,
		actions: PromptActionDefinition[],
		dollarMentions?: DollarMentionAutocompleteOptions,
		workspaceRoots?: readonly WorkspaceAutocompleteRoot[],
	) {
		this.#baseProvider = new CombinedAutocompleteProvider(commands, basePath, { workspaceRoots });
		this.#actions = actions;
		this.#dollarMentions = dollarMentions;
	}
	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const promptActionPrefix = getPromptActionPrefix(textBeforeCursor);
		const dollarMentionPrefix = getDollarMentionPrefix(textBeforeCursor);
		if (dollarMentionPrefix) {
			const items = buildDollarMentionItems(dollarMentionPrefix, this.#dollarMentions);
			if (items.length > 0) {
				return { items, prefix: dollarMentionPrefix };
			}
		}
		if (promptActionPrefix) {
			const query = promptActionPrefix.slice(1).toLowerCase();
			const items = this.#actions
				.map(action => {
					const searchable = [action.label, action.description, ...action.keywords].join(" ").toLowerCase();
					if (!fuzzyMatch(query, searchable)) return null;
					return {
						value: action.label,
						label: action.label,
						description: action.description,
						actionId: action.id,
						execute: action.execute,
						score: fuzzyScore(query, searchable),
					} satisfies PromptActionAutocompleteItem & { score: number };
				})
				.filter(item => item !== null)
				.sort((a, b) => b.score - a.score)
				.map(({ score: _score, ...item }) => item);
			if (items.length > 0) {
				return { items, prefix: promptActionPrefix };
			}
		}

		const urlSuggestions = await getInternalUrlSuggestions(textBeforeCursor);
		if (urlSuggestions) return urlSuggestions;

		if (!isSettingsInitialized() || settings.get("emojiAutocomplete")) {
			const emojiSuggestions = getEmojiSuggestions(textBeforeCursor);
			if (emojiSuggestions) return emojiSuggestions;
		}

		return this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol);
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
		onApplied?: () => void;
	} {
		if (prefix.startsWith("#") && isPromptActionItem(item)) {
			if (item.actionId === "undo") {
				return {
					lines,
					cursorLine,
					cursorCol,
					onApplied: () => item.execute(prefix),
				};
			}
			const currentLine = lines[cursorLine] || "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = beforePrefix + afterCursor;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length,
				onApplied: () => item.execute(prefix),
			};
		}

		if (isInternalUrlPrefix(prefix)) {
			return applyInternalUrlCompletion(lines, cursorLine, cursorCol, item, prefix);
		}

		if (prefix.startsWith("$")) {
			const currentLine = lines[cursorLine] || "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = beforePrefix + item.value + afterCursor;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length,
			};
		}

		if (isEmojiPrefix(prefix)) {
			return applyEmojiCompletion(lines, cursorLine, cursorCol, item, prefix);
		}
		return this.#baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		return this.#baseProvider.getInlineHint?.(lines, cursorLine, cursorCol) ?? null;
	}
	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		return this.#baseProvider.trySyncSlashCompletion?.(textBeforeCursor) ?? null;
	}
	trySyncInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
		if (isSettingsInitialized() && !settings.get("emojiAutocomplete")) return null;
		return tryEmojiInlineReplace(textBeforeCursor);
	}
}

export function createPromptActionAutocompleteProvider(
	options: PromptActionAutocompleteOptions,
): PromptActionAutocompleteProvider {
	const editorKeybindings = getKeybindings();
	const actions: PromptActionDefinition[] = [
		{
			id: "copy-line",
			label: "Copy current line",
			description: formatKeyHints(options.keybindings.getKeys("app.clipboard.copyLine")),
			keywords: ["copy", "line", "clipboard", "current"],
			execute: options.copyCurrentLine,
		},
		{
			id: "copy-prompt",
			label: "Copy whole prompt",
			description: formatKeyHints(options.keybindings.getKeys("app.clipboard.copyPrompt")),
			keywords: ["copy", "prompt", "clipboard", "message"],
			execute: options.copyPrompt,
		},
		{
			id: "undo",
			label: "Undo",
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.undo")),
			keywords: ["undo", "revert", "edit", "history"],
			execute: options.undo,
		},
		{
			id: "cursor-message-end",
			label: "Move cursor to end of message",
			description: "Current message",
			keywords: ["move", "cursor", "message", "end", "prompt", "last", "bottom"],
			execute: options.moveCursorToMessageEnd,
		},
		{
			id: "cursor-message-start",
			label: "Move cursor to beginning of message",
			description: "Current message",
			keywords: ["move", "cursor", "message", "start", "beginning", "prompt", "first", "top"],
			execute: options.moveCursorToMessageStart,
		},
		{
			id: "cursor-line-start",
			label: "Move cursor to beginning of line",
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.cursorLineStart")),
			keywords: ["move", "cursor", "line", "start", "beginning", "home"],
			execute: options.moveCursorToLineStart,
		},
		{
			id: "cursor-line-end",
			label: "Move cursor to end of line",
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.cursorLineEnd")),
			keywords: ["move", "cursor", "line", "end"],
			execute: options.moveCursorToLineEnd,
		},
	];

	return new PromptActionAutocompleteProvider(
		options.commands,
		options.basePath,
		actions,
		options.dollarMentions,
		options.workspaceRoots,
	);
}
