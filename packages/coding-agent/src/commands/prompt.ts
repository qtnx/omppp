/**
 * `ompx prompt` — submit a prompt to a running ompx session from outside its
 * TTY, over the per-session herdr control socket. The prompt text is delivered
 * byte-exact as ONE user message (no slash handling, no newline mangling).
 *
 * Exit codes: 0 accepted; 2 usage error; 3 no/ambiguous session; 4 busy;
 * 5 transport/protocol/internal failure.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import chalk from "chalk";
import { listControlSessions, sendControlPrompt } from "../herdr/control-client";
import type { ControlDeliverMode } from "../herdr/control-server";

export default class Prompt extends Command {
	static description = "Submit a prompt to a running ompx session (herdr control socket)";

	static args = {
		text: Args.string({ description: "Prompt text; omit or pass - to read stdin" }),
	};

	static flags = {
		session: Flags.string({ description: "Target session id" }),
		pane: Flags.string({ description: "Target herdr pane id" }),
		cwd: Flags.string({ description: "Target session by exact working directory" }),
		socket: Flags.string({ description: "Target control socket path directly" }),
		file: Flags.string({ char: "f", description: "Read the prompt from this file (byte-exact)" }),
		steer: Flags.boolean({ description: "Deliver as a steering message into the running turn" }),
		"follow-up": Flags.boolean({ description: "Queue as a follow-up message after the current turn" }),
		"require-idle": Flags.boolean({
			description: "Fail with exit 4 instead of submitting while the session is busy",
		}),
		timeout: Flags.integer({ description: "Response timeout in milliseconds", default: 10000 }),
		json: Flags.boolean({ description: "Output JSON" }),
		list: Flags.boolean({ description: "List live sessions instead of sending a prompt" }),
	};

	static examples = [
		'ompx prompt "run the tests"',
		"git diff | ompx prompt --session abc123 -",
		"ompx prompt --file plan.md --require-idle",
		"ompx prompt --list --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Prompt);

		if (flags.list) {
			const sessions = await listControlSessions();
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(sessions)}\n`);
			} else {
				for (const s of sessions) {
					process.stdout.write(`${s.sessionId}  ${s.paneId ?? "-"}  ${s.cwd}\n`);
				}
			}
			return;
		}

		if (flags.steer && flags["follow-up"]) {
			process.stderr.write(chalk.red("error: --steer and --follow-up are mutually exclusive\n"));
			process.exit(2);
		}
		if (flags.file && args.text !== undefined && args.text !== "-") {
			process.stderr.write(chalk.red("error: pass either text or --file, not both\n"));
			process.exit(2);
		}

		// Input precedence: --file > positional text > stdin ("-" forces stdin).
		// Stdin strips at most ONE trailing "\n" (the newline shells append); file bytes pass through untouched.
		let text: string;
		if (flags.file) {
			text = await Bun.file(flags.file).text();
		} else if (args.text !== undefined && args.text !== "-") {
			text = args.text;
		} else {
			text = stripOneTrailingNewline(await new Response(Bun.stdin.stream()).text());
		}
		if (text.length === 0) {
			process.stderr.write(chalk.red("error: empty prompt\n"));
			process.exit(2);
		}

		const deliverAs: ControlDeliverMode | undefined = flags.steer
			? "steer"
			: flags["follow-up"]
				? "followUp"
				: undefined;

		const result = await sendControlPrompt(
			text,
			{ sessionId: flags.session, paneId: flags.pane, cwd: flags.cwd, socketPath: flags.socket },
			{ deliverAs, requireIdle: flags["require-idle"], timeoutMs: flags.timeout },
		);

		if (result.ok) {
			if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
			else process.stdout.write(`accepted ${result.mode} -> session ${result.sessionId}\n`);
			return;
		}

		if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
		else {
			process.stderr.write(chalk.red(`error (${result.code}): ${result.message}\n`));
			if (result.candidates) {
				for (const c of result.candidates) {
					process.stderr.write(chalk.dim(`  ${c.sessionId}  ${c.paneId ?? "-"}  ${c.cwd}\n`));
				}
			}
		}
		const exitCode = result.code === "no_session" || result.code === "ambiguous" ? 3 : result.code === "busy" ? 4 : 5;
		process.exit(exitCode);
	}
}

/** Strip at most ONE trailing "\n" (shell/editor artifact); all other bytes pass through. */
function stripOneTrailingNewline(input: string): string {
	return input.endsWith("\n") ? input.slice(0, -1) : input;
}
