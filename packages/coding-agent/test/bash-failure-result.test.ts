import { afterEach, describe, expect, it } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, formatMacOSSandboxDenialNotice } from "@oh-my-pi/pi-coding-agent/tools/bash";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const previousActiveSandbox = Bun.env.PI_OMPX_MACOS_SANDBOX_ACTIVE_INHERITED;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

function makeSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "bash.stripTrailingHeadTail") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "search.enabled") return false;
				if (key === "find.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

describe("BashTool non-zero exit", () => {
	afterEach(() => {
		restorePlatform();
		if (previousActiveSandbox === undefined) {
			delete Bun.env.PI_OMPX_MACOS_SANDBOX_ACTIVE_INHERITED;
		} else {
			Bun.env.PI_OMPX_MACOS_SANDBOX_ACTIVE_INHERITED = previousActiveSandbox;
		}
	});

	it("resolves with an error result carrying execution details instead of throwing", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-fail", { command: "exit 3" });

		// A completed command that failed is a non-throwing error result so the
		// renderer keeps the wall time / timeout / exit-code footer.
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(3);
		expect(result.details?.timeoutSeconds).toBe(300);
		expect(typeof result.details?.wallTimeMs).toBe("number");

		// The LLM-facing text still states the exit code verbatim.
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("Command exited with code 3");
	});

	it("adds a sandbox denial notice to failed command output when active", async () => {
		setPlatform("darwin");
		Bun.env.PI_OMPX_MACOS_SANDBOX_ACTIVE_INHERITED = "1";
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-sandbox-fail", {
			command: "printf '%s\\n' 'touch: /Users/alice/.ssh/key: Operation not permitted'; exit 1",
		});

		expect(result.isError).toBe(true);
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("macOS sandbox may have blocked this command");
		expect(text).toContain("restart the top-level OMPx process with --no-sandbox");
	});

	it("does not report sandbox denial text when the sandbox is inactive", () => {
		setPlatform("darwin");
		Bun.env.PI_OMPX_MACOS_SANDBOX_ACTIVE_INHERITED = "0";

		expect(formatMacOSSandboxDenialNotice("Operation not permitted")).toBeUndefined();
	});

	it("returns a success result with no exit-code detail for a zero exit", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-ok", { command: "printf hi" });

		expect(result.isError).toBeUndefined();
		expect(result.details?.exitCode).toBeUndefined();
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("hi");
		expect(text).not.toContain("Command exited with code");
	});
});
