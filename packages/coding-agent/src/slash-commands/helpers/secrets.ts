import { type VaultSecretMeta, vaultSecretEntry } from "../../secrets/vault";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, parseSubcommand, usage } from "./parse";

const HELP_TEXT = [
	"Usage: /secrets [list|add|remove]",
	"  /secrets                         List stored secrets",
	"  /secrets list                    List stored secrets",
	"  /secrets add <NAME> <VALUE>      Store a secret",
	"  /secrets remove <NAME>           Remove a secret",
].join("\n");

function formatSecret(meta: VaultSecretMeta): string {
	return [
		`Name: ${meta.name}`,
		`Mask: ${meta.mask}`,
		`Length: ${meta.length}`,
		`Source: ${meta.source}`,
		`Created: ${meta.createdAt}`,
	].join(" | ");
}

function formatSecretList(secrets: VaultSecretMeta[]): string {
	if (secrets.length === 0) return "No secrets are stored. Add one with /secrets add <NAME> <VALUE>.";
	return secrets.map(formatSecret).join("\n");
}

function unavailableMessage(): string {
	return "Secrets are unavailable. Enable secrets.enabled in Settings → Privacy.";
}

export async function handleSecretsCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const vault = runtime.session.secretVault;
	if (!vault) {
		await runtime.output(unavailableMessage());
		return commandConsumed();
	}

	const trimmed = command.args.trim();
	if (!trimmed || trimmed === "list") {
		await runtime.output(formatSecretList(vault.list()));
		return commandConsumed();
	}

	const { verb, rest } = parseSubcommand(trimmed);
	if (verb === "add") {
		const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
		if (!match) return usage("Usage: /secrets add <NAME> <VALUE>", runtime);

		const value = match[2]!;
		const name = await vault.set(match[1]!, value, "user");
		// Register with the live obfuscator: without this, a later bash result
		// echoing the injected env var would carry the value to the provider
		// verbatim (the startup obfuscator only knows secrets that existed then).
		runtime.session.registerRuntimeSecrets([vaultSecretEntry(name, value)]);
		const stored = vault.list().find(secret => secret.name === name);
		await runtime.output(stored ? `Stored ${stored.name}: ${stored.mask}` : `Stored ${name}: ••••`);
		return commandConsumed();
	}

	if (verb === "remove") {
		const name = rest.trim();
		if (!name || /\s/.test(name)) return usage("Usage: /secrets remove <NAME>", runtime);

		const removed = await vault.remove(name);
		await runtime.output(removed ? `Removed ${name}.` : `No secret named ${name}.`);
		return commandConsumed();
	}

	if (verb === "help" || verb === "?") {
		await runtime.output(HELP_TEXT);
		return commandConsumed();
	}

	return usage("Unknown /secrets subcommand. Use list, add, or remove.", runtime);
}
