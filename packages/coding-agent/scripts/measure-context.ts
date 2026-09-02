// Measures the startup context budget: rendered system prompt (per top-level section),
// tool descriptions + schemas, context files, and the skills listing.
// Usage: bun scripts/measure-context.ts [cwd]
import { Settings } from "../src/config/settings";
import { loadSkills } from "../src/extensibility/skills";
import { buildSystemPrompt, buildSystemPromptToolMetadata, loadProjectContextFiles } from "../src/system-prompt";
import { createTools, type ToolSession } from "../src/tools";

const cwd = process.argv[2] ?? process.cwd();
const tok = (s: string): number => Math.round(s.length / 4);

const session = {
	cwd,
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated(),
} as unknown as ToolSession;

const tools = await createTools(session);
const toolMap = new Map(tools.map(tool => [tool.name, tool]));
const metadata = buildSystemPromptToolMetadata(toolMap);
const toolNames = [...toolMap.keys()];
const { skills } = await loadSkills({ cwd });
const contextFiles = await loadProjectContextFiles({ cwd });

const { systemPrompt } = await buildSystemPrompt({
	cwd,
	contextFiles,
	skills,
	rules: [],
	toolNames,
	tools: metadata,
	nativeTools: true,
	inlineToolDescriptors: false,
	includeWorkspaceTree: true,
});
const text = systemPrompt.join("\n\n");

console.log(`TOTAL system prompt text: ${text.length} chars ≈ ${tok(text)} tokens (${systemPrompt.length} blocks)`);
for (const [index, block] of systemPrompt.entries()) {
	console.log(`  block ${index}: ${tok(block)} tok — ${block.slice(0, 60).replace(/\n/g, " ")}`);
}

// Per top-level section of the first block (the template).
const template = systemPrompt[0] ?? "";
const sections: Array<{ name: string; start: number }> = [];
const headerRe = /^([A-Z][A-Z &/]+)\n=+$/gm;
for (const match of template.matchAll(headerRe)) {
	sections.push({ name: match[1], start: match.index ?? 0 });
}
sections.unshift({ name: "(preamble)", start: 0 });
const rows = sections.map((section, index) => {
	const end = sections[index + 1]?.start ?? template.length;
	return { name: section.name, tokens: tok(template.slice(section.start, end)) };
});
console.log("\nSections (tokens):");
for (const row of rows.sort((a, b) => b.tokens - a.tokens))
	console.log(`  ${String(row.tokens).padStart(6)}  ${row.name}`);

// Tool definitions as sent to the provider.
let toolTotal = 0;
const toolRows: Array<{ name: string; tokens: number }> = [];
for (const [name, meta] of metadata) {
	const size = tok(String(meta.description ?? "")) + tok(String(JSON.stringify(meta.parameters ?? {}) ?? ""));
	toolTotal += size;
	toolRows.push({ name, tokens: size });
}
console.log(`\nTools: ${metadata.size} definitions ≈ ${toolTotal} tokens`);
for (const row of toolRows.sort((a, b) => b.tokens - a.tokens).slice(0, 20))
	console.log(`  ${String(row.tokens).padStart(6)}  ${row.name}`);

const contextTotal = contextFiles.reduce((sum, file) => sum + tok(file.content), 0);
console.log(`\nContext files: ${contextFiles.length} ≈ ${contextTotal} tokens`);
for (const file of contextFiles) console.log(`  ${String(tok(file.content)).padStart(6)}  ${file.path}`);

const skillsListing = skills.map(skill => `- ${skill.name}: ${skill.description}`).join("\n");
console.log(`\nSkills listing: ${skills.length} skills ≈ ${tok(skillsListing)} tokens`);
for (const skill of [...skills].sort((a, b) => b.description.length - a.description.length).slice(0, 12)) {
	console.log(`  ${String(tok(`- ${skill.name}: ${skill.description}`)).padStart(6)}  ${skill.name}`);
}
