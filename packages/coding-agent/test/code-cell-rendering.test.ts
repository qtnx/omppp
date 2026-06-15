import { afterEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderCodeCell } from "@oh-my-pi/pi-coding-agent/tui/code-cell";

const originalDisableSyntaxHighlight = Bun.env.OMP_DISABLE_SYNTAX_HIGHLIGHT;

function restoreDisableSyntaxHighlightEnv(): void {
	if (originalDisableSyntaxHighlight === undefined) {
		delete Bun.env.OMP_DISABLE_SYNTAX_HIGHLIGHT;
	} else {
		Bun.env.OMP_DISABLE_SYNTAX_HIGHLIGHT = originalDisableSyntaxHighlight;
	}
}

async function initRenderTest(overrides: Partial<Record<SettingPath, unknown>> = {}): Promise<void> {
	restoreDisableSyntaxHighlightEnv();
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides });
	await initTheme(false, undefined, undefined, "dark", "light");
}

describe("renderCodeCell", () => {
	afterEach(() => {
		restoreDisableSyntaxHighlightEnv();
		resetSettingsForTest();
	});

	it("skips native syntax highlighting while a code preview is still running", async () => {
		await initRenderTest();

		const rendered = renderCodeCell(
			{
				code: "const answer = 42;",
				language: "typescript",
				status: "running",
				width: 100,
			},
			theme,
		).join("\n");

		expect(rendered).not.toContain(theme.getFgAnsi("syntaxKeyword"));
		expect(Bun.stripANSI(rendered)).toContain("const answer = 42;");
	});

	it("keeps native syntax highlighting for completed code previews", async () => {
		await initRenderTest();

		const rendered = renderCodeCell(
			{
				code: "const answer = 42;",
				language: "typescript",
				status: "complete",
				width: 100,
			},
			theme,
		).join("\n");

		expect(rendered).toContain(theme.getFgAnsi("syntaxKeyword"));
		expect(Bun.stripANSI(rendered)).toContain("const answer = 42;");
	});

	it("disables syntax highlighting for completed code previews in off mode", async () => {
		const overrides = Object.fromEntries([["display.syntaxHighlighting", "off"]]) as Partial<
			Record<SettingPath, unknown>
		>;
		await initRenderTest(overrides);

		const rendered = renderCodeCell(
			{
				code: "const answer = 42;",
				language: "typescript",
				status: "complete",
				width: 100,
			},
			theme,
		).join("\n");

		expect(rendered).not.toContain(theme.getFgAnsi("syntaxKeyword"));
		expect(Bun.stripANSI(rendered)).toContain("const answer = 42;");
	});

	it("uses lightweight syntax highlighting for completed code previews in basic mode", async () => {
		const overrides = Object.fromEntries([["display.syntaxHighlighting", "basic"]]) as Partial<
			Record<SettingPath, unknown>
		>;
		await initRenderTest(overrides);

		const rendered = renderCodeCell(
			{
				code: "const answer = 42;",
				language: "typescript",
				status: "complete",
				width: 100,
			},
			theme,
		).join("\n");

		expect(rendered).toContain(theme.getFgAnsi("syntaxKeyword"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxNumber"));
		expect(rendered).not.toContain(theme.getFgAnsi("syntaxPunctuation"));
		expect(Bun.stripANSI(rendered)).toContain("const answer = 42;");
	});

	it("disables native syntax highlighting for completed code previews from the env kill switch", async () => {
		await initRenderTest();
		Bun.env.OMP_DISABLE_SYNTAX_HIGHLIGHT = "1";

		const rendered = renderCodeCell(
			{
				code: "const answer = 42;",
				language: "typescript",
				status: "complete",
				width: 100,
			},
			theme,
		).join("\n");

		expect(rendered).not.toContain(theme.getFgAnsi("syntaxKeyword"));
		expect(Bun.stripANSI(rendered)).toContain("const answer = 42;");
	});
});
