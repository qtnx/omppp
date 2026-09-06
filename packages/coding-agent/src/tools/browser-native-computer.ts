import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ComputerAction, ToolExample } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../sdk";
import { resolveBrowserKind } from "./browser";
import { acquireBrowser } from "./browser/registry";
import { acquireTab, releaseTab, runInTab, type TabSession } from "./browser/tab-supervisor";
import { ToolAbortError } from "./tool-errors";

const VIEWPORT = { width: 1280, height: 720 } as const;
const nativeComputerSchema = type({
	"actions?": type("unknown[]").describe("OpenAI computer actions"),
	"action?": type("unknown").describe("OpenAI computer action"),
	"pending_safety_checks?": type("unknown[]").describe("Safety checks requiring explicit approval"),
	"call_id?": type("string"),
	"+": "reject",
});
type NativeComputerInput = typeof nativeComputerSchema.infer;

type NativeDetails = {
	actionCount: number;
	url?: string;
	viewport: typeof VIEWPORT;
	screenshot?: string;
	rejected?: boolean;
};

function actionList(input: NativeComputerInput): ComputerAction[] {
	const values = [...(Array.isArray(input.actions) ? input.actions : []), ...(input.action ? [input.action] : [])];
	return values as ComputerAction[];
}

function actionCode(action: ComputerAction): string {
	const a = JSON.stringify(action);
	return `(async()=>{const a=${a};switch(a.type){case "click":await page.mouse.click(a.x,a.y,{button:a.button});break;case "double_click":await page.mouse.click(a.x,a.y,{clickCount:2});break;case "drag":{const p=a.path;if(!p.length)break;await page.mouse.move(p[0].x,p[0].y);await page.mouse.down();for(const q of p.slice(1))await page.mouse.move(q.x,q.y);await page.mouse.up();break;}case "keypress":await page.keyboard.press(a.keys.join("+"));break;case "move":await page.mouse.move(a.x,a.y);break;case "scroll":await page.mouse.move(a.x,a.y);await page.mouse.wheel({deltaX:a.scroll_x,deltaY:a.scroll_y});break;case "type":await page.keyboard.type(a.text);break;case "wait":await new Promise(r=>setTimeout(r,500));break;case "screenshot":break;}return await tab.screenshot();})()`;
}

export class NativeBrowserComputerTool implements AgentTool<typeof nativeComputerSchema, NativeDetails> {
	readonly name = "computer";
	readonly label = "Browser Computer";
	readonly loadMode = "essential" as const;
	readonly concurrency = "exclusive" as const;
	readonly summary = "Control browser viewport with OpenAI Computer Use actions";
	readonly strict = true;
	readonly native = { type: "computer" } as const;
	readonly approval = "exec" as const;
	readonly parameters = nativeComputerSchema;
	readonly examples: readonly ToolExample<NativeComputerInput>[] = [];
	#tab?: TabSession;
	#queue = Promise.resolve();
	constructor(readonly session: ToolSession) {}
	get description(): string {
		return "OpenAI Computer Use browser mode. Fixed 1280x720 browser viewport. DOM browser tool remains available; native actions use the exclusive computer tab.";
	}
	async execute(
		_callId: string,
		input: NativeComputerInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<NativeDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<NativeDetails>> {
		const run = async (): Promise<AgentToolResult<NativeDetails>> => {
			if (signal?.aborted) throw new ToolAbortError();
			const checks = Array.isArray(input.pending_safety_checks) ? input.pending_safety_checks : [];
			if (checks.length > 0)
				return {
					content: [
						{ type: "text", text: "Computer action rejected: pending safety checks require explicit approval." },
					],
					isError: true,
					details: { actionCount: 0, viewport: VIEWPORT, rejected: true },
				};
			const nativeMetadata = _ctx?.toolCall?.providerMetadata;
			const actions = nativeMetadata?.type === "computer" ? [...nativeMetadata.actions] : actionList(input);
			if (actions.length === 0) actions.push({ type: "screenshot" });
			try {
				if (!this.#tab) {
					const browser = await acquireBrowser(resolveBrowserKind({ action: "open" } as never, this.session), {
						cwd: this.session.cwd,
						signal,
					});
					this.#tab = (
						await acquireTab("computer", browser, {
							viewport: VIEWPORT,
							timeoutMs: 30_000,
							ownerSessionId: this.session.getSessionId?.() ?? undefined,
						})
					).tab;
				}
				let screenshot = "";
				let screenshotMimeType = "image/png";
				for (const action of actions) {
					const result = await runInTab("computer", {
						code: actionCode(action),
						timeoutMs: 30_000,
						signal,
						session: this.session,
					});
					const image = result.displays.find(
						(item): item is { type: "image"; data: string; mimeType: string } => item.type === "image",
					);
					if (image) {
						screenshotMimeType = image.mimeType;
						screenshot = `data:${image.mimeType};base64,${image.data}`;
					}
				}
				const url = this.#tab.info.url;
				return {
					content: [
						{ type: "text", text: `Browser computer action complete. URL: ${url}` },
						...(screenshot
							? [{ type: "image", data: screenshot.split(",", 2)[1], mimeType: screenshotMimeType } as const]
							: []),
					],
					details: { actionCount: actions.length, url, viewport: VIEWPORT, screenshot },
					providerMetadata: {
						type: "computer",
						screenshot: { type: "computer_screenshot", image_url: screenshot },
						acknowledgedSafetyChecks: [],
					},
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Browser computer action failed: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
					details: { actionCount: actions.length, viewport: VIEWPORT },
				};
			}
		};
		const next = this.#queue.then(run, run);
		this.#queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
	async close(): Promise<void> {
		if (this.#tab) await releaseTab(this.#tab.name);
		this.#tab = undefined;
	}
}

export { VIEWPORT as NATIVE_BROWSER_VIEWPORT };
