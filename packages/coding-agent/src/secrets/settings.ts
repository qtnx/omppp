/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { effect, register } from "../config/registry";

// ────────────────────────────────────────────────────────────────────────
// Providers
// ────────────────────────────────────────────────────────────────────────

// Secret handling
export const cfgSecretsEnabled = register({
	id: "secrets.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Privacy",
		label: "Hide Secrets",
		description: "Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers",
	},
});
// Process-wide fallback for requests outside a session; a session's own requests redact per its
// settings (`withCredentialRedaction` in `sdk.ts`), whichever instance holds the effects.
effect(cfgSecretsEnabled, configureCredentialRedaction);

export const cfgSecretsAutoDetect = register({
	id: "secrets.autoDetect",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Privacy",
		label: "Auto-detect Secrets",
		description:
			"Detect secrets in prompts and bash output, store them in the vault, and show the model only their env var names",
	},
});

export const cfgSecretsSentinelUrl = register({
	id: "secrets.sentinelUrl",
	type: "string",
	default: "http://codemc:8795",
	ui: {
		tab: "providers",
		group: "Privacy",
		label: "Secrets Sentinel Server",
		description:
			"Secrets Sentinel classifier server that catches passwords and keys regex detection misses. Defaults to codemc on the tailnet; when it is unreachable, detection uses regex only. Leave empty to disable. SECRETS_SENTINEL_URL overrides this.",
	},
});

export const cfgSecretsInjectEnv = register({
	id: "secrets.injectEnv",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Privacy",
		label: "Inject Vault Secrets into Bash",
		description:
			"Export saved vault secrets as environment variables for bash commands without displaying their values",
	},
});
