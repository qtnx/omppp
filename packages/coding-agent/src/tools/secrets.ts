import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import secretsDescription from "../prompts/tools/secrets.md" with { type: "text" };
import type { VaultSecretMeta } from "../secrets/vault";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

const secretsSchema = type({
	op: type("'list'").describe("list stored secret names and masks"),
});

export type SecretsParams = typeof secretsSchema.infer;

export interface SecretsToolDetails {
	secrets: VaultSecretMeta[];
}

function formatSecrets(secrets: VaultSecretMeta[]): string {
	if (secrets.length === 0) {
		return "No secrets are stored. Add a secret with /secrets add <NAME> <VALUE>.";
	}

	const lines = secrets.map(secret =>
		[
			`Name: ${secret.name}`,
			`Mask: ${secret.mask}`,
			`Length: ${secret.length}`,
			`Source: ${secret.source}`,
			`Created: ${secret.createdAt}`,
		].join(" | "),
	);
	lines.push("Each secret is exported as env var NAME in bash commands.");
	return lines.join("\n");
}

export class SecretsTool implements AgentTool<typeof secretsSchema, SecretsToolDetails> {
	readonly name = "secrets";
	readonly approval = "read" as const;
	readonly label = "Secrets";
	readonly summary = "List masked secret names available as bash environment variables";
	readonly description = secretsDescription;
	readonly parameters = secretsSchema;
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SecretsTool | null {
		return session.secretVault ? new SecretsTool(session) : null;
	}

	async execute(_id: string, _params: SecretsParams): Promise<AgentToolResult<SecretsToolDetails>> {
		const vault = this.session.secretVault;
		if (!vault) throw new ToolError("Secrets are not available in this session.");

		const secrets = vault.list();
		return {
			content: [{ type: "text", text: formatSecrets(secrets) }],
			details: { secrets },
		};
	}
}
