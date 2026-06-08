export interface RootSandboxFlagResult {
	argv: string[];
	noSandbox: boolean;
}

export function extractRootNoSandboxFlag(argv: string[]): RootSandboxFlagResult {
	const first = argv[0];
	if (first === "--no-sandbox" || first?.startsWith("--no-sandbox=")) {
		return { argv: argv.slice(1), noSandbox: true };
	}
	return { argv, noSandbox: false };
}
