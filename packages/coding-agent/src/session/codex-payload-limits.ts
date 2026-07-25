const CODEX_PRE_PROMPT_COMPACTION_BYTES = 12 * 1024 * 1024;
const CODEX_WEBSOCKET_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

function parseNonNegativeIntegerEnv(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return Math.trunc(parsed);
}

export function getCodexPrePromptCompactionBytes(): number {
	return parseNonNegativeIntegerEnv(Bun.env.PI_CODEX_PRE_PROMPT_COMPACTION_BYTES, CODEX_PRE_PROMPT_COMPACTION_BYTES);
}

export function getCodexSnapcompactProviderContextMaxBytes(): number {
	const explicit = Bun.env.PI_CODEX_SNAPCOMPACT_PROVIDER_CONTEXT_MAX_BYTES;
	if (explicit !== undefined) {
		return parseNonNegativeIntegerEnv(explicit, CODEX_PRE_PROMPT_COMPACTION_BYTES);
	}
	return Math.min(
		getCodexPrePromptCompactionBytes(),
		parseNonNegativeIntegerEnv(Bun.env.PI_CODEX_WEBSOCKET_MAX_REQUEST_BYTES, CODEX_WEBSOCKET_MAX_REQUEST_BYTES),
	);
}
