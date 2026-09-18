import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import browserJevDescription from "../prompts/tools/browser-jev.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { normalizeBrowserProfile, resolveBrowserKind } from "./browser";
import { acquireBrowser } from "./browser/registry";
import { acquireTab, releaseTab, runInTab, type TabSession } from "./browser/tab-supervisor";
import { clampTimeout } from "./tool-timeouts";
import { ToolAbortError, ToolError } from "./tool-errors";

const VIEWPORTS: Record<string, { width: number; height: number; isMobile: boolean; hasTouch: boolean }> = {
	desktop: { width: 1280, height: 720, isMobile: false, hasTouch: false },
	tablet: { width: 834, height: 1112, isMobile: true, hasTouch: true },
	mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
	"mobile-landscape": { width: 844, height: 390, isMobile: true, hasTouch: true },
};

/** Dedicated tab name so a Jev run never fights the `main` or `browser_use` tab. */
const JEV_TAB = "jev";
const PAGE_TEXT_CAP = 4000;
const DEFAULT_TIMEOUT_SEC = 300;

const browserJevSchema = type({
	goal: type("string>0").describe(
		"Everything the flow must accomplish plus every literal value it needs (search terms, field values, which result to open). A value the goal omits is never invented.",
	),
	"url?": type("string").describe("Navigate the Jev tab here first; omit to continue where the last call ended"),
	"max_steps?": type("number").describe("Action ceiling before the run stops (default 30)"),
	"viewport?": type("'desktop' | 'tablet' | 'mobile' | 'mobile-landscape'").describe(
		"Viewport preset for this run: desktop 1280x720, tablet 834x1112, mobile 390x844, mobile-landscape 844x390. Mobile and tablet presets enable touch-capability flags; use them to test responsive behaviour.",
	),
	"review?": type("boolean").describe("Run the UX/accessibility review of the finished flow (default true)"),
	"profile?": type("string").describe(
		"Named isolated browser session (own cookies/login) — use one name per account under test",
	),
	"fresh?": type("boolean").describe("Discard the named profile's stored state before this run"),
	"close?": type("boolean").describe("Release the Jev tab after this run"),
	"timeout?": type("number").describe("Timeout in seconds (default 300)"),
	"+": "reject",
});

export type BrowserJevParams = typeof browserJevSchema.infer;

export interface JevStepReport {
	step: number;
	operation: string;
	target?: { id: number; role: string; name?: string };
	/** DRAG only: the element the source was dropped onto. */
	dropTarget?: { id: number; role: string; name?: string };
	text?: string;
	/** Set when the rescue helper chose this action; holds its one-line reason. */
	rescue?: string;
	pageChanged: boolean;
	url: string;
}

export interface JevRunReport {
	status: "done" | "blocked" | "max_steps";
	steps: JevStepReport[];
	url: string;
	title?: string;
	elapsedMs: number;
	pageText: string;
	rescues: number;
	reason?: string;
	shots: string[];
	review?: {
		summary: string;
		findings: Array<{ severity: string; area: string; finding: string; evidence: string }>;
		unavailable?: string;
	};
}

export interface BrowserJevDetails {
	/** Rescue turns this run spent on a stuck page. */
	rescues?: number;
	/** Saved screenshot paths in capture order. */
	shots?: string[];
	/** UX/accessibility review of the run, when one was produced. */
	review?: JevRunReport["review"];
	/** Named isolated browser session this run drove, when one was requested. */
	profile?: string;
	status?: JevRunReport["status"];
	stepCount: number;
	url?: string;
	title?: string;
	elapsedMs?: number;
	goal: string;
}

/**
 * Body for one Jev run inside the tab realm. `tab.act` is the whole loop, so
 * the tool sends a single run: navigate (optional), act, then read the final
 * page text — one round trip instead of one per action.
 */
export function jevRunCode(params: BrowserJevParams): string {
	const actOptions = JSON.stringify({
		...(params.max_steps === undefined ? {} : { maxSteps: params.max_steps }),
		...(params.review === undefined ? {} : { review: params.review }),
	});
	const preset = params.viewport === undefined ? undefined : VIEWPORTS[params.viewport];
	const viewport =
		preset === undefined
			? ""
			: `await page.setViewport({ width: ${preset.width}, height: ${preset.height}, isMobile: ${preset.isMobile}, hasTouch: ${preset.hasTouch} });\nawait Bun.sleep(300);\n`;
	const navigate =
		params.url === undefined || params.url.length === 0
			? ""
			: `await tab.goto(${JSON.stringify(params.url)}, { waitUntil: "domcontentloaded" });\n`;
	return (
		`${viewport}${navigate}const result = await tab.act(${JSON.stringify(params.goal)}, ${actOptions});\n` +
		`let pageText = "";\n` +
		`try { pageText = await tab.extract("text"); } catch { pageText = ""; }\n` +
		`return { ...result, pageText: pageText.slice(0, ${PAGE_TEXT_CAP}) };`
	);
}

function describeStep(step: JevStepReport): string {
	const describe = (part: { role: string; name?: string }): string =>
		`${part.role}${part.name ? ` ${JSON.stringify(part.name)}` : ""}`;
	const target = step.target ? ` ${describe(step.target)}` : "";
	const drop = step.dropTarget ? ` onto ${describe(step.dropTarget)}` : "";
	const typed = step.text === undefined ? "" : ` = ${JSON.stringify(step.text)}`;
	const changed = step.pageChanged ? "" : " (page unchanged)";
	const rescue = step.rescue ? ` [rescue: ${step.rescue}]` : "";
	return `${step.step}. ${step.operation}${target}${drop}${typed}${changed}${rescue}`;
}

export function renderJevReport(goal: string, report: JevRunReport): string {
	const lines = [
		`status: ${report.status} — ${report.steps.length} action(s) in ${(report.elapsedMs / 1000).toFixed(1)}s`,
		`goal: ${goal}`,
		`url: ${report.url}`,
	];
	if (report.title) lines.push(`title: ${report.title}`);
	if (report.rescues > 0) {
		lines.push(`rescue turns: ${report.rescues} (helper model cleared or inspected a stuck page)`);
	}
	if (report.steps.length > 0) lines.push("", "steps:", ...report.steps.map(describeStep));
	if (report.status === "blocked") {
		lines.push(
			"",
			report.reason
				? `Blocked after a rescue turn: ${report.reason}`
				: "Jev found no supported operation for the remaining work.",
			"Handle that step with `browser_use` (canvas/gesture) or the `browser` prelude (selectors/JS), then hand the rest back.",
		);
	} else if (report.status === "max_steps") {
		lines.push(
			"",
			"The step budget ran out before the goal was satisfied. Re-run with the remaining work as the goal.",
		);
	}
	if (report.pageText.length > 0) lines.push("", "page text:", report.pageText);
	if (report.shots.length > 0) {
		lines.push("", "screenshots (view them when the run is a visual or responsive claim):");
		for (const shot of report.shots) lines.push(`- ${shot}`);
	}
	if (report.review) {
		lines.push("", "review:");
		if (report.review.unavailable) {
			lines.push(`- unavailable: ${report.review.unavailable}`);
		} else {
			if (report.review.summary) lines.push(report.review.summary);
			for (const finding of report.review.findings) {
				lines.push(`- [${finding.severity}/${finding.area}] ${finding.finding} — evidence: ${finding.evidence}`);
			}
			if (report.review.findings.length === 0) lines.push("- no findings");
		}
	}
	return lines.join("\n");
}

function parseReport(value: unknown): JevRunReport {
	if (
		!value ||
		typeof value !== "object" ||
		!("status" in value) ||
		!("steps" in value) ||
		!Array.isArray(value.steps) ||
		!("url" in value) ||
		typeof value.url !== "string"
	) {
		throw new ToolError("browser_jev: the Jev run returned no usable result");
	}
	// Shape is produced by runJevAct in this same process; the guards above cover
	// a wedged tab returning something else entirely.
	return value as unknown as JevRunReport;
}

/**
 * Goal-in, outcome-out browser tool: the Jev policy plus a small text-helper
 * model finish the flow, and the calling model reads one text report instead of
 * driving clicks through screenshots.
 */
export class BrowserJevTool implements AgentTool<typeof browserJevSchema, BrowserJevDetails> {
	readonly name = "browser_jev";
	readonly label = "Browser Jev";
	readonly loadMode = "essential" as const;
	readonly concurrency = "exclusive" as const;
	readonly summary = "Complete a browser goal with the Jev DOM policy and return the outcome as text";
	readonly approval = "exec" as const;
	readonly description = browserJevDescription.trim();
	readonly parameters = browserJevSchema;
	readonly interruptible = true;
	/** One live tab per profile, so several accounts can be driven side by side. */
	readonly #tabs = new Map<string, TabSession>();

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		rawArgs: unknown,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserJevDetails>> {
		const params = browserJevSchema(rawArgs);
		if (params instanceof type.errors) {
			throw new ToolError(`browser_jev received invalid arguments: ${params.summary}`);
		}
		if (signal?.aborted) throw new ToolAbortError();
		const timeoutMs =
			clampTimeout(
				"browser_jev",
				params.timeout ?? DEFAULT_TIMEOUT_SEC,
				this.session.settings.get("tools.maxTimeout"),
			) * 1000;
		const profile = normalizeBrowserProfile(params.profile);
		const tabName = profile ? `${JEV_TAB}-${profile}` : JEV_TAB;
		const details: BrowserJevDetails = { stepCount: 0, goal: params.goal, profile };
		try {
			if (!this.#tabs.has(tabName)) {
				const kind = resolveBrowserKind({ action: "open", profile, fresh: params.fresh } as never, this.session);
				const browser = await acquireBrowser(kind, { cwd: this.session.cwd, signal });
				const acquired = await acquireTab(tabName, browser, {
					timeoutMs,
					signal,
					ownerSessionId: this.session.getSessionId?.() ?? undefined,
				});
				this.#tabs.set(tabName, acquired.tab);
			}
			const run = await runInTab(tabName, {
				code: jevRunCode(params),
				timeoutMs,
				signal,
				session: this.session,
			});
			const report = parseReport(run.returnValue);
			details.status = report.status;
			details.stepCount = report.steps.length;
			details.url = report.url;
			details.title = report.title;
			details.elapsedMs = report.elapsedMs;
			details.rescues = report.rescues;
			details.shots = report.shots;
			details.review = report.review;
			return {
				content: [{ type: "text", text: renderJevReport(params.goal, report) }],
				details,
				isError: report.status !== "done",
			};
		} finally {
			if (params.close) {
				await releaseTab(tabName).catch(() => undefined);
				this.#tabs.delete(tabName);
			}
		}
	}

	async close(): Promise<void> {
		const names = [...this.#tabs.keys()];
		this.#tabs.clear();
		for (const name of names) await releaseTab(name).catch(() => undefined);
	}
}
