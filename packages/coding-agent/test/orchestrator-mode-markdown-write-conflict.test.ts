import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { OrchestratorModeState } from "@oh-my-pi/pi-coding-agent/orchestrator-mode/state";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CONFLICTING_TS = [
	"before",
	"<<<<<<< HEAD",
	"oldApi();",
	"=======",
	"newApi();",
	">>>>>>> feature/api",
	"after",
	"",
].join("\n");

const CONFLICTING_MD = [
	"intro",
	"<<<<<<< HEAD",
	"old note",
	"=======",
	"new note",
	">>>>>>> feature/notes",
	"outro",
	"",
].join("\n");

function createSession(cwd: string, orchestratorEnabled: boolean): ToolSession {
	const orchestratorState: OrchestratorModeState | undefined = orchestratorEnabled ? { enabled: true } : undefined;
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getPlanModeState: () => undefined,
		getOrchestratorModeState: () => orchestratorState,
	} as unknown as ToolSession;
}

async function getReadWriteTools(session: ToolSession) {
	const tools = await createTools(session, ["read", "write"]);
	const read = tools.find(tool => tool.name === "read");
	const write = tools.find(tool => tool.name === "write");
	if (!read || !write) throw new Error("Missing read or write tool");
	return { read, write };
}

describe("orchestrator mode Markdown write conflict resolution gate", () => {
	let tempDir: string;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-md-conflict-"));
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	it("blocks conflict://N writes to non-Markdown targets while leaving the file unchanged", async () => {
		const fooTs = path.join(tempDir, "foo.ts");
		await Bun.write(fooTs, CONFLICTING_TS);
		const session = createSession(tempDir, true);
		const { read, write } = await getReadWriteTools(session);

		await read.execute("read-ts-conflict", { path: fooTs });
		const promise = write.execute("write-ts-conflict", {
			path: "conflict://1",
			content: "resolved();\n",
		});
		await expect(promise).rejects.toThrow(/only Markdown \(\.md\) files/);
		expect(await Bun.file(fooTs).text()).toBe(CONFLICTING_TS);
	});

	it("allows conflict://N writes to Markdown targets in orchestrator mode", async () => {
		const notesMd = path.join(tempDir, "notes.md");
		await Bun.write(notesMd, CONFLICTING_MD);
		const session = createSession(tempDir, true);
		const { read, write } = await getReadWriteTools(session);

		await read.execute("read-md-conflict", { path: notesMd });
		await expect(
			write.execute("write-md-conflict", {
				path: "conflict://1",
				content: "resolved note\n",
			}),
		).resolves.toBeDefined();

		expect(await Bun.file(notesMd).text()).toBe("intro\nresolved note\noutro\n");
	});

	it("leaves normal-mode conflict resolution as a no-op through the guard seam", async () => {
		const fooTs = path.join(tempDir, "foo.ts");
		await Bun.write(fooTs, CONFLICTING_TS);
		const session = createSession(tempDir, false);
		const { read, write } = await getReadWriteTools(session);

		await read.execute("read-normal-conflict", { path: fooTs });
		await expect(
			write.execute("write-normal-conflict", {
				path: "conflict://1",
				content: "resolved();\n",
			}),
		).resolves.toBeDefined();

		expect(await Bun.file(fooTs).text()).toBe("before\nresolved();\nafter\n");
	});
});
