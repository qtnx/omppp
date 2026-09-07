import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { unzipSync } from "fflate";
import {
	collectModelBlame,
	exportSessionFeedbackZip,
	formatModelBlame,
	formatSessionFeedbackList,
	hasSessionRating,
	listSessionFeedback,
	parseFeedbackInput,
	recordProfanityFeedback,
	recordSessionFeedback,
} from "../src/session/session-feedback";
import { SessionManager } from "../src/session/session-manager";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function appendAssistant(manager: SessionManager, text: string): void {
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	});
}

function commandRuntime(manager: SessionManager, output: string[]): SlashCommandRuntime {
	return {
		session: { sessionManager: manager, model: undefined } as unknown as SlashCommandRuntime["session"],
		sessionManager: manager,
		settings: {} as SlashCommandRuntime["settings"],
		cwd: manager.getCwd(),
		output: text => {
			output.push(text);
		},
		refreshCommands: () => undefined,
		reloadPlugins: async () => undefined,
	};
}

async function runFeedbackCommand(manager: SessionManager, args: string, output: string[]): Promise<void> {
	const spec = lookupBuiltinSlashCommand("feedback");
	if (!spec?.handle) throw new Error("feedback command is not registered");
	await spec.handle({ name: "feedback", args, text: args }, commandRuntime(manager, output));
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("session feedback", () => {
	it("records parsed feedback, targets the latest assistant, and lists only feedback entries", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		appendAssistant(manager, "Line one\nmore");
		manager.appendCustomEntry("other", { text: "not feedback" });

		const record = recordSessionFeedback(
			{ sessionManager: manager, model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
			"+1 nice work",
		);
		const listed = listSessionFeedback(manager);

		expect(record.rating).toBe("positive");
		expect(record.text).toBe("nice work");
		expect(record.targetPreview).toBe("Line one");
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ text: "nice work", rating: "positive", targetPreview: "Line one" });
		expect(formatSessionFeedbackList(listed)).toContain("nice work");
	});

	it("rejects blank feedback and parses negative and unlabelled input", () => {
		const manager = SessionManager.inMemory();

		expect(() => recordSessionFeedback({ sessionManager: manager }, "   ")).toThrow("Feedback text is empty.");
		expect(parseFeedbackInput("-1 too slow")).toEqual({ rating: "negative", text: "too slow" });
		expect(parseFeedbackInput("just a note")).toEqual({ text: "just a note" });
	});

	it("routes list and save commands to observable output, including usage for empty args", async () => {
		const manager = SessionManager.inMemory();
		const output: string[] = [];

		await runFeedbackCommand(manager, "list", output);
		expect(output.at(-1)).toBe("No feedback recorded for this session yet. Add some with /feedback <text>.");

		await runFeedbackCommand(manager, "some text", output);
		await runFeedbackCommand(manager, "list", output);
		expect(output.at(-1)).toContain("some text");

		await runFeedbackCommand(manager, "", output);
		expect(output.at(-1)).toBe(
			"Usage: /feedback <text> | /feedback rate <1-5> [text] | /feedback list | /feedback stats | /feedback export [path]",
		);
	});

	it("records 1-5 scores via `rate`, derives the rating, and rejects out-of-range scores", async () => {
		const manager = SessionManager.inMemory();
		const output: string[] = [];

		expect(hasSessionRating(manager)).toBe(false);
		await runFeedbackCommand(manager, "rate 7 nope", output);
		expect(output.at(-1)).toBe("Usage: /feedback rate <1-5> [text]");
		expect(hasSessionRating(manager)).toBe(false);

		await runFeedbackCommand(manager, "rate 2 missed the bug", output);
		expect(output.at(-1)).toBe("Rated this session 2/5. Review with /feedback list.");
		const [record] = listSessionFeedback(manager);
		expect(record).toMatchObject({ score: 2, rating: "negative", text: "missed the bug", source: "command" });
		expect(hasSessionRating(manager)).toBe(true);

		const high = recordSessionFeedback({ sessionManager: manager }, { score: 5, source: "rating-prompt" });
		expect(high).toMatchObject({ score: 5, rating: "positive", text: "", source: "rating-prompt" });
		expect(formatSessionFeedbackList(listSessionFeedback(manager))).toContain("[5/5] (no text)");
	});

	it("auto-records a 1/5 for profanity aimed at the last assistant turn without consuming the idle rating", () => {
		const manager = SessionManager.inMemory();
		const session = { sessionManager: manager, model: { provider: "openai", id: "gpt-6-astra" } };

		// No assistant message yet: nothing to blame.
		expect(recordProfanityFeedback(session, "fuck this")).toBeUndefined();

		appendAssistant(manager, "Browser computer action complete. URL: about:blank");
		expect(recordProfanityFeedback(session, "please open the map")).toBeUndefined();
		expect(recordProfanityFeedback(session, "dm cái này là gì")).toBeUndefined();

		const record = recordProfanityFeedback(session, "  fuck you. use fucking computer not browser  ");
		expect(record).toMatchObject({
			score: 1,
			rating: "negative",
			source: "auto-profanity",
			model: "openai/gpt-6-astra",
			text: "fuck you. use fucking computer not browser",
		});
		expect(record?.targetPreview).toContain("about:blank");
		expect(recordProfanityFeedback(session, "địt cụ mày sao ngu thế")).toMatchObject({ score: 1 });
		expect(listSessionFeedback(manager)).toHaveLength(2);
		expect(hasSessionRating(manager)).toBe(false);
		expect(formatSessionFeedbackList(listSessionFeedback(manager))).toContain("[1/5 auto]");
	});

	it("tallies negative feedback per model across every persisted session", async () => {
		const root = await makeTempDir("session-feedback-root-");
		const sessionsRoot = path.join(root, "sessions");
		const makeSession = async (
			name: string,
			model: { provider: string; id: string } | undefined,
			inputs: Array<string | { score: 1 | 2 | 3 | 4 | 5 }>,
		) => {
			const cwd = path.join(root, name);
			await fs.mkdir(cwd, { recursive: true });
			const manager = SessionManager.create(cwd, path.join(sessionsRoot, name));
			appendAssistant(manager, "reply");
			for (const input of inputs) recordSessionFeedback({ sessionManager: manager, model }, input);
			await manager.ensureOnDisk();
			await manager.flush();
		};
		await makeSession("a", { provider: "openai", id: "gpt-6-astra" }, [
			{ score: 1 },
			{ score: 2 },
			"-1 wrong tool",
			"+1 nice",
		]);
		await makeSession("b", { provider: "anthropic", id: "claude-opus-5" }, [{ score: 5 }, "-1 slow"]);
		await makeSession("c", undefined, [{ score: 3 }]);

		const rows = await collectModelBlame(sessionsRoot);
		expect(rows.map(row => [row.model, row.negative, row.total])).toEqual([
			["openai/gpt-6-astra", 3, 4],
			["anthropic/claude-opus-5", 1, 2],
			["(unknown)", 0, 1],
		]);
		expect(formatModelBlame(rows).split("\n")[2]).toMatch(/^\s+3\s+0\s+4\s+openai\/gpt-6-astra$/);
		expect(await collectModelBlame(path.join(root, "missing"))).toEqual([]);
	});

	it("exports persisted feedback with its transcript and omits the transcript for in-memory sessions", async () => {
		const cwd = await makeTempDir("session-feedback-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const persisted = SessionManager.create(cwd, sessionDir);
		persisted.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		appendAssistant(persisted, "answer");
		recordSessionFeedback({ sessionManager: persisted }, "useful");
		await persisted.ensureOnDisk();
		await persisted.flush();

		const explicitPath = path.join(cwd, "feedback-export.zip");
		const persistedResult = await exportSessionFeedbackZip(persisted, explicitPath);
		const persistedZip = unzipSync(new Uint8Array(await Bun.file(persistedResult.path).arrayBuffer()));
		const persistedFeedback = JSON.parse(new TextDecoder().decode(persistedZip["feedback.json"]!)) as Array<{
			text: string;
		}>;
		const persistedManifest = JSON.parse(new TextDecoder().decode(persistedZip["manifest.json"]!)) as {
			feedbackCount: number;
		};

		expect(persistedResult).toMatchObject({ path: path.resolve(explicitPath), count: 1, includesTranscript: true });
		expect(persistedZip["session.jsonl"]).toBeDefined();
		expect(persistedFeedback).toHaveLength(1);
		expect(persistedFeedback[0]?.text).toBe("useful");
		expect(persistedZip["feedback.md"]).toBeDefined();
		expect(persistedManifest.feedbackCount).toBe(1);

		const memoryCwd = await makeTempDir("session-feedback-memory-");
		const memory = SessionManager.inMemory(memoryCwd);
		recordSessionFeedback({ sessionManager: memory }, "memory note");
		const memoryResult = await exportSessionFeedbackZip(memory);
		const memoryZip = unzipSync(new Uint8Array(await Bun.file(memoryResult.path).arrayBuffer()));

		expect(memoryResult).toMatchObject({
			path: path.join(memoryCwd, `${APP_NAME}-feedback-${memory.getSessionId()}.zip`),
			count: 1,
			includesTranscript: false,
		});
		expect(memoryZip["session.jsonl"]).toBeUndefined();
	});
});
