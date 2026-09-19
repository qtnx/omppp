import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Real installed CLI, real tools and turn hooks. Only LLM/Jev HTTP endpoints are scripted.
// Usage: bun test/fixtures/duo-live-routing-probe.ts /absolute/path/to/installed/ompx
const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary)) throw new Error("Pass the absolute installed binary path");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "duo-routing-probe-"));
const agentDir = path.join(root, "agent");
const ids = ["deepseek-v4.1-flash", "claude-opus-5", "gpt-6-astra", "claude-fable-5-1"];
const calls: { model: string; thinking: unknown }[] = [];
let turn = 0;
let reject = false;
let sawPriorToolStep = false;
let advertisedTools: string[] = [];
let usageLimit = false;
let usageLimitFired = false;
const choice = (value: string) => ({ type: "choice", choice: value, confidence: 0.95, probabilities: { [value]: 1 } });
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/messages")) {
			const body = (await request.json()) as {
				model: string;
				thinking?: unknown;
				output_config?: { effort?: string };
				tools?: { name: string }[];
			};
			const primary = body.tools?.some(tool => tool.name === "bash" || tool.name === "_bash");
			// One account-level 429 with a multi-hour retry-after, exactly as the
			// provider answers a spent 5h window: no retry budget can wait it out,
			// so recovery has to be the duo fallback chain.
			if (primary && usageLimit && body.model === "claude-fable-5-1") {
				usageLimitFired = true;
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit." },
					}),
					{ status: 429, headers: { "Content-Type": "application/json", "retry-after-ms": "11005000" } },
				);
			}
			if (primary) {
				calls.push({ model: body.model, thinking: body.output_config?.effort ?? body.thinking });
				advertisedTools = body.tools?.map(tool => tool.name.replace(/^_/, "")) ?? [];
			}
			const tool = primary && calls.length <= 13;
			const readTool = body.tools?.find(tool => tool.name === "read" || tool.name === "_read")?.name;
			const content = tool
				? { type: "tool_use", id: `step_${calls.length}`, name: readTool, input: {} }
				: { type: "text", text: "" };
			const events: [string, object][] = [
				[
					"message_start",
					{
						type: "message_start",
						message: {
							id: `msg_${calls.length}`,
							type: "message",
							role: "assistant",
							model: body.model,
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 100, output_tokens: 0 },
						},
					},
				],
				["content_block_start", { type: "content_block_start", index: 0, content_block: content }],
				[
					"content_block_delta",
					{
						type: "content_block_delta",
						index: 0,
						delta: tool
							? {
									type: "input_json_delta",
									partial_json: JSON.stringify({
										path: `${path.join(root, "fixture.txt")}:${calls.length}`,
										i: "Inspecting routing fixture",
									}),
								}
							: { type: "text_delta", text: primary ? "Probe complete." : "No additional advice." },
					},
				],
				["content_block_stop", { type: "content_block_stop", index: 0 }],
				[
					"message_delta",
					{
						type: "message_delta",
						delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
						usage: { output_tokens: 10 },
					},
				],
				["message_stop", { type: "message_stop" }],
			];
			return new Response(
				events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
				{
					headers: { "Content-Type": "text/event-stream" },
				},
			);
		}
		if (url.pathname !== "/systemone") return Response.json({ data: [] });
		const input = (await request.json()) as {
			questions: Record<string, unknown>;
			state: { transcript?: string };
		};
		if (reject) return new Response("unavailable", { status: 503 });
		if (!("phase" in input.questions))
			return Response.json({
				model: "jev-local-fixture",
				answers: {
					difficulty: choice("easy"),
					risk_domain: { type: "noul", noul: 0 },
					thinking: choice("medium"),
				},
			});
		turn++;
		if (turn === 2) {
			sawPriorToolStep =
				input.state.transcript?.includes("fixture.txt:1") === true &&
				input.state.transcript.includes("fixture.txt:2");
		}
		const difficulty = turn <= 8 ? "extreme" : turn <= 10 ? "easy" : "hard";
		// Turn 13: still hard, but the remaining step is mechanical — effort drops on the same model at once.
		const thinking =
			difficulty === "extreme" ? "xhigh" : difficulty === "easy" ? "medium" : turn === 13 ? "medium" : "high";
		return Response.json({
			model: "jev-local-fixture",
			answers: {
				phase: choice(turn <= 4 ? "planning" : "implementing"),
				needs_review: { type: "noul", noul: 0 },
				progress: { type: "score", score: 0, legend: { 0: "progress", 1: "stuck" } },
				done_without_evidence: { type: "noul", noul: 0 },
				parallel_slices: { type: "noul", noul: 0 },
				// Turns 5-6 are still pure exploration on an extreme, risky task: the
				// executor must take the stream instead of a planner-grade model.
				open_ended_discovery: { type: "noul", noul: turn <= 6 ? 0.9 : 0 },
				difficulty: choice(difficulty),
				risk_domain: { type: "noul", noul: 0 },
				thinking: choice(thinking),
			},
		});
	},
});
try {
	const baseUrl = `http://127.0.0.1:${server.port}`;
	await Bun.write(
		path.join(root, "fixture.txt"),
		Array.from({ length: 14 }, (_, i) => `Routing step ${i + 1}.\n`).join(""),
	);
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				"routing-probe": {
					baseUrl,
					apiKey: "local-test-only",
					api: "anthropic-messages",
					models: ids.map(id => ({
						id,
						name: id,
						reasoning: true,
						thinking: { mode: "anthropic-adaptive", efforts: ["medium", "high", "xhigh"] },
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200000,
						maxTokens: 8192,
					})),
				},
			},
		}),
	);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			duo: {
				mode: "on",
				orchestrator: "auto",
				plannerModel: "routing-probe/claude-fable-5-1",
				executorModel: "routing-probe/deepseek-v4.1-flash",
				doneGate: "inherit",
				phaseModels: { preplanning: ["routing-probe/claude-opus-5:high"] },
				routing: { models: ids.map(id => `routing-probe/${id}`) },
				takeover: { signals: { enabled: false } },
			},
			advisor: { enabled: false, doneGate: false, syncBacklog: "off" },
			signals: { enabled: true, baseUrl: `${baseUrl}/systemone`, timeoutMs: 1000 },
			compaction: { enabled: false },
			memory: { backend: "off" },
			learning: { enabled: false },
			mnemopi: { autoRecall: false, autoRetain: false, noEmbeddings: true, llmMode: "none" },
		}),
	);
	for (const mode of ["live", "endpoint-503", "usage-limit"] as const) {
		const failure = mode === "endpoint-503";
		reject = failure;
		usageLimit = mode === "usage-limit";
		usageLimitFired = false;
		turn = 0;
		sawPriorToolStep = false;
		calls.length = 0;
		const child = Bun.spawn(
			[
				binary,
				"--no-session",
				"--duo",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--provider",
				"routing-probe",
				"--model",
				"claude-opus-5",
				"--mode",
				"json",
				"Brainstorm the design, then implement and inspect the result.",
			],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					XDG_CONFIG_HOME: root,
					PI_CODING_AGENT_DIR: agentDir,
					TYPESAFE_SYSTEMONE_URL: `${baseUrl}/systemone`,
					PI_NO_TITLE: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
		const [exit, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		clearTimeout(timer);
		const events = Bun.JSONL.parse(stdout) as { type: string; isError?: boolean }[];
		const toolResults = events.filter(event => event.type === "tool_execution_end");
		if (mode !== "usage-limit" && (toolResults.length !== 13 || toolResults.some(event => event.isError)))
			throw new Error(`Expected thirteen successful real tool calls: ${JSON.stringify(toolResults)}`);
		console.log(JSON.stringify({ case: mode, turns: turn, calls }));
		if (exit !== 0 || (mode === "live" && !calls.some(call => call.model === "claude-fable-5-1"))) {
			const logDir = path.join(root, ".omp", "logs");
			const logs = await fs.readdir(logDir);
			const log = logs.find(name => name.endsWith(`.${child.pid}.log`));
			const details = log ? await Bun.file(path.join(logDir, log)).text() : "";
			throw new Error(`CLI exit ${exit}: ${stderr}\n${stdout}\n${details.slice(-12000)}`);
		}
		if (calls[0]?.model !== "claude-opus-5") throw new Error("Brainstorm was demoted to the executor");
		for (const name of ["duo_handoff", "duo_escalate", "duo_change_phase"]) {
			if (!advertisedTools.includes(name)) throw new Error(`Live session did not advertise ${name}`);
		}
		if (mode === "usage-limit") {
			if (!usageLimitFired) throw new Error("The probe never returned the account 429");
			if (calls.some(call => call.model === "claude-fable-5-1"))
				throw new Error("A usage-limited model still answered a request");
			// The 429 rung is the top one: recovery is only possible because the
			// duo chain now continues down the ladder.
			if (!calls.some(call => call.model === "gpt-6-astra"))
				throw new Error(`Usage limit did not fall back to the next rung: ${JSON.stringify(calls)}`);
		} else if (mode === "live") {
			if (!sawPriorToolStep) throw new Error("Live routing omitted the preceding tool-loop step");
			// Extreme + risk, but those turns were exploration: the executor takes the stream.
			if (calls[6]?.model !== "deepseek-v4.1-flash")
				throw new Error(`Exploration kept a planner-grade model: ${JSON.stringify(calls[6])}`);
			if (!calls.some(call => call.model === "claude-fable-5-1" && call.thinking === "xhigh"))
				throw new Error("No live escalation");
			if (!calls.some(call => call.model === "deepseek-v4.1-flash" && call.thinking === "medium"))
				throw new Error("No executor handback");
			const astra = calls.findIndex(call => call.model === "gpt-6-astra" && call.thinking === "high");
			if (astra === -1) throw new Error("No later adaptation");
			if (calls[astra + 1]?.model !== "gpt-6-astra" || calls[astra + 1]?.thinking !== "medium")
				throw new Error(`Effort did not drop on the next request: ${JSON.stringify(calls[astra + 1])}`);
		} else if (calls.some(call => call.model !== "claude-opus-5"))
			throw new Error("Unavailable classifier changed model");
	}
	console.log(
		"installed duo routing probe: pass (recent history + live adaptation + immediate effort + account 429 fallback + unavailable endpoint)",
	);
} finally {
	await server.stop(true);
	await fs.rm(root, { recursive: true, force: true });
}
