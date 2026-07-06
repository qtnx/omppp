import type { ProviderDefinition } from "./types";

export const tnxProvider = {
	id: "tnx",
	name: "TNX",
} as const satisfies ProviderDefinition;
