import { beforeAll, describe, expect, type Mock, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

type Spy = Mock<(...args: unknown[]) => unknown>;

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelSelector tests");
	}
	setThemeInstance(testTheme);
}

function renderText(selector: ModelSelectorComponent, width = 220): string {
	return stripVTControlCharacters(selector.render(width).join("\n"));
}

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		baseUrl: "https://example.com",
		reasoning: false,
		provider,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

interface MenuHarness {
	selector: ModelSelectorComponent;
	onCancel: Spy;
	backgroundRefresh: Promise<void>;
}

// A non-temporary selector: Enter opens the action menu (role step) instead of
// selecting a model directly, which is the surface the Left-back gesture targets.
function createMenuSelector(models: Model[]): MenuHarness {
	const model = models[0];
	if (!model) {
		throw new Error("createMenuSelector requires at least one model");
	}
	const settings = Settings.isolated({ modelRoles: { default: `${model.provider}/${model.id}` } });
	const refreshGate = Promise.withResolvers<void>();
	const modelRegistry = {
		getAll: () => models,
		refresh: vi.fn(() => refreshGate.promise),
		refreshProvider: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => models,
		getDiscoverableProviders: () => [],
	} as unknown as ModelRegistry;
	const ui = {
		requestRender: vi.fn(),
	} as unknown as TUI;
	const onCancel: Spy = vi.fn();
	const selector = new ModelSelectorComponent(ui, undefined, settings, modelRegistry, [], () => {}, onCancel, {});
	refreshGate.resolve();
	const backgroundRefresh = refreshGate.promise
		.then(() => Promise.resolve())
		.then(() => Promise.resolve())
		.then(() => Promise.resolve());
	return { selector, onCancel, backgroundRefresh };
}

describe("ModelSelector menu Left/Escape back navigation", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelSelector tests");
		}
	});

	test("Left steps thinking → role → list without cancelling the selector", async () => {
		installTestTheme();
		const { selector, onCancel, backgroundRefresh } = createMenuSelector([makeModel("anthropic", "model-a")]);
		await backgroundRefresh;
		installTestTheme();

		expect(renderText(selector)).not.toContain("Action for:");

		selector.handleInput("\n"); // open the action menu (role step)
		expect(renderText(selector)).toContain("Action for:");

		selector.handleInput("\n"); // step into the thinking-level list
		expect(renderText(selector)).toContain("Thinking for:");

		selector.handleInput("\x1b[D"); // Left: thinking → role
		const backToRole = renderText(selector);
		expect(backToRole).toContain("Action for:");
		expect(backToRole).not.toContain("Thinking for:");

		selector.handleInput("\x1b[D"); // Left: role → close menu (back to the list)
		expect(renderText(selector)).not.toContain("Action for:");
		expect(onCancel).not.toHaveBeenCalled();
	});

	test("Escape steps thinking → role → list identically to Left", async () => {
		installTestTheme();
		const { selector, onCancel, backgroundRefresh } = createMenuSelector([makeModel("anthropic", "model-a")]);
		await backgroundRefresh;
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\n");
		expect(renderText(selector)).toContain("Thinking for:");

		selector.handleInput("\x1b"); // Escape: thinking → role
		const backToRole = renderText(selector);
		expect(backToRole).toContain("Action for:");
		expect(backToRole).not.toContain("Thinking for:");

		selector.handleInput("\x1b"); // Escape: role → close menu
		expect(renderText(selector)).not.toContain("Action for:");
		expect(onCancel).not.toHaveBeenCalled();
	});

	test("Left at the model list navigates instead of cancelling the selector", async () => {
		installTestTheme();
		const { selector, onCancel, backgroundRefresh } = createMenuSelector([
			makeModel("anthropic", "model-a"),
			makeModel("openrouter", "model-b"),
		]);
		await backgroundRefresh;
		installTestTheme();

		const beforeLeft = renderText(selector);
		expect(beforeLeft).toContain("anthropic/model-a");
		expect(beforeLeft).toContain("openrouter/model-b");

		selector.handleInput("\x1b[D"); // Left cycles ALL → OPENROUTER
		const afterLeft = renderText(selector);

		expect(afterLeft).not.toEqual(beforeLeft);
		expect(afterLeft).toContain("OPENROUTER");
		expect(afterLeft).toContain("model-b");
		expect(afterLeft).not.toContain("model-a");
		expect(afterLeft).not.toContain("Action for:");
		expect(onCancel).not.toHaveBeenCalled();
	});
});
