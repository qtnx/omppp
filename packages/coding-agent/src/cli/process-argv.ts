/**
 * Bun exposes a compiled executable's embedded entry module as a virtual path.
 * It is runtime metadata, never a user argument or a reusable filesystem path.
 */
export function isBundledCliEntryArg(arg: string | undefined): boolean {
	if (!arg) return false;
	const normalized = arg.replace(/\\/g, "/");
	if (!normalized.toLowerCase().endsWith("/cli.js")) return false;
	return normalized.startsWith("/$bunfs/") || /^[A-Za-z]:\/~BUN\//i.test(normalized);
}
