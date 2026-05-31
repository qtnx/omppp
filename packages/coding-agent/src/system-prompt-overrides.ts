import { findConfigFile } from "./config";

export interface SystemPromptOverlayFile {
	path: string;
	content: string;
	hash: string;
}

export interface SystemPromptOverlaySnapshot {
	systemPrompt?: SystemPromptOverlayFile;
	appendPrompt?: SystemPromptOverlayFile;
	signature: string;
}

function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

async function readOverlayFile(filePath: string | undefined): Promise<SystemPromptOverlayFile | undefined> {
	if (!filePath) return undefined;
	const content = await Bun.file(filePath).text();
	return { path: filePath, content, hash: sha256(content) };
}

function discoverSystemPromptPath(cwd: string): string | undefined {
	return findConfigFile("SYSTEM.md", { cwd, user: false }) ?? findConfigFile("SYSTEM.md", { cwd, user: true });
}

function discoverAppendSystemPromptPath(cwd: string): string | undefined {
	return (
		findConfigFile("APPEND_SYSTEM.md", { cwd, user: false }) ??
		findConfigFile("APPEND_SYSTEM.md", { cwd, user: true })
	);
}

function buildSignature(
	systemPrompt: SystemPromptOverlayFile | undefined,
	appendPrompt: SystemPromptOverlayFile | undefined,
): string {
	return [systemPrompt, appendPrompt].map(file => (file ? `${file.path}\u0000${file.hash}` : "-")).join("\u0001");
}

export async function loadAutoDiscoveredSystemPromptOverlay(cwd: string): Promise<SystemPromptOverlaySnapshot> {
	const [systemPrompt, appendPrompt] = await Promise.all([
		readOverlayFile(discoverSystemPromptPath(cwd)),
		readOverlayFile(discoverAppendSystemPromptPath(cwd)),
	]);
	return { systemPrompt, appendPrompt, signature: buildSignature(systemPrompt, appendPrompt) };
}

export function applySystemPromptOverlay(defaultPrompt: string[], overlay: SystemPromptOverlaySnapshot): string[] {
	const systemPrompt = overlay.systemPrompt?.content;
	const appendPrompt = overlay.appendPrompt?.content;
	if (systemPrompt && appendPrompt) return [systemPrompt, appendPrompt, ...defaultPrompt.slice(1)];
	if (systemPrompt) return [systemPrompt, ...defaultPrompt.slice(1)];
	if (appendPrompt) return [...defaultPrompt, appendPrompt];
	return defaultPrompt;
}

export function createAutoDiscoveredSystemPromptOverride(
	getCwd: () => string,
): (defaultPrompt: string[]) => Promise<string[]> {
	return async defaultPrompt =>
		applySystemPromptOverlay(defaultPrompt, await loadAutoDiscoveredSystemPromptOverlay(getCwd()));
}
