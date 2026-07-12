import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { convertToLlm, normalizeCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { CustomMessageEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("bare custom_message recovery", () => {
	it("drops poisoned custom messages before LLM conversion", () => {
		const messages: AgentMessage[] = JSON.parse(
			`[{"role":"custom","timestamp":1,"customType":"hook-warning","display":false}]`,
		);

		expect(convertToLlm(messages)).toEqual([]);
	});

	it("skips legacy bare custom_message entries while rebuilding context", () => {
		const entries: SessionEntry[] = JSON.parse(
			`[{"type":"custom_message","id":"1","parentId":null,"timestamp":"2026-07-02T00:00:00.000Z","attribution":"agent"}]`,
		);

		const context = buildSessionContext(entries);

		expect(context.messages).toEqual([]);
	});

	it("stamps the originating entry id on rebuilt custom_message context", () => {
		const entries: SessionEntry[] = JSON.parse(
			`[{"type":"custom_message","id":"custom-entry","parentId":null,"timestamp":"2026-07-12T00:00:00.000Z","customType":"tool-output","content":"large tool output","display":false,"attribution":"agent"}]`,
		);

		const message = buildSessionContext(entries).messages[0];
		if (message?.role !== "custom") throw new Error("Expected rebuilt custom message");
		expect("entryId" in message ? message.entryId : undefined).toBe("custom-entry");
	});

	it("stamps entry ids on rebuilt custom, file, bash, and python context surfaces", () => {
		const entries: SessionEntry[] = JSON.parse(
			`[
				{"type":"custom_message","id":"custom-message-entry","parentId":null,"timestamp":"2026-07-12T00:00:00.000Z","customType":"tool-output","content":"custom payload","display":false,"attribution":"agent"},
				{"type":"message","id":"custom-entry","parentId":"custom-message-entry","timestamp":"2026-07-12T00:00:01.000Z","message":{"role":"custom","customType":"hook-output","content":"custom hook payload","display":false,"timestamp":1}},
				{"type":"message","id":"file-entry","parentId":"custom-entry","timestamp":"2026-07-12T00:00:02.000Z","message":{"role":"fileMention","files":[{"path":"src/example.ts","content":"export {}","lineCount":1,"byteSize":9}],"timestamp":2}},
				{"type":"message","id":"bash-entry","parentId":"file-entry","timestamp":"2026-07-12T00:00:03.000Z","message":{"role":"bashExecution","command":"bun test","output":"ok","exitCode":0,"timestamp":3}},
				{"type":"message","id":"python-entry","parentId":"bash-entry","timestamp":"2026-07-12T00:00:04.000Z","message":{"role":"pythonExecution","code":"print(1)","output":"1","exitCode":0,"timestamp":4}}
			]`,
		);

		const messages = buildSessionContext(entries).messages;
		const expectedEntryIds = ["custom-message-entry", "custom-entry", "file-entry", "bash-entry", "python-entry"];
		for (const [index, entryId] of expectedEntryIds.entries()) {
			const message = messages[index];
			if (!message || !("entryId" in message) || message.entryId !== entryId) {
				throw new Error(`Expected entry id ${entryId}`);
			}
		}
	});

	it("normalizes nullish custom message fields before persistence", () => {
		const session = SessionManager.inMemory();
		const malformed = JSON.parse("{}");

		const id = session.appendCustomMessageEntry(
			malformed.customType,
			malformed.content,
			malformed.display,
			undefined,
			malformed.attribution,
		);
		const entry = session.getBranch().find(entry => entry.id === id);

		expect(entry).toMatchObject({
			type: "custom_message",
			customType: "custom-message",
			content: "",
			display: false,
			attribution: "agent",
		} satisfies Partial<CustomMessageEntry>);
	});

	it("treats a bare string payload as visible custom message content", () => {
		expect(normalizeCustomMessagePayload("some warning")).toEqual({
			customType: "custom-message",
			content: "some warning",
			display: true,
			attribution: "agent",
		});
	});
});
