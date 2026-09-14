import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ComputerAction, ToolExample } from "@oh-my-pi/pi-ai";
import type { Viewport } from "puppeteer-core";
import browserUseDescription from "../prompts/tools/browser-use.md" with { type: "text" };
import screenshotReviewNotice from "../prompts/tools/browser-use-screenshot-notice.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { resolveBrowserKind } from "./browser";
import { acquireBrowser } from "./browser/registry";
import { acquireTab, releaseTab, runInTab, type TabSession } from "./browser/tab-supervisor";
import { resolveToCwd } from "./path-utils";
import { ToolAbortError } from "./tool-errors";

// deviceScaleFactor 1 keeps screenshot pixels == viewport CSS pixels so model coordinates map 1:1.
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 } as const;
const VIEWPORTS: Record<"desktop" | "mobile" | "mobile-landscape", Viewport> = {
	desktop: VIEWPORT,
	mobile: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: false },
	"mobile-landscape": {
		width: 844,
		height: 390,
		deviceScaleFactor: 1,
		isMobile: true,
		hasTouch: true,
		isLandscape: true,
	},
};
const ACTION_TYPES = [
	"navigate",
	"click",
	"double_click",
	"drag",
	"keypress",
	"move",
	"scroll",
	"type",
	"wait",
	"screenshot",
] as const;
const pointSchema = type({ x: "number", y: "number" });
const actionSchema = type({
	type: "'navigate' | 'click' | 'double_click' | 'drag' | 'keypress' | 'move' | 'scroll' | 'type' | 'wait' | 'screenshot'",
	"url?": "string",
	"x?": "number",
	"y?": "number",
	"button?": "'left' | 'right' | 'wheel' | 'back' | 'forward'",
	"keys?": "string[]",
	"text?": "string",
	"scroll_x?": "number",
	"scroll_y?": "number",
	"path?": pointSchema.array(),
	"save?": type("string").describe(
		"screenshot only: also write this capture to a file path (relative to cwd). Use sparingly — only states needed as PR/MR or handoff evidence",
	),
});
const nativeComputerSchema = type({
	"url?": type("string").describe("Open this URL in the browser_use tab before running actions"),
	"viewport?": type("'desktop' | 'mobile' | 'mobile-landscape'").describe(
		"Viewport preset: desktop 1280x720 (default), mobile 390x844, mobile-landscape 844x390. Mobile presets enable mobile layout and touch-capability flags; pointer actions remain mouse/wheel input. Omit to retain the current viewport.",
	),
	"actions?": actionSchema
		.array()
		.describe(
			"Ordered screen actions in current viewport pixels. navigate: {url}; click/double_click/move: {x,y}; scroll: {x,y,scroll_x,scroll_y}; drag: {path:[{x,y},...]}; keypress: {keys:['Enter']} or {keys:['Control','a']} (modifiers are held while the other keys are pressed; aliases like CTRL/CMD/ENTER accepted); type: {text}; wait; screenshot ({save?} writes that capture to a file). A screenshot is returned after the last action. Any other type fails the call.",
		),
	"pending_safety_checks?": type("unknown[]").describe("Safety checks requiring explicit approval"),
	"+": "reject",
});
type NativeComputerInput = typeof nativeComputerSchema.infer;

type NativeDetails = {
	actionCount: number;
	url?: string;
	viewport: Viewport;
	screenshot?: string;
	savedPaths?: string[];
	rejected?: boolean;
};

/** Native OpenAI actions plus the tool-local `navigate` (headless Chromium has no address bar). */
type BrowserUseAction = ComputerAction | { type: "navigate"; url: string };

function actionList(input: NativeComputerInput): BrowserUseAction[] {
	return (input.actions ?? []) as BrowserUseAction[];
}

function actionCode(action: BrowserUseAction): string {
	const a = JSON.stringify(action);
	const supported = JSON.stringify(ACTION_TYPES.join(", "));
	return `(async()=>{const a=${a};switch(a.type){case "navigate":if(typeof a.url!=="string"||!a.url)throw new Error("navigate requires {url}");await tab.goto(a.url,{waitUntil:"domcontentloaded"});break;case "click":await page.mouse.click(a.x,a.y,{button:a.button});break;case "double_click":await page.mouse.click(a.x,a.y,{clickCount:2});break;case "drag":{const p=a.path;if(!p.length)break;await page.mouse.move(p[0].x,p[0].y);await page.mouse.down();for(const q of p.slice(1))await page.mouse.move(q.x,q.y);await page.mouse.up();break;}case "keypress":{const m={ctrl:"Control",control:"Control",cmd:"Meta",command:"Meta",meta:"Meta",super:"Meta",win:"Meta",alt:"Alt",option:"Alt",shift:"Shift",enter:"Enter",return:"Enter",esc:"Escape",escape:"Escape",space:"Space",tab:"Tab",backspace:"Backspace",delete:"Delete",del:"Delete",up:"ArrowUp",down:"ArrowDown",left:"ArrowLeft",right:"ArrowRight",arrowup:"ArrowUp",arrowdown:"ArrowDown",arrowleft:"ArrowLeft",arrowright:"ArrowRight",pageup:"PageUp",pagedown:"PageDown",home:"Home",end:"End"};const ks=a.keys.map(k=>{const l=String(k).toLowerCase();if(m[l])return m[l];if(/^fd{1,2}$/.test(l))return l.toUpperCase();return k.length===1?k:k[0].toUpperCase()+k.slice(1)});const mods=new Set(["Control","Meta","Alt","Shift"]);const held=ks.filter(k=>mods.has(k));const main=ks.filter(k=>!mods.has(k));for(const k of held)await page.keyboard.down(k);try{for(const k of main)await page.keyboard.press(k);}finally{for(const k of held.reverse())await page.keyboard.up(k);}break;}case "move":await page.mouse.move(a.x,a.y);break;case "scroll":await page.mouse.move(a.x,a.y);await page.mouse.wheel({deltaX:a.scroll_x,deltaY:a.scroll_y});break;case "type":await page.keyboard.type(a.text);break;case "wait":await new Promise(r=>setTimeout(r,500));break;case "screenshot":break;default:throw new Error("Unknown action type "+JSON.stringify(a.type)+". Supported: "+${supported}+". To open a page pass top-level {url} or {type:\\"navigate\\",url}.");}return {__shot:await page.screenshot({type:"jpeg",quality:80,encoding:"base64"})};})()`;
}

export class NativeBrowserComputerTool implements AgentTool<typeof nativeComputerSchema, NativeDetails> {
	readonly name = "browser_use";
	readonly label = "Browser Use";
	readonly loadMode = "essential" as const;
	readonly concurrency = "exclusive" as const;
	readonly summary = "Control browser viewport with OpenAI Computer Use actions";
	readonly strict = true;
	readonly native = { type: "computer" } as const;
	readonly approval = "exec" as const;
	readonly parameters = nativeComputerSchema;
	readonly examples: readonly ToolExample<NativeComputerInput>[] = [];
	#tab?: TabSession;
	#viewport: Viewport = VIEWPORT;
	#reviewNoticeShown = false;
	#queue = Promise.resolve();
	constructor(readonly session: ToolSession) {}
	get description(): string {
		return browserUseDescription.trim();
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
				const viewport = input.viewport ? VIEWPORTS[input.viewport] : this.#viewport;
				const created = !this.#tab;
				if (!this.#tab) {
					const browser = await acquireBrowser(resolveBrowserKind({ action: "open" } as never, this.session), {
						cwd: this.session.cwd,
						signal,
					});
					this.#tab = (
						await acquireTab("browser_use", browser, {
							viewport,
							timeoutMs: 30_000,
							ownerSessionId: this.session.getSessionId?.() ?? undefined,
						})
					).tab;
				}
				if (created || viewport !== this.#viewport) {
					await runInTab("browser_use", {
						code: `await page.setViewport(${JSON.stringify(viewport)});`,
						timeoutMs: 30_000,
						signal,
						session: this.session,
					});
					this.#viewport = viewport;
				}
				if (typeof input.url === "string" && input.url.length > 0) {
					await runInTab("browser_use", {
						code: `await tab.goto(${JSON.stringify(input.url)}, { waitUntil: "domcontentloaded" }); return tab.url();`,
						timeoutMs: 30_000,
						signal,
						session: this.session,
					});
				}
				let screenshot = "";
				let screenshotMimeType = "image/png";
				const savedPaths: string[] = [];
				for (const action of actions) {
					const result = await runInTab("browser_use", {
						code: actionCode(action),
						timeoutMs: 30_000,
						signal,
						session: this.session,
					});
					// Raw viewport PNG via page.screenshot: tab.screenshot() downsizes to
					// 1024px, which would break the 1:1 pixel-to-coordinate contract.
					const shot = (result.returnValue as { __shot?: string } | undefined)?.__shot;
					if (typeof shot === "string" && shot.length > 0) {
						screenshotMimeType = "image/jpeg";
						screenshot = `data:image/jpeg;base64,${shot}`;
						// Disk writes are opt-in per screenshot action; nothing is persisted otherwise.
						const save = (action as { save?: string }).save;
						if (action.type === "screenshot" && typeof save === "string" && save.length > 0) {
							const dest = resolveToCwd(save, this.session.cwd);
							await Bun.write(dest, Buffer.from(shot, "base64"));
							savedPaths.push(dest);
						}
					}
				}
				const url = this.#tab.info.url;
				// The first screenshot of a session carries the UI/UX review checklist in-band:
				// a system-prompt rule alone was ignored, a notice next to the image is not.
				const reviewNotice = screenshot && !this.#reviewNoticeShown ? `\n\n${screenshotReviewNotice.trim()}` : "";
				if (reviewNotice) this.#reviewNoticeShown = true;
				return {
					content: [
						{
							type: "text",
							text: `Browser computer action complete. URL: ${url}${savedPaths.length ? `\nSaved screenshots:\n${savedPaths.map(p => `- ${p}`).join("\n")}` : ""}${reviewNotice}`,
						},
						...(screenshot
							? [{ type: "image", data: screenshot.split(",", 2)[1], mimeType: screenshotMimeType } as const]
							: []),
					],
					details: { actionCount: actions.length, url, viewport: this.#viewport, screenshot, savedPaths },
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
					details: { actionCount: actions.length, viewport: this.#viewport },
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
