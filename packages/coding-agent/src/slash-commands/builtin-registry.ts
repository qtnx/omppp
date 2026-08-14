import * as os from "node:os";
import { renderContextGcReport } from "@oh-my-pi/context-gc-plugin";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import {
	formatCrashReportPathLine,
	getAgentDbPath,
	listUnreadCrashArtifacts,
	logger,
	markCrashArtifactsSeen,
	sanitizeText,
} from "@oh-my-pi/pi-utils";
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "../collab/guest";
import { createProductPreviewCommand } from "../commands/product";
import type { SettingPath } from "../config/settings";
import type { DuoStatus } from "../duo";
import type { Skill } from "../extensibility/skills";
import { disableHerdrNotify, enableHerdrNotify, herdrNotifyStatus } from "../herdr/notify-optin";
import { isHerdrPane } from "../herdr/socket";
import { buildLearningDeveloperInstructions, clearLearningData, getLearningLogText } from "../learnings";
import * as learningConsolidation from "../learnings/consolidate";
import { resolveRepoKey } from "../learnings/repo-key";
import * as learningStorage from "../learnings/storage";
import { makeShareController, startPreviewServer } from "../product-preview";
import type { AgentSession } from "../session/agent-session";
import { BROWSER_ANNOTATION_MESSAGE_TYPE, MAX_BACKGROUND_BROWSER_ANNOTATIONS } from "../session/messages";
import type { BrowserAnnotationEntry } from "../tools";
import { createBrowserAnnotationListener } from "../tools/browser";
import {
	type AnnotateHttpInfo,
	AnnotateHttpPortUnavailableError,
	disableAnnotateHttp,
	enableAnnotateHttp,
	getAnnotateHttpStatus,
} from "../tools/browser/annotate-http";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { BUILTIN_COLLABORATION_SLASH_COMMANDS } from "./builtin-collaboration";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	buildMcpArgumentCompletions,
	buildStaticInlineHint,
	buildSubcommandInlineHint,
} from "./builtin-completions";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "./builtin-control";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "./builtin-lifecycle";
import { BUILTIN_MARKETPLACE_SLASH_COMMANDS, reloadTuiPluginState } from "./builtin-marketplace";
import { BUILTIN_MODE_SLASH_COMMANDS, refreshStatusLine } from "./builtin-modes";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "./builtin-session";
import { commandConsumed, parseSlashCommand, parseSubcommand, usage } from "./helpers/parse";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

/**
 * `/duo status` line. The scope parenthetical derives from the LIVE orchestrator
 * state (not the declared scope) so a refused single-scope disable stays visible:
 * when the user already owned orchestrator, a `single` scope cannot flip it off.
 */
function formatDuoStatusText(status: DuoStatus, orchestratorOn: boolean): string {
	const base = `Duo: ${status.phase} — planner ${status.planner ?? "?"}, executor ${
		status.executor ?? "?"
	}, takeovers ${status.takeoverCount}${status.advisorPaused ? ", advisor paused" : ""}`;
	if (status.phase === "inactive") return base;
	let paren = "orchestrator";
	if (status.executionScope === "single") {
		paren = orchestratorOn ? "orchestrator — direct disable refused: user-owned" : "direct";
	}
	return sanitizeText(`${base}\nscope: ${status.executionScope} (${paren})`);
}

const AUTOCOMPLETE_DETAIL_LIMIT = 48;

function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 1)}…`;
}

const SKILL_DESCRIPTION_LIMIT = 120;

function formatToggle(value: boolean | undefined, defaultValue: boolean = true): string {
	return (value ?? defaultValue) ? "on" : "off";
}

function shortenEmbeddedHomePaths(value: string): string {
	const home = os.homedir();
	return home ? value.replaceAll(home, "~") : value;
}

function sanitizeInlineText(value: string, maxWidth: number = TRUNCATE_LENGTHS.LINE): string {
	const singleLine = replaceTabs(sanitizeText(shortenEmbeddedHomePaths(value))).replaceAll(/\r?\n/g, " ");
	return truncateToWidth(singleLine, maxWidth);
}

function formatList(values: readonly string[] | undefined): string {
	return values && values.length > 0
		? values.map(value => sanitizeInlineText(value, TRUNCATE_LENGTHS.CONTENT)).join(", ")
		: "(none)";
}

function formatSkillDescription(description: string): string {
	return sanitizeInlineText(description, SKILL_DESCRIPTION_LIMIT);
}

function formatSkillLine(skill: Skill): string {
	const description = formatSkillDescription(skill.description);
	const name = sanitizeInlineText(skill.name, TRUNCATE_LENGTHS.CONTENT);
	const source = sanitizeInlineText(skill.source, TRUNCATE_LENGTHS.SHORT);
	return `* ${name} [${source}]${description ? ` — ${description}` : ""}`;
}

function buildSkillsReportText(runtime: SlashCommandRuntime): string {
	const skillSettings = runtime.session.skillsSettings ?? runtime.settings.getGroup("skills");

	const disabledExtensions = skillSettings.disabledExtensions ?? runtime.settings.get("disabledExtensions") ?? [];
	const disabledSkillNames = disabledExtensions
		.filter(id => id.startsWith("skill:"))
		.map(id => id.slice("skill:".length))
		.sort((a, b) => a.localeCompare(b));
	const skills = [...runtime.session.skills].sort((a, b) => a.name.localeCompare(b.name));
	const warnings = runtime.session.skillWarnings ?? [];

	const lines = [
		"Skill selection",
		`- Discovery: ${formatToggle(skillSettings.enabled)}`,
		`- /skill commands: ${formatToggle(skillSettings.enableSkillCommands)}`,
		`- Sources: codex user ${formatToggle(skillSettings.enableCodexUser)}, claude user ${formatToggle(skillSettings.enableClaudeUser)}, claude project ${formatToggle(skillSettings.enableClaudeProject)}, OMP user ${formatToggle(skillSettings.enablePiUser)}, OMP project ${formatToggle(skillSettings.enablePiProject)}`,
		`- Include skills: ${formatList(skillSettings.includeSkills)}`,
		`- Ignored skills: ${formatList(skillSettings.ignoredSkills)}`,
		`- Disabled skill extensions: ${formatList(disabledSkillNames)}`,
		"",
		`Active skills (${skills.length})`,
	];

	if (skills.length === 0) {
		lines.push("No active skills loaded.");
	} else {
		for (const skill of skills) lines.push(formatSkillLine(skill));
	}

	if (warnings.length > 0) {
		lines.push("", `Skill warnings (${warnings.length})`);
		for (const warning of warnings) {
			const pathPrefix = warning.skillPath ? `${shortenPath(warning.skillPath)}: ` : "";
			const text = sanitizeInlineText(`${pathPrefix}${warning.message}`);
			lines.push(`- ${text}`);
		}
	}

	return lines.join("\n");
}

const LEARNING_CLEAR_SCOPE_LABELS = {
	all: "All",
	global: "Global",
	repo: "Repo",
} as const;

type ContextGcAction = "stats" | "global" | "tree" | "debug";
type ContextGcStatus = "candidate" | "unloaded" | "pinned";
type ContextGcGroupBy = "status" | "kind" | "source";

interface ParsedContextGcArgs {
	action: ContextGcAction;
	status?: ContextGcStatus;
	groupBy?: ContextGcGroupBy;
	limit?: number;
	includeRecords?: boolean;
	error?: string;
}

const CONTEXT_GC_USAGE =
	"Usage: /context-gc [stats|global|global-stats|tree|debug]\n" +
	"  /context-gc tree [--status candidate|unloaded|pinned] [--group status|kind|source] [--limit N]\n" +
	"  /context-gc debug [--records] [--limit N]";

function parseContextGcStatus(value: string | undefined): ContextGcStatus | undefined {
	if (value === "candidate" || value === "unloaded" || value === "pinned") return value;
	return undefined;
}

function parseContextGcGroupBy(value: string | undefined): ContextGcGroupBy | undefined {
	if (value === "status" || value === "kind" || value === "source") return value;
	return undefined;
}

function parseContextGcLimit(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

function parseContextGcArgs(args: string): ParsedContextGcArgs {
	const tokens = args.split(/\s+/).filter(Boolean);
	const first = tokens[0]?.toLowerCase();
	const normalizedFirst = first === "global-stats" ? "global" : first;
	if (
		normalizedFirst !== undefined &&
		normalizedFirst !== "stats" &&
		normalizedFirst !== "global" &&
		normalizedFirst !== "tree" &&
		normalizedFirst !== "debug"
	) {
		return { action: "stats", error: `Unknown /context-gc subcommand: ${tokens[0]}.` };
	}
	const action: ContextGcAction = normalizedFirst ?? "stats";

	let status: ContextGcStatus | undefined;
	let groupBy: ContextGcGroupBy | undefined;
	let limit: number | undefined;
	let includeRecords = false;
	let i = first === undefined ? 0 : 1;
	while (i < tokens.length) {
		const token = tokens[i]!;
		switch (token) {
			case "--status": {
				if (action !== "tree") return { action, error: `Option ${token} is only valid for /context-gc tree.` };
				const parsed = parseContextGcStatus(tokens[i + 1]);
				if (!parsed) return { action, error: "Usage: --status candidate|unloaded|pinned" };
				status = parsed;
				i += 2;
				break;
			}
			case "--group": {
				if (action !== "tree") return { action, error: `Option ${token} is only valid for /context-gc tree.` };
				const parsed = parseContextGcGroupBy(tokens[i + 1]);
				if (!parsed) return { action, error: "Usage: --group status|kind|source" };
				groupBy = parsed;
				i += 2;
				break;
			}
			case "--limit": {
				if (action !== "tree" && action !== "debug") {
					return { action, error: `Option ${token} is only valid for /context-gc tree or debug.` };
				}
				const parsed = parseContextGcLimit(tokens[i + 1]);
				if (parsed === undefined) return { action, error: "Usage: --limit N where N is a positive integer." };
				limit = parsed;
				i += 2;
				break;
			}
			case "--records": {
				if (action !== "debug") return { action, error: `Option ${token} is only valid for /context-gc debug.` };
				includeRecords = true;
				i += 1;
				break;
			}
			default:
				return { action, error: `Unknown /context-gc option: ${token}.` };
		}
	}

	return { action, status, groupBy, limit, includeRecords };
}

function annotateHttpKey(session: AgentSession): object {
	return session;
}
const productPreviewSlashCommand = createProductPreviewCommand({
	startServer: startPreviewServer,
	makeShareController,
}).slashCommand;

/** Fork-only command surfaces retained across upstream's registry split. */
const FORK_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "orchestrator",
		description: "Toggle Safe orchestrator mode",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.planModeEnabled || runtime.ctx.planModePaused) return "Orchestrator: blocked by plan mode";
			if (runtime.ctx.goalModeEnabled || runtime.ctx.goalModePaused) return "Orchestrator: blocked by goal mode";
			return runtime.ctx.orchestratorModeEnabled || runtime.ctx.session.getOrchestratorModeState()?.enabled
				? "Orchestrator: on"
				: "Orchestrator: off";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleOrchestratorModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "herdr-notify",
		description: "Receive notifications when other Herdr agents finish (off by default)",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable Herdr agent-finished notifications" },
			{ name: "off", description: "Disable Herdr agent-finished notifications" },
			{ name: "status", description: "Show Herdr notification status" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "status") {
				const status = herdrNotifyStatus();
				await runtime.output(
					status.enabled
						? [
								"Herdr notifications are enabled.",
								...(status.socket ? [`Socket: ${status.socket}`] : []),
								...(status.descriptorPath ? [`Descriptor: ${status.descriptorPath}`] : []),
							].join("\n")
						: "Herdr notifications are disabled.",
				);
				return commandConsumed();
			}
			if (arg === "on") {
				if (!isHerdrPane()) {
					await runtime.output("Herdr notifications are unavailable: this session is not inside a Herdr pane.");
					return commandConsumed();
				}
				try {
					await enableHerdrNotify({
						sessionId: runtime.sessionManager.getSessionId(),
						cwd: runtime.sessionManager.getCwd(),
						paneId: process.env.HERDR_PANE_ID,
						tabId: process.env.HERDR_TAB_ID,
						workspaceId: process.env.HERDR_WORKSPACE_ID,
					});
				} catch (error) {
					await runtime.output(
						`Could not enable Herdr notifications: ${error instanceof Error ? error.message : String(error)}`,
					);
					return commandConsumed();
				}
				await runtime.output(
					["Herdr notifications enabled.", "Run `ompx herdr watch --detach` once so the bridge is up."].join("\n"),
				);
				return commandConsumed();
			}
			if (arg === "off") {
				await disableHerdrNotify();
				await runtime.output("Herdr notifications disabled.");
				return commandConsumed();
			}
			return usage("Usage: /herdr-notify [on|off|status]", runtime);
		},
	},
	{
		name: "duo",
		description: "Duo auto model switch (planner⇄executor with advisor monitoring)",
		acpInputHint: "[on|off|status|exec|plan|summon]",
		subcommands: [
			{ name: "on", description: "Enable duo" },
			{ name: "off", description: "Disable duo" },
			{ name: "status", description: "Show duo status" },
			{ name: "exec", description: "Hand the main stream to the executor" },
			{ name: "plan", description: "Return the stream to the planner (re-plan)" },
			{ name: "summon", description: "Summon the planner to the main stream for a transient consult" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const status = runtime.ctx.session.getDuoStatus();
			if (!status) return "Duo: unavailable";
			return `Duo: ${status.phase}`;
		},
		handle: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			const showEnabled = async (): Promise<void> => {
				await runtime.session.setDuoEnabled(true);
				const status = runtime.session.getDuoStatus();
				await runtime.output(
					status
						? `Duo enabled. (phase: ${status.phase})`
						: "Duo could not start: no Fable/Opus pair resolvable from authenticated models (check duo.plannerModel/duo.executorModel and provider auth).",
				);
			};
			const showStatus = async (): Promise<void> => {
				const status = runtime.session.getDuoStatus();
				if (!status) {
					await runtime.output(
						"Duo is unavailable: no Fable/Opus pair resolvable from authenticated models (check duo.plannerModel/duo.executorModel and provider auth).",
					);
					return;
				}
				await runtime.output(
					formatDuoStatusText(status, runtime.session.getOrchestratorModeState()?.enabled === true),
				);
			};
			if (!verb || verb === "toggle") {
				const status = runtime.session.getDuoStatus();
				if (!status || status.phase === "inactive") {
					await showEnabled();
				} else {
					await showStatus();
				}
				return commandConsumed();
			}
			if (verb === "on") {
				await showEnabled();
				return commandConsumed();
			}
			if (verb === "off") {
				await runtime.session.setDuoEnabled(false);
				await runtime.output("Duo disabled.");
				return commandConsumed();
			}
			if (verb === "status") {
				await showStatus();
				return commandConsumed();
			}
			if (verb === "exec") {
				const handedOff = await runtime.session.duoForceExec();
				await runtime.output(handedOff ? "Handed off to executor." : "Duo is not in a hand-off-able phase.");
				return commandConsumed();
			}
			if (verb === "plan") {
				const replanned = await runtime.session.duoReplan();
				await runtime.output(
					replanned
						? "Duo returned to planning; the planner holds the main stream."
						: "Duo is not executing — nothing to re-plan.",
				);
				return commandConsumed();
			}
			if (verb === "summon") {
				const summoned = await runtime.session.duoSummon();
				await runtime.output(
					summoned
						? "Planner summoned to the main stream; duo_handoff restores the executor."
						: "Duo is not executing — nothing to summon.",
				);
				return commandConsumed();
			}
			return usage("Usage: /duo [on|off|status|exec|plan|summon]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			const showEnabled = async (): Promise<void> => {
				await runtime.ctx.session.setDuoEnabled(true);
				const status = runtime.ctx.session.getDuoStatus();
				runtime.ctx.showStatus(
					status
						? `Duo enabled. (phase: ${status.phase})`
						: "Duo could not start: no Fable/Opus pair resolvable from authenticated models (check duo.plannerModel/duo.executorModel and provider auth).",
				);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
			};
			const showStatus = (): void => {
				const status = runtime.ctx.session.getDuoStatus();
				if (!status) {
					runtime.ctx.showStatus(
						"Duo is unavailable: no Fable/Opus pair resolvable from authenticated models (check duo.plannerModel/duo.executorModel and provider auth).",
					);
					runtime.ctx.editor.setText("");
					return;
				}
				runtime.ctx.showStatus(
					formatDuoStatusText(status, runtime.ctx.session.getOrchestratorModeState()?.enabled === true),
				);
				runtime.ctx.editor.setText("");
			};
			if (!verb || verb === "toggle") {
				const status = runtime.ctx.session.getDuoStatus();
				if (!status || status.phase === "inactive") {
					await showEnabled();
				} else {
					showStatus();
				}
				return;
			}
			if (verb === "on") {
				await showEnabled();
				return;
			}
			if (verb === "off") {
				await runtime.ctx.session.setDuoEnabled(false);
				runtime.ctx.showStatus("Duo disabled.");
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "status") {
				showStatus();
				return;
			}
			if (verb === "exec") {
				const handedOff = await runtime.ctx.session.duoForceExec();
				runtime.ctx.showStatus(handedOff ? "Handed off to executor." : "Duo is not in a hand-off-able phase.");
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "plan") {
				const replanned = await runtime.ctx.session.duoReplan();
				runtime.ctx.showStatus(
					replanned
						? "Duo returned to planning; the planner holds the main stream."
						: "Duo is not executing — nothing to re-plan.",
				);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "summon") {
				const summoned = await runtime.ctx.session.duoSummon();
				runtime.ctx.showStatus(
					summoned
						? "Planner summoned to the main stream; duo_handoff restores the executor."
						: "Duo is not executing — nothing to summon.",
				);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /duo [on|off|status|exec|plan|summon]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "annotate",
		description: "Enable Chrome-extension annotation intake over localhost",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Start the loopback annotation intake" },
			{ name: "off", description: "Stop the loopback annotation intake" },
			{ name: "status", description: "Show annotation intake URL, code, and received count" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			const key = annotateHttpKey(runtime.session);
			if (!verb || verb === "status") {
				const status = getAnnotateHttpStatus(key);
				await runtime.output(
					status
						? `Annotation intake enabled: ${status.url}\nPairing code: ${status.code}\nReceived: ${status.received}`
						: "Annotation intake disabled.",
				);
				return commandConsumed();
			}
			if (verb === "off" || verb === "disable") {
				const disabled = await disableAnnotateHttp(key);
				await runtime.output(disabled ? "Annotation intake disabled." : "Annotation intake already disabled.");
				return commandConsumed();
			}
			if (verb !== "on" && verb !== "enable") {
				return usage("Usage: /annotate [on|off|status]", runtime);
			}

			const configuredHost = runtime.settings.get("browser.annotateHttpHost" as SettingPath) as string | undefined;
			const configuredPort = runtime.settings.get("browser.annotateHttpPort" as SettingPath) as number | undefined;
			const host = typeof configuredHost === "string" && configuredHost.trim() ? configuredHost.trim() : "0.0.0.0";
			const portNumber = typeof configuredPort === "number" ? configuredPort : Number(configuredPort);
			const port = Number.isFinite(portNumber) && portNumber > 0 ? Math.trunc(portNumber) : 3848;
			const listener = createBrowserAnnotationListener(
				{
					queueBrowserAnnotation: (entry: BrowserAnnotationEntry) => {
						runtime.session.yieldQueue.enqueue<BrowserAnnotationEntry>(BROWSER_ANNOTATION_MESSAGE_TYPE, entry, {
							maxEntries: MAX_BACKGROUND_BROWSER_ANNOTATIONS,
						});
					},
				},
				"chrome-extension",
			);
			if (!listener)
				return usage("Annotation intake unavailable: browser annotation queue is not enabled.", runtime);
			let info: AnnotateHttpInfo;
			try {
				info = await enableAnnotateHttp({
					key,
					sessionLabel: runtime.session.sessionName || runtime.session.sessionId || "OMPx session",
					host,
					port,
					deliver: listener,
				});
			} catch (error) {
				if (error instanceof AnnotateHttpPortUnavailableError) {
					logger.warn("Annotation intake failed to bind", {
						host: error.host,
						firstPort: error.firstPort,
						lastPort: error.lastPort,
					});
					await runtime.output(
						`Annotation intake failed: no free port in ${error.firstPort}-${error.lastPort} on ${error.host}. Intake remains disabled; stop another ompx process or set browser.annotateHttpPort.`,
					);
					return commandConsumed();
				}
				throw error;
			}
			await runtime.output(`Annotation intake enabled: ${info.url}\nPairing code: ${info.code}`);
			return commandConsumed();
		},
	},
	{
		name: "crash",
		description: "Show unread crash reports",
		acpDescription: "Show unread crash reports",
		acpInputHint: "[dismiss]",
		inlineHint: "[dismiss]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg !== "" && arg !== "dismiss") {
				return usage("Usage: /crash [dismiss]", runtime);
			}

			const unread = listUnreadCrashArtifacts();
			if (arg === "dismiss") {
				markCrashArtifactsSeen();
				await runtime.output(unread.length > 0 ? "Unread crash reports dismissed." : "No unread crash reports.");
				return commandConsumed();
			}

			const latest = unread[0];
			if (!latest) {
				await runtime.output("No unread crash reports.");
				return commandConsumed();
			}

			const summary = shortDetail(sanitizeText(latest.summary), TRUNCATE_LENGTHS.CONTENT);
			const reportPath = truncateToWidth(
				sanitizeText(shortenPath(latest.path)).replace(/\s+/g, " "),
				TRUNCATE_LENGTHS.CONTENT,
			);
			await runtime.output(
				`${summary}\n${formatCrashReportPathLine(reportPath)}\nUse /crash dismiss to dismiss unread reports.`,
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg !== "" && arg !== "dismiss") {
				runtime.ctx.showStatus("Usage: /crash [dismiss]");
				runtime.ctx.editor.setText("");
				return;
			}

			const unread = listUnreadCrashArtifacts();
			if (arg === "dismiss") {
				markCrashArtifactsSeen();
				runtime.ctx.clearCrashReportBanner();
				runtime.ctx.showStatus(unread.length > 0 ? "Unread crash reports dismissed." : "No unread crash reports.");
				runtime.ctx.editor.setText("");
				return;
			}

			const latest = unread[0];
			if (!latest) {
				runtime.ctx.showStatus("No unread crash reports.");
				runtime.ctx.editor.setText("");
				return;
			}

			const summary = shortDetail(sanitizeText(latest.summary), TRUNCATE_LENGTHS.CONTENT);
			const reportPath = truncateToWidth(
				sanitizeText(shortenPath(latest.path)).replace(/\s+/g, " "),
				TRUNCATE_LENGTHS.CONTENT,
			);
			runtime.ctx.showStatus(
				`${summary}\n${formatCrashReportPathLine(reportPath)}\nUse /crash dismiss to dismiss unread reports.`,
			);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "skills",
		description: "Show active skills and skill-selection filters",
		acpDescription: "Show active skills and skill filters",
		handle: async (_command, runtime) => {
			await runtime.output(buildSkillsReportText(runtime));
			return commandConsumed();
		},
	},
	{
		name: "context-gc",
		aliases: ["contextgc", "gc"],
		description: "Show Context GC stats, tree, and diagnostics",
		acpInputHint: "[stats|global|tree|debug]",
		subcommands: [
			{ name: "stats", description: "Show current branch Context GC stats" },
			{ name: "global", description: "Show global Context GC database stats" },
			{ name: "tree", description: "Show grouped current branch record tree" },
			{ name: "debug", description: "Show Context GC diagnostics" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseContextGcArgs(command.args);
			if (parsed.error) return usage(`${parsed.error}\n${CONTEXT_GC_USAGE}`, runtime);
			const report = await renderContextGcReport({
				agentDir: runtime.settings.getAgentDir(),
				cwd: runtime.cwd,
				sessionManager: runtime.sessionManager,
				action: parsed.action,
				status: parsed.status,
				groupBy: parsed.groupBy,
				limit: parsed.limit,
				includeRecords: parsed.includeRecords,
				contextUsage: runtime.session.getContextUsage?.(),
			});
			await runtime.output(report);
			return commandConsumed();
		},
	},
	{
		name: "workflows",
		description: "Show live workflow orchestration progress",
		handleTui: (_command, runtime) => {
			runtime.ctx.showWorkflowsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "subagents",
		description: "Open live subagent inspector",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentHub();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "learning",
		description: "Inspect and operate live learning",
		acpDescription: "Manage live learning",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: "Show active live learnings with scores and votes" },
			{ name: "logs", description: "Show recent live-learning log entries" },
			{ name: "consolidate", description: "Force a live-learning consolidation run" },
			{ name: "drop <alias>", description: "Archive an active live learning by alias" },
			{ name: "clear repo", description: "Clear repository-scoped live learnings" },
			{ name: "clear global", description: "Clear global live learnings" },
			{ name: "clear all", description: "Clear repository and global live learnings" },
			{ name: "reset", description: "Alias for clear all" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const parts = command.args.trim().split(/\s+/).filter(Boolean);
			const verb = parts[0]?.toLowerCase() || "view";
			switch (verb) {
				case "view": {
					const agentDir = runtime.settings.getAgentDir();
					const payload = await buildLearningDeveloperInstructions(agentDir, runtime.settings, runtime.cwd);
					const repoKey = await resolveRepoKey(runtime.cwd);
					const db = learningStorage.openLearningDb(getAgentDbPath(agentDir));
					try {
						const entries = learningStorage.listActiveLearnings(db, {
							repoKey,
							limitPerScope: runtime.settings.get("learning.maxEntriesPerScope"),
							halfLifeDays: runtime.settings.get("learning.halfLifeDays"),
							nowSec: Math.floor(Date.now() / 1_000),
						});
						const details = entries
							.map(
								(entry: learningStorage.RankedLearningEntry) =>
									`[l:${entry.alias}] score ${entry.score.toFixed(2)} · strength ${entry.strength} · useful ${entry.usefulCount} · not_useful ${entry.notUsefulCount}\n${entry.content}`,
							)
							.join("\n\n");
						const view = [payload, details].filter(Boolean).join("\n\n");
						await runtime.output(view || "Live learning payload is empty.");
						return commandConsumed();
					} finally {
						learningStorage.closeLearningDb(db);
					}
				}
				case "logs": {
					const logText = await getLearningLogText();
					await runtime.output(logText || "No recent live-learning log entries found.");
					return commandConsumed();
				}
				case "consolidate": {
					const reports = await learningConsolidation.maybeRunLearningConsolidation({
						session: runtime.session,
						settings: runtime.settings,
						modelRegistry: runtime.session.modelRegistry,
						agentDir: runtime.settings.getAgentDir(),
						force: true,
					});
					const reportText =
						reports.length === 0
							? "No live-learning consolidation targets."
							: reports
									.map(
										report =>
											`${report.target}: ${report.outcome} (ops applied: ${report.opsApplied ?? 0}, ops skipped stale: ${report.opsSkippedStale ?? 0})`,
									)
									.join("\n");
					if (reports.some(report => (report.opsApplied ?? 0) > 0)) {
						await runtime.session.refreshBaseSystemPrompt();
					}
					await runtime.output(reportText);
					return commandConsumed();
				}
				case "drop": {
					const aliasPrefix = (parts[1] ?? "").replace(/^\[?l:/i, "").replace(/\]$/, "");
					if (!aliasPrefix) return usage("Usage: /learning drop <alias>", runtime);
					const repoKey = await resolveRepoKey(runtime.cwd);
					const db = learningStorage.openLearningDb(getAgentDbPath(runtime.settings.getAgentDir()));
					let archived = false;
					try {
						const matches = learningStorage.findActiveByAliasPrefix(db, { aliasPrefix, repoKey });
						if (matches.length === 0) {
							await runtime.output(`Unknown live learning alias: ${aliasPrefix}.`);
							return commandConsumed();
						}
						if (matches.length > 1) {
							await runtime.output(`Live learning alias is ambiguous: ${aliasPrefix}.`);
							return commandConsumed();
						}
						const learning = matches[0];
						if (!learning) return commandConsumed();
						archived = learningStorage.archiveLearning(db, {
							id: learning.id,
							guardUpdatedAt: null,
							nowSec: Math.floor(Date.now() / 1_000),
						});
						await runtime.output(
							archived
								? `Archived live learning [l:${learning.contentHash.slice(0, 12)}].`
								: `Live learning is no longer active: ${aliasPrefix}.`,
						);
					} finally {
						learningStorage.closeLearningDb(db);
					}
					if (archived) await runtime.session.refreshBaseSystemPrompt();
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					const scopeText = (parts[1] ?? "all").toLowerCase();
					switch (scopeText) {
						case "all":
						case "global":
						case "repo":
							await clearLearningData(runtime.settings.getAgentDir(), runtime.cwd, scopeText);
							await runtime.session.refreshBaseSystemPrompt();
							await runtime.output(`${LEARNING_CLEAR_SCOPE_LABELS[scopeText]} live learning cleared.`);
							return commandConsumed();
						default:
							return usage("Usage: /learning clear [repo|global|all]", runtime);
					}
				}
				default:
					return usage("Usage: /learning <view|logs|consolidate|drop|clear|reset> [repo|global|all]", runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleLearningCommand(command.text);
		},
	},
	{
		name: "restart",
		description: "Restart the application and resume this session",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.restart();
		},
	},
	{
		name: "reload-prompt",
		description: "Reload SYSTEM.md and APPEND_SYSTEM.md prompt overlays",
		acpDescription: "Reload system prompt overlays",
		handle: async (_command, runtime) => {
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output("System prompt reloaded.");
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.session.refreshBaseSystemPrompt();
			refreshStatusLine(runtime.ctx);
			runtime.ctx.updateEditorTopBorder();
			runtime.ctx.showStatus("System prompt reloaded.");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "telegram",
		description: "Connect a Telegram bridge to this session",
		subcommands: [
			{ name: "on", description: "Connect Telegram for this session" },
			{ name: "off", description: "Disconnect Telegram for this session" },
			{ name: "status", description: "Show Telegram connection status" },
		],
		allowArgs: true,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleTelegramCommand(command.args.trim().toLowerCase());
		},
	},
];

/** Fork-specific /live argument handling overrides the upstream default. */
const FORK_LIVE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "live",
		description: "Start realtime voice mode; `remote` serves it to a client over SSH",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args?.trim().toLowerCase() ?? "";
			const remote = /\bremote\b/.test(args);
			const forwardCredentials = /\bforward-credentials\b/.test(args);
			await runtime.ctx.handleLiveCommand({ remote, forwardCredentials });
		},
	},
];

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	...BUILTIN_MODE_SLASH_COMMANDS,
	...BUILTIN_COLLABORATION_SLASH_COMMANDS,
	...BUILTIN_SESSION_SLASH_COMMANDS,
	...BUILTIN_LIFECYCLE_SLASH_COMMANDS,
	...BUILTIN_MARKETPLACE_SLASH_COMMANDS,
	...BUILTIN_CONTROL_SLASH_COMMANDS.filter(command => command.name !== "live"),
	...FORK_SLASH_COMMANDS,
	productPreviewSlashCommand,
	...FORK_LIVE_SLASH_COMMANDS,
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	if (cmd.subcommands) {
		materialized.getArgumentCompletions =
			cmd.name === "mcp" && runtime
				? buildMcpArgumentCompletions(cmd.subcommands, runtime)
				: buildArgumentCompletions(cmd.subcommands);
		materialized.getInlineHint = buildSubcommandInlineHint(cmd.subcommands);
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		runtime.ctx.editor.setText("");
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: () => reloadTuiPluginState(ctx),
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
