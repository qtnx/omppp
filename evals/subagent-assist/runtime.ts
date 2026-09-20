import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { redactMemorySecrets } from "../../packages/coding-agent/src/memory-backend/redact";

const root = path.resolve(import.meta.dir, "../..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-completion-runtime-"));
const binary = path.join(temporary, "bin/ompx");
const results: Array<{
	scenario: string;
	exit: number;
	artifactCorrect: boolean;
	artifactObserved: string | null;
	modelReplies: number;
	error: boolean;
	stopReasons: string[];
	harnessTimeout: boolean;
	diagnostic: string;
}> = [];
try {
	await Bun.write(binary, Bun.file(path.join(root, "packages/coding-agent/dist/ompx")));
	await fs.chmod(binary, 0o755);
	for (const [scenario, request] of [
		[
			"success",
			"Create delivery.txt containing exactly these 19 UTF-8 bytes: verified-completion. No trailing newline or other bytes. Verify its contents, then finish. Work locally only.",
		],
		[
			"external-blocker",
			"I have not provided the required approval code. Do not invent it. Write approval.txt only after I provide that code. For now, explain the missing user-held prerequisite and do not write any file.",
		],
	] as const) {
		if (Bun.argv.includes("--external-only") && scenario !== "external-blocker") continue;
		if (Bun.argv.includes("--success-only") && scenario !== "success") continue;
		const cwd = path.join(temporary, scenario);
		await Bun.write(
			path.join(cwd, ".omp/config.yml"),
			"autonomy:\n  stopGate: true\nadvisor:\n  enabled: false\nduo:\n  mode: off\n",
		);
		const child = Bun.spawn(
			[
				binary,
				"--cwd",
				cwd,
				"--print",
				"--mode",
				"json",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--no-lsp",
				"--no-title",
				"--tools",
				"read,write",
				"--max-time",
				"120s",
				"--",
				request,
			],
			{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		let harnessTimeout = false;
		const timer = setTimeout(() => {
			harnessTimeout = true;
			child.kill("SIGTERM");
		}, 130000);
		let stdout = "";
		let stderr = "";
		let exit = -1;
		try {
			[stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) {
				child.kill("SIGTERM");
				await child.exited;
			}
		}
		const messages = stdout.split("\n").flatMap(line => {
			try {
				const event = JSON.parse(line);
				return event.type === "message_end" && event.message?.role === "assistant" ? [event.message] : [];
			} catch {
				return [];
			}
		});
		const file = Bun.file(path.join(cwd, scenario === "success" ? "delivery.txt" : "approval.txt"));
		const artifactObserved = (await file.exists()) ? await file.text() : null;
		const artifactCorrect =
			scenario === "success"
				? artifactObserved === "verified-completion"
				: artifactObserved === null;
		results.push({
			scenario,
			exit,
			artifactCorrect,
			artifactObserved: artifactObserved === null ? null : redactMemorySecrets(artifactObserved).slice(0, 256),
			modelReplies: messages.length,
			error: stderr.length > 0 || messages.some(message => message.stopReason === "error"),
			stopReasons: messages.map(message => String(message.stopReason)),
			harnessTimeout,
			diagnostic: exit === 0 && artifactCorrect ? "" : redactMemorySecrets(stderr || stdout.slice(-3000)).slice(0, 3000),
		});
	}
} finally {
	await fs.rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ results, cleanup: true }));
if (results.some(result => result.exit !== 0 || !result.artifactCorrect || result.modelReplies === 0))
	process.exitCode = 1;
