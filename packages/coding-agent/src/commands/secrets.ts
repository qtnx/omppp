/**
 * Manage the encrypted secret vault from the shell.
 *
 * This command is the ONLY path that can print a stored secret in plaintext,
 * and it exists precisely because the agent-facing surfaces cannot: the
 * `secrets` tool and `/secrets` slash command mask every value, and the bash
 * tool injects values as environment variables the model never reads back.
 * Revealing here is safe because it runs in the user's own process — the
 * output goes to their terminal, never into a session transcript or a provider
 * request.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import chalk from "chalk";
import { maskSecretValue, SecretVault, type VaultSecretMeta } from "../secrets/vault";
import { copyToClipboard } from "../utils/clipboard";

function emit(line: string): void {
	process.stdout.write(`${line}\n`);
}

/** Narrows to `never` so callers get flow-sensitive typing after a usage error. */
function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function formatRow(meta: VaultSecretMeta): string {
	return [
		chalk.bold(meta.name.padEnd(24)),
		chalk.dim(meta.mask.padEnd(16)),
		chalk.dim(`${meta.length}ch`.padEnd(7)),
		chalk.dim(meta.source.padEnd(9)),
		chalk.dim(meta.createdAt),
	].join(" ");
}

export default class Secrets extends Command {
	static description = "Manage the encrypted secret vault (list, reveal, copy, add, remove)";

	static args = {
		action: Args.string({
			description: "list | get | copy | add | remove",
			default: "list",
			options: ["list", "get", "copy", "add", "remove"],
		}),
		name: Args.string({ description: "Secret name" }),
		value: Args.string({ description: "Secret value (add; omit with --stdin)" }),
	};

	static flags = {
		reveal: Flags.boolean({
			description: "Print the secret value in plaintext instead of a mask (get)",
			default: false,
		}),
		stdin: Flags.boolean({
			description: "Read the value from stdin so it never lands in shell history (add)",
			default: false,
		}),
	};

	static examples = [
		"# List stored secrets (masked)\n  ompx secrets",
		"# Show a masked value\n  ompx secrets get GITHUB_TOKEN",
		"# Print the plaintext value\n  ompx secrets get GITHUB_TOKEN --reveal",
		"# Use a secret in the shell without printing it\n  export GITHUB_TOKEN=$(ompx secrets get GITHUB_TOKEN --reveal)",
		"# Copy a secret to the clipboard\n  ompx secrets copy GITHUB_TOKEN",
		"# Store a secret without leaving it in shell history\n  ompx secrets add DB_PASS --stdin",
		"# Remove a secret\n  ompx secrets remove DB_PASS",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Secrets);
		const vault = await SecretVault.open(getAgentDir());

		if (args.action === "list") {
			const secrets = vault.list();
			if (secrets.length === 0) {
				emit("No secrets stored. Add one with: ompx secrets add <NAME> --stdin");
				return;
			}
			for (const meta of secrets) emit(formatRow(meta));
			return;
		}

		const name = args.name?.trim();
		if (!name) fail(`Usage: ompx secrets ${args.action} <NAME>`);

		if (args.action === "get" || args.action === "copy") {
			const value = vault.get(name);
			if (value === undefined) fail(`No secret named ${name}.`);
			if (args.action === "copy") {
				await copyToClipboard(value);
				emit(`Copied ${name} (${maskSecretValue(value)}) to the clipboard.`);
				return;
			}
			// `--reveal` writes the bare value with no decoration: this output is
			// routinely captured by command substitution
			// (`export TOKEN=$(ompx secrets get TOKEN --reveal)`).
			emit(flags.reveal ? value : maskSecretValue(value));
			return;
		}

		if (args.action === "add") {
			const value = flags.stdin ? (await Bun.stdin.text()).replace(/\r?\n$/, "") : args.value;
			if (!value) fail("Usage: ompx secrets add <NAME> <VALUE>   (or --stdin)");
			const stored = await vault.set(name, value, "user");
			emit(`Stored ${stored} (${maskSecretValue(value)}).`);
			return;
		}

		const removed = await vault.remove(name);
		emit(removed ? `Removed ${name}.` : `No secret named ${name}.`);
	}
}
