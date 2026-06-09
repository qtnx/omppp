/**
 * Regression guard for the cwd-keyed branch cache in
 * `StatusLineComponent.#getCurrentBranch`.
 *
 * Before: `#getCurrentBranch` called `git.head.resolveSync` on every read to
 * compute its cache key, and `event-controller.handleEvent` invalidated the
 * cache on every agent event — so each streaming delta paid an uncached sync
 * FS tree-walk (statSync up to the git root + HEAD/commondir reads). Each
 * top-border build reads the branch twice (status segment + PR lookup), so the
 * cost compounded.
 *
 * After: the branch is keyed by cwd. While cwd is unchanged the sync resolver
 * is skipped entirely; the HEAD fs.watch and explicit invalidate() are the only
 * things that force a re-resolve.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/status-line";
import { initTheme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";
import * as git from "../src/utils/git";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession(): AgentSession {
	return {
		messages: [{ role: "user", content: "hi" }],
		systemPrompt: ["You are a helpful assistant."],
		agent: { state: { tools: [] } },
		skills: [],
		model: { id: "test-model", contextWindow: 200_000 },
		state: { model: { id: "test-model", contextWindow: 200_000 }, messages: [] },
		settings: { getGroup: () => ({ enabled: false, strategy: "off" }) },
		getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
		getAsyncJobSnapshot: () => null,
	} as unknown as AgentSession;
}

/** Spy the sync HEAD resolver (returning null avoids the PR/default-branch
 * async paths) and stub the async git-status fetch so no real subprocess runs. */
function stubGit() {
	const resolveSync = vi.spyOn(git.head, "resolveSync").mockReturnValue(null);
	vi.spyOn(git.status, "summary").mockResolvedValue(null);
	return resolveSync;
}

/** Construct the component with no rendered segments so the test exercises
 * branch resolution (#getCurrentBranch runs in #buildSegmentContext) without
 * dragging in every segment renderer's session dependencies. */
function makeComp(): StatusLineComponent {
	const comp = new StatusLineComponent(makeSession());
	comp.updateSettings({ preset: "custom", leftSegments: [], rightSegments: [], segmentOptions: {} });
	return comp;
}

describe("StatusLineComponent branch resolution caching", () => {
	it("resolves the branch once across repeated top-border builds", () => {
		const resolveSync = stubGit();
		const comp = makeComp();

		comp.getTopBorder(120);
		comp.getTopBorder(120);

		// Two builds × two reads each (status segment + PR lookup) collapse to a
		// single sync resolve via the cwd-keyed cache.
		expect(resolveSync).toHaveBeenCalledTimes(1);
	});

	it("re-resolves after invalidate() (HEAD watcher / cwd-change path)", () => {
		const resolveSync = stubGit();
		const comp = makeComp();

		comp.getTopBorder(120);
		expect(resolveSync).toHaveBeenCalledTimes(1);

		comp.invalidate();
		comp.getTopBorder(120);
		expect(resolveSync).toHaveBeenCalledTimes(2);
	});
});
