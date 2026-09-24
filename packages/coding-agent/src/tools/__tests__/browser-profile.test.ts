import { describe, expect, test } from "bun:test";
import { Settings } from "../../config/settings";
import { normalizeBrowserProfile, resolveBrowserKind } from "../browser";
import { browserKey } from "../browser/registry";
import { sharedBrowserDaemonName } from "../browser/shared-daemon";
import type { ToolSession } from "../index";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const session = {
	cwd: "/tmp/test",
	settings: Settings.isolated({ "browser.enabled": true, "browser.headless": true, "browser.cmux": false }),
} as ToolSession;

describe("normalizeBrowserProfile", () => {
	test("lowercases a usable name, treats blank as absent, and rejects unsafe characters", () => {
		expect(normalizeBrowserProfile("Acct-A")).toBe("acct-a");
		expect(normalizeBrowserProfile("  ")).toBeUndefined();
		expect(normalizeBrowserProfile(undefined)).toBeUndefined();
		expect(() => normalizeBrowserProfile("../etc")).toThrow(ToolError);
		expect(() => normalizeBrowserProfile("a".repeat(41))).toThrow(ToolError);
	});
});

describe("browser session isolation", () => {
	test("each profile name is a distinct browser, and fresh is not part of that identity", () => {
		const a = resolveBrowserKind({ action: "open", profile: "acct-a" } as never, session);
		const b = resolveBrowserKind({ action: "open", profile: "acct-b" } as never, session);
		const aFresh = resolveBrowserKind({ action: "open", profile: "acct-a", fresh: true } as never, session);
		const plain = resolveBrowserKind({ action: "open" } as never, session);

		expect(browserKey(a)).not.toBe(browserKey(b));
		expect(browserKey(a)).not.toBe(browserKey(plain));
		// Same profile with `fresh` must reuse the same browser slot, otherwise a
		// second open would leak a parallel Chromium on the same profile directory.
		expect(browserKey(aFresh)).toBe(browserKey(a));
	});

	test("a named profile gets its own shared-browser daemon", () => {
		expect(sharedBrowserDaemonName(true)).toBe("omp.browser.headless");
		expect(sharedBrowserDaemonName(true, "acct-a")).toBe("omp.browser.headless.p-acct-a");
		expect(sharedBrowserDaemonName(false, "acct-a")).toBe("omp.browser.headed.p-acct-a");
	});
});
