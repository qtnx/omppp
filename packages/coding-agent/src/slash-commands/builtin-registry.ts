import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderContextGcReport } from "@oh-my-pi/context-gc-plugin";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { type AutocompleteItem, Spacer } from "@oh-my-pi/pi-tui";
import {
	APP_NAME,
	formatCrashReportPathLine,
	getAgentDbPath,
	getProjectDir,
	listUnreadCrashArtifacts,
	logger,
	markCrashArtifactsSeen,
	sanitizeText,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { COLLAB_GUEST_ALLOWED_COMMANDS, CollabGuestLink } from "../collab/guest";
import { CollabHost } from "../collab/host";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import type { SettingPath, SettingValue } from "../config/settings";
import { settings } from "../config/settings";
import {
	clearPluginRootsAndCaches,
	resolveActiveProjectRegistryPath,
	resolveOrDefaultProjectRegistryPath,
} from "../discovery/helpers.js";
import type { DuoStatus } from "../duo";
import { shareSession } from "../export/share";
import { PluginManager } from "../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../extensibility/plugins/marketplace";
import type { Skill } from "../extensibility/skills";
import { buildLearningDeveloperInstructions, clearLearningData, getLearningLogText } from "../learnings";
import * as learningConsolidation from "../learnings/consolidate";
import { resolveRepoKey } from "../learnings/repo-key";
import * as learningStorage from "../learnings/storage";
import { resolveMemoryBackend } from "../memory-backend";
import { runPauseScreen } from "../modes/components/pause-screen";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import { theme } from "../modes/theme/theme";
import type { InteractiveModeContext } from "../modes/types";
import { extractLastCodeBlock, extractLastCommand } from "../modes/utils/copy-targets";
import type { AgentSession, FreshSessionResult } from "../session/agent-session";
import { COMPACT_MODES, parseCompactArgs } from "../session/compact-modes";
import { BROWSER_ANNOTATION_MESSAGE_TYPE, MAX_BACKGROUND_BROWSER_ANNOTATIONS } from "../session/messages";
import { resolveResumableSession } from "../session/session-listing";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import {
	buildMacOSSandboxRelaunchArgv,
	formatMacOSSandboxRestartCommand,
	resolveMacOSSandboxWorkspaceDirs,
} from "../task/omp-command";
import type { BrowserAnnotationEntry } from "../tools";
import { createBrowserAnnotationListener } from "../tools/browser";
import {
	type AnnotateHttpInfo,
	AnnotateHttpPortUnavailableError,
	disableAnnotateHttp,
	enableAnnotateHttp,
	getAnnotateHttpStatus,
} from "../tools/browser/annotate-http";
import { expandTilde, resolveToCwd } from "../tools/path-utils";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { urlHyperlinkAlways } from "../tui";
import {
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	renderChangelogEntries,
} from "../utils/changelog";
import { copyToClipboard } from "../utils/clipboard";
import { type DumpTarget, writeSessionTranscriptDump } from "../utils/session-dump";
import { resolveWorkspaceRootReference } from "../workspace-roots";
import { CollabQrCodeComponent } from "./helpers/collab-qrcode";
import { buildContextReportText } from "./helpers/context-report";
import { formatDuration } from "./helpers/format";
import { createMarketplaceManager } from "./helpers/marketplace-manager";
import { handleMcpAcp } from "./helpers/mcp";
import { commandConsumed, errorMessage, parseSlashCommand, parseSubcommand, usage } from "./helpers/parse";
import { describeRedeemOutcome, type ResetUsageAccount, toResetUsageAccounts } from "./helpers/reset-usage";
import { handleSshAcp } from "./helpers/ssh";
import { launchStatsDashboard, parseStatsDashboardArgs } from "./helpers/stats-dashboard";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "./marketplace-install-parser";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	SubcommandDef,
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

function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

const PLUGIN_SELECTOR_REFRESH_POLL_MS = 250;
const PLUGIN_SELECTOR_REFRESH_WINDOW_MS = 10 * 60 * 1000;

async function readInstalledPluginSnapshot(mgr: MarketplaceManager): Promise<string> {
	const installed = await mgr.listInstalledPlugins();
	const keys = installed.map(plugin =>
		[
			plugin.id,
			plugin.scope,
			plugin.shadowedBy ?? "",
			...plugin.entries.map(entry =>
				[
					entry.scope,
					entry.installPath,
					entry.version,
					entry.lastUpdated,
					entry.enabled === false ? "disabled" : "enabled",
				].join("\u0000"),
			),
		].join("\u0000"),
	);
	keys.sort();
	return keys.join("\u0001");
}

function refreshPluginStateAfterSelectorMutation(
	ctx: InteractiveModeContext,
	mgr: MarketplaceManager,
	initialSnapshot: string,
): void {
	const deadline = Date.now() + PLUGIN_SELECTOR_REFRESH_WINDOW_MS;
	const poll = async (): Promise<void> => {
		if (Date.now() > deadline) return;
		try {
			const currentSnapshot = await readInstalledPluginSnapshot(mgr);
			if (currentSnapshot !== initialSnapshot) {
				await ctx.refreshPluginState();
				return;
			}
		} catch {
			return;
		}
		globalThis.setTimeout(() => {
			void poll();
		}, PLUGIN_SELECTOR_REFRESH_POLL_MS);
	};
	globalThis.setTimeout(() => {
		void poll();
	}, PLUGIN_SELECTOR_REFRESH_POLL_MS);
}

/** `/fast status` label: "off", "on", or scope-qualified "on (… only)". */
function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
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

function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

/** Scheme-less display form of a browser deep link: accent + underline, OSC-8 linked to the full URL. */
function collabWebLinkClickable(webLink: string): string {
	const display = theme.fg("accent", `\x1b[4m${webLink.replace(/^https?:\/\//, "")}\x1b[24m`);
	return urlHyperlinkAlways(webLink, display);
}

/** Join hint printed by /collab: compact terminal link + clickable browser deep link. */
function collabLinkHint(host: CollabHost, heading: string, view = false): string {
	const bullet = theme.fg("accent", theme.format.bullet);
	const link = view ? host.viewLink : host.link;
	const webLink = view ? host.webViewLink : host.webLink;
	return [
		theme.fg("success", heading),
		` ${bullet} ${theme.fg("muted", view ? "Watch from another terminal:" : "Join from another terminal:")} ${APP_NAME} join "${link}"`,
		` ${bullet} ${theme.fg("muted", "or any web browser:")} ${collabWebLinkClickable(webLink)}`,
		theme.fg(
			"dim",
			view
				? "Anyone with this link can watch the session but cannot prompt the agent."
				: "Anyone with the link can read the session and prompt the agent. Read-only link: /collab view",
		),
	].join("\n");
}

function showCollabQrCode(ctx: InteractiveModeContext, webLink: string): void {
	try {
		ctx.present([new Spacer(1), new CollabQrCodeComponent(webLink)]);
	} catch (err) {
		ctx.showError(`Failed to render collab QR code: ${errorMessage(err)}`);
	}
}

function showCollabLink(ctx: InteractiveModeContext, host: CollabHost, heading: string, view = false): void {
	ctx.showStatus(collabLinkHint(host, heading, view), { dim: false });
	showCollabQrCode(ctx, view ? host.webViewLink : host.webLink);
}

function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
	return `Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`;
}
const shutdownHandlerTui = (_command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};

async function handleUsageResetCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	let accounts: ResetUsageAccount[];
	try {
		accounts = toResetUsageAccounts(await session.listResetCredits());
	} catch (error) {
		await output(`Could not load saved resets: ${errorMessage(error)}`);
		return;
	}
	if (accounts.length === 0) {
		await output("No Codex accounts found. Use /login to add one.");
		return;
	}
	const targetArg = arg.trim();
	if (!targetArg) {
		const lines = ["Saved Codex rate-limit resets:"];
		for (const account of accounts) {
			const detail = account.error ? `unavailable (${account.error})` : `${account.availableCount} available`;
			lines.push(`- ${account.label}: ${detail}${account.active ? " (active)" : ""}`);
		}
		lines.push("", "Spend one with `/usage reset <account email>` or `/usage reset active`.");
		await output(lines.join("\n"));
		return;
	}
	const wanted = targetArg.toLowerCase();
	const target =
		wanted === "active"
			? accounts.find(account => account.active)
			: accounts.find(
					account =>
						account.label.toLowerCase() === wanted ||
						account.target.email?.toLowerCase() === wanted ||
						account.target.accountId?.toLowerCase() === wanted,
				);
	if (!target) {
		await output(`No Codex account matches "${targetArg}".`);
		return;
	}
	if (target.availableCount <= 0) {
		await output(`${target.label}: no saved resets to spend.`);
		return;
	}
	const outcome = await session.redeemResetCredit(target.target);
	await output(describeRedeemOutcome(outcome, target.label));
}

/** Parse the `/shake` subcommand into a {@link ShakeMode}; empty defaults to elide. */
function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	return { error: `Unknown /shake mode "${verb}". Use elide or images.` };
}

function parseDumpTarget(args: string): DumpTarget | null {
	const arg = args.trim().toLowerCase();
	if (arg === "" || arg === "copy" || arg === "clipboard" || arg === "--copy") return "clipboard";
	if (arg === "file" || arg === "txt" || arg === "tmp" || arg === "--file") return "file";
	return null;
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

async function handleAddDirCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const rawPath = command.args.trim();
	const resolved = resolveMacOSSandboxWorkspaceDirs([rawPath], runtime.cwd);
	if (resolved.error) {
		await runtime.output(`Refusing to whitelist unsafe sandbox directory: ${resolved.error}.`);
		return commandConsumed();
	}
	const resolvedPath = resolved.paths[0];
	if (!resolvedPath) return usage("Usage: /add-dir <trusted-workspace-dir>", runtime);
	const sessionFile = runtime.sessionManager.getSessionFile();
	const sessionId = sessionFile ? runtime.sessionManager.getSessionId() : null;
	const relaunchPaths = [runtime.cwd, ...runtime.session.workspaceRoots.map(root => root.path), resolvedPath];
	const result = sessionId
		? runtime.session.requestMacOSSandboxRelaunch(relaunchPaths)
		: ({ requested: false, reason: "missing-session" } as const);
	const displayPath = sanitizeInlineText(resolvedPath);
	if (result.requested) {
		await runtime.output(`Requested sandbox relaunch with whitelisted working directory: ${displayPath}`);
		return commandConsumed();
	}
	const previousArgv = sessionFile ? ["--session-dir", path.dirname(sessionFile)] : [];
	const restartArgs = sessionId ? buildMacOSSandboxRelaunchArgv(previousArgv, sessionId, relaunchPaths) : undefined;
	const restartCommand = restartArgs ? formatMacOSSandboxRestartCommand(restartArgs) : null;
	await runtime.output(
		restartCommand
			? `Cannot update the active macOS sandbox in place (${result.reason ?? "unknown"}). Restart from your shell: ${restartCommand}`
			: `Cannot update the active macOS sandbox in place (${result.reason ?? "unknown"}); no persisted session is available to resume.`,
	);
	return commandConsumed();
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

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "add-dir",
		description: "Relaunch the macOS sandbox with another trusted working directory",
		inlineHint: "<path>",
		allowArgs: true,
		handle: handleAddDirCommand,
	},
	{
		name: "settings",
		description: "Open settings menu",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "setup",
		aliases: ["providers"],
		description: "Open provider setup",
		allowArgs: true,
		subcommands: [{ name: "providers", description: "Configure sign-in and web search providers" }],
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			const opensProviders = args === "" || args === "providers";
			if (opensProviders) {
				await runtime.ctx.showProviderSetup();
			} else {
				runtime.ctx.showWarning(`Usage: /${command.name} [providers]`);
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan",
		description: "Toggle plan mode (agent plans before executing)",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("plan.enabled" as SettingPath)) return "Plan: disabled in settings";
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return `Plan: on${planFile ? ` (${path.basename(planFile)})` : ""}`;
			}
			if (runtime.ctx.goalModeEnabled) return "Plan: blocked by goal mode";
			return "Plan: off";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handlePlanModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
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
		name: "plan-review",
		description: "Re-open the plan review for the latest plan (plan mode only)",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled ? "Plan review: available" : "Plan review: plan mode inactive",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "vibe",
		description: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return "Vibe: on";
			if (runtime.ctx.planModeEnabled) return "Vibe: blocked by plan mode";
			if (runtime.ctx.goalModeEnabled) return "Vibe: blocked by goal mode";
			return "Vibe: off";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleVibeModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "goal",
		description: "Toggle goal mode (persistent autonomous objective for this session)",
		subcommands: [
			{ name: "set", description: "Set or replace the goal", usage: "<objective>" },
			{ name: "show", description: "Show current goal details" },
			{ name: "pause", description: "Pause the current goal" },
			{ name: "resume", description: "Resume a paused goal" },
			{ name: "drop", description: "Drop the current goal" },
			{ name: "budget", description: "Adjust the token budget", usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("goal.enabled" as SettingPath)) return "Goal: disabled in settings";
			if (runtime.ctx.planModeEnabled) return "Goal: blocked by plan mode";
			const state = runtime.ctx.session.getGoalModeState();
			return state ? `Goal: ${state.goal.status} (${shortDetail(state.goal.objective)})` : "Goal: off";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleGoalModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "guided-goal",
		description: "Interview and refine a goal before enabling goal mode",
		inlineHint: "[rough objective]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleGuidedGoalCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "loop",
		description:
			"Toggle loop mode. While enabled, the next prompt you send re-submits after every yield, waiting the configured time before each repeat. Esc cancels the current iteration; /loop again to disable.",
		inlineHint: "[count|duration] [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return "Loop: off";
			if (runtime.ctx.loopLimit) return `Loop: on (${describeLoopLimitRuntime(runtime.ctx.loopLimit)})`;
			if (runtime.ctx.loopPrompt) return "Loop: on (repeating prompt)";
			return "Loop: on (waiting for next prompt)";
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	{
		name: "model",
		aliases: ["models"],
		description: "Switch model for this session",
		acpDescription: "Show current model selection",
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `Model: ${model.provider}/${model.id}` : "Model: none selected";
		},
		handle: async (command, runtime) => {
			if (command.args) {
				const modelId = command.args.trim();
				const availableModels = runtime.session.getAvailableModels?.() ?? [];
				const match = availableModels.find(
					model => model.id === modelId || `${model.provider}/${model.id}` === modelId,
				);
				if (!match) {
					return usage(
						`Unknown model: ${modelId}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					await runtime.output(`Model set to ${match.provider}/${match.id}.`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "switch",
		description: "Switch model for this session (same as alt+p)",
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `Model: ${model.provider}/${model.id}` : "Model: none selected";
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector({ temporaryOnly: true });
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fast",
		description: "Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable fast mode" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => `Fast: ${formatFastModeStatus(runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				return commandConsumed();
			}
			if (arg === "on") {
				const supported = runtime.session.setFastMode(true);
				await runtime.output(supported ? "Fast mode enabled." : "Fast mode is unavailable for the current model.");
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output("Fast mode disabled.");
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(`Fast mode is ${formatFastModeStatus(runtime.session)}.`);
				return commandConsumed();
			}
			return usage("Usage: /fast [on|off|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				const supported = runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(
					supported ? "Fast mode enabled." : "Fast mode is unavailable for the current model.",
				);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode disabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				runtime.ctx.showStatus(`Fast mode is ${formatFastModeStatus(runtime.ctx.session)}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "advisor",
		description: "Toggle the advisor (a second model that reviews each turn and injects notes)",
		acpDescription: "Toggle advisor",
		acpInputHint: "[on|off|status|dump [raw]|configure]",
		subcommands: [
			{ name: "on", description: "Enable the advisor" },
			{ name: "off", description: "Disable the advisor" },
			{ name: "status", description: "Show advisor status" },
			{ name: "dump", description: "Copy the advisor's transcript to clipboard", usage: "[raw]" },
			{ name: "configure", description: "Open the advisor configuration editor (TUI)" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const stats = runtime.ctx.session.getAdvisorStats();
			if (stats.active && stats.advisors.length > 1) return `Advisor: on (${stats.advisors.length} advisors)`;
			if (stats.active && stats.model) return `Advisor: on (${stats.model.provider}/${stats.model.id})`;
			if (stats.configured) return "Advisor: configured, no model";
			return "Advisor: off";
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.session.toggleAdvisorEnabled();
				const configured = runtime.session.isAdvisorEnabled();
				if (active) {
					await runtime.output("Advisor enabled.");
				} else if (configured) {
					await runtime.output("Advisor setting enabled, but no model is assigned to the 'advisor' role.");
				} else {
					await runtime.output("Advisor disabled.");
				}
				return commandConsumed();
			}
			if (verb === "on") {
				const active = runtime.session.setAdvisorEnabled(true);
				await runtime.output(
					active ? "Advisor enabled." : "Advisor setting enabled, but no model is assigned to the 'advisor' role.",
				);
				return commandConsumed();
			}
			if (verb === "off") {
				runtime.session.setAdvisorEnabled(false);
				await runtime.output("Advisor disabled.");
				return commandConsumed();
			}
			if (verb === "status") {
				await runtime.output(runtime.session.formatAdvisorStatus());
				return commandConsumed();
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				const text = runtime.session.formatAdvisorHistoryAsText({ compact: !isRaw });
				await runtime.output(text ?? "Advisor is not active for this session.");
				return commandConsumed();
			}
			if (verb === "configure") {
				await runtime.output(
					"/advisor configure opens an interactive editor and is only available in the interactive TUI.",
				);
				return commandConsumed();
			}
			return usage("Usage: /advisor [on|off|status|dump [raw]|configure]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.ctx.session.toggleAdvisorEnabled();
				const configured = runtime.ctx.session.isAdvisorEnabled();
				if (active) {
					runtime.ctx.showStatus("Advisor enabled.");
				} else if (configured) {
					runtime.ctx.showStatus("Advisor setting enabled, but no model is assigned to the 'advisor' role.");
				} else {
					runtime.ctx.showStatus("Advisor disabled.");
				}
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "on") {
				const active = runtime.ctx.session.setAdvisorEnabled(true);
				runtime.ctx.showStatus(
					active ? "Advisor enabled." : "Advisor setting enabled, but no model is assigned to the 'advisor' role.",
				);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "off") {
				runtime.ctx.session.setAdvisorEnabled(false);
				runtime.ctx.showStatus("Advisor disabled.");
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "status") {
				await runtime.ctx.handleAdvisorStatusCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				runtime.ctx.handleAdvisorDumpCommand(isRaw);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "configure") {
				runtime.ctx.showAdvisorConfigure();
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /advisor [on|off|status|dump [raw]|configure]");
			runtime.ctx.editor.setText("");
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
		name: "export",
		description: "Export session to HTML file",
		inlineHint: "[path]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim();
			// Match the interactive `/export` behavior: clipboard aliases are not a
			// valid export target. Without this, the literal value (`copy`,
			// `--copy`, `clipboard`) is passed to `exportToHtml` and becomes the
			// output filename.
			if (arg === "--copy" || arg === "clipboard" || arg === "copy") {
				return usage("Use /dump to copy the session to clipboard.", runtime);
			}
			try {
				const filePath = await runtime.session.exportToHtml(arg || undefined);
				await runtime.output(`Session exported to: ${filePath}`);
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "dump",
		description:
			"Copy session transcript to clipboard or write it to a temp text file (and write LLM request JSON to tmp)",
		acpDescription: "Return full transcript as plain text, with LLM request JSON path",
		subcommands: [
			{ name: "copy", description: "Copy session transcript to clipboard" },
			{ name: "file", description: "Write session transcript to a temp text file" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const target = parseDumpTarget(command.args);
			if (!target) return { prompt: command.text };
			const text = runtime.session.formatSessionAsText();
			if (!text) {
				await runtime.output("No messages to dump yet.");
				return commandConsumed();
			}
			if (target === "file") {
				const filePath = await writeSessionTranscriptDump(text);
				await runtime.output(`Session transcript written to:\n${filePath}`);
				return commandConsumed();
			}
			let sidecarPath: string | undefined;
			try {
				sidecarPath = await runtime.session.dumpLlmRequestToTmpDir();
			} catch {
				// Sidecar is best-effort; the transcript is still output below.
			}
			const lines = [text];
			if (sidecarPath)
				lines.push(
					"",
					`LLM request JSON: ${sidecarPath}`,
					"This file persists on disk and may contain raw context/secrets — treat accordingly.",
				);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const target = parseDumpTarget(command.args);
			if (!target) return { prompt: command.text };
			await runtime.ctx.handleDumpCommand(target);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "share",
		description: "Share session via an encrypted link (share server or secret gist)",
		handle: async (_command, runtime) => {
			try {
				const result = await shareSession(runtime.sessionManager, {
					serverUrl: runtime.settings.get("share.serverUrl"),
					store: runtime.settings.get("share.store"),
					state: runtime.session.state,
					obfuscator: runtime.settings.get("share.redactSecrets") ? runtime.session.obfuscator : undefined,
				});
				const lines = [`Share URL: ${result.url}`];
				if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
				if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to share session: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "collab",
		description: "Share this session live via a relay",
		inlineHint: "[start|view|stop|status] [relayUrl]",
		subcommands: [
			{ name: "view", description: "Share a read-only link (guests can watch, not prompt)" },
			{ name: "status", description: "Show link + participants" },
			{ name: "stop", description: "Stop sharing" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) {
				return `Collab: hosting (${Math.max(0, runtime.ctx.collabHost.participants.length - 1)} guests)`;
			}
			if (runtime.ctx.collabGuest?.readOnly) return "Collab: read-only guest";
			if (runtime.ctx.collabGuest) return "Collab: guest";
			return "Collab: off";
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const args = command.args.trim();
			const { verb, rest } = parseSubcommand(args);
			if (verb === "stop") {
				if (!ctx.collabHost) {
					ctx.showStatus("Not hosting a collab session");
					return;
				}
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus("Collab stopped");
				return;
			}
			if (verb === "status") {
				if (ctx.collabHost) {
					const names = ctx.collabHost.participants.map(p =>
						p.role === "host" ? `${p.name} (host)` : p.readOnly ? `${p.name} (view-only)` : p.name,
					);
					ctx.showStatus(`Collab: ${names.join(", ")} — ${collabWebLinkClickable(ctx.collabHost.webLink)}`);
				} else if (ctx.collabGuest) {
					ctx.showStatus(
						ctx.collabGuest.readOnly
							? "In a collab session as a read-only guest (/leave to exit)"
							: "In a collab session as a guest (/leave to exit)",
					);
				} else {
					ctx.showStatus("Not in a collab session");
				}
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError("Already in a collab session as a guest (/leave first)");
				return;
			}
			const knownStartVerb = verb === "start" || verb === "view";
			const view = verb === "view";
			if (ctx.collabHost) {
				showCollabLink(
					ctx,
					ctx.collabHost,
					view ? "Read-only collab session active" : "Collab session active",
					view,
				);
				return;
			}
			const explicitUrl = knownStartVerb ? rest : args;
			const relayInput = explicitUrl || ctx.settings.get("collab.relayUrl") || "";
			if (!relayInput) {
				ctx.showError(
					"No relay configured. Set collab.relayUrl in /settings or pass one: /collab relay.example.com",
				);
				return;
			}
			// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
			const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
			const webUrl = ctx.settings.get("collab.webUrl") || "";
			const host = new CollabHost(ctx);
			try {
				await host.start(relayUrl, webUrl);
			} catch (err) {
				ctx.showError(`Failed to start collab session: ${errorMessage(err)}`);
				return;
			}
			ctx.collabHost = host;
			showCollabLink(ctx, host, "Collab session started!", view);
		},
	},
	{
		name: "join",
		description: "Join a shared collab session",
		inlineHint: "<link>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const link = command.args.trim();
			if (!link) {
				ctx.showError("Usage: /join <link>");
				return;
			}
			if (ctx.collabHost) {
				ctx.showError("Stop hosting first (/collab stop)");
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError("Already in a collab session (/leave first)");
				return;
			}
			try {
				await new CollabGuestLink(ctx).join(link);
			} catch (err) {
				ctx.showError(`Failed to join collab session: ${errorMessage(err)}`);
			}
		},
	},
	{
		name: "leave",
		description: "Leave the collab session",
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) return "Leave collab: hosting";
			if (runtime.ctx.collabGuest) return "Leave collab: guest";
			return "Leave collab: not in collab";
		},
		handleTui: async (_command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			if (ctx.collabGuest) {
				await ctx.collabGuest.leave("left");
				return;
			}
			if (ctx.collabHost) {
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus("Collab stopped");
				return;
			}
			ctx.showStatus("Not in a collab session");
		},
	},
	{
		name: "browser",
		description: "Toggle browser headless vs visible mode",
		acpInputHint: "[headless|visible]",
		subcommands: [
			{ name: "headless", description: "Switch to headless mode" },
			{ name: "visible", description: "Switch to visible mode" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("browser.enabled" as SettingPath)) return "Browser: disabled";
			return runtime.ctx.settings.get("browser.headless" as SettingPath) ? "Browser: headless" : "Browser: visible";
		},
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const enabled = runtime.settings.get("browser.enabled" as SettingPath) as boolean;
			if (!enabled) return usage("Browser tool is disabled (enable in settings).", runtime);
			const current = runtime.settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!arg) next = !current;
			else if (arg === "headless" || arg === "hidden") next = true;
			else if (arg === "visible" || arg === "show" || arg === "headful") next = false;
			else return usage("Usage: /browser [headless|visible]", runtime);
			runtime.settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (err) {
					// Setting was already mutated; surface the restart failure so the
					// user knows the browser is in an inconsistent state.
					await runtime.output(
						`Browser mode set to ${next ? "headless" : "visible"}, but restart failed: ${errorMessage(err)}`,
					);
					return commandConsumed();
				}
			}
			await runtime.output(`Browser mode: ${next ? "headless" : "visible"}`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!(settings.get("browser.enabled" as SettingPath) as boolean)) {
				runtime.ctx.showWarning("Browser tool is disabled (enable in settings)");
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg) {
				next = !current;
			} else if (arg === "headless" || arg === "hidden") {
				next = true;
			} else if (arg === "visible" || arg === "show" || arg === "headful") {
				next = false;
			} else {
				runtime.ctx.showStatus("Usage: /browser [headless|visible]");
				runtime.ctx.editor.setText("");
				return;
			}
			settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.ctx.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (error) {
					runtime.ctx.showWarning(`Failed to restart browser: ${errorMessage(error)}`);
					runtime.ctx.editor.setText("");
					return;
				}
			}
			runtime.ctx.showStatus(`Browser mode: ${next ? "headless" : "visible"}`);
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
		name: "copy",
		description: "Pick text or code from the conversation to copy",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg) {
				runtime.ctx.showCopySelector();
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "code") {
				const block = extractLastCodeBlock(runtime.ctx.session.messages);
				if (!block) {
					runtime.ctx.showStatus("No code block to copy.");
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(block.code);
				runtime.ctx.showStatus("Copied code block to clipboard");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "cmd" || arg === "command") {
				const lastCommand = extractLastCommand(runtime.ctx.session.messages);
				if (!lastCommand) {
					runtime.ctx.showStatus("No command to copy.");
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(lastCommand.code);
				runtime.ctx.showStatus(`Copied ${lastCommand.kind === "bash" ? "bash command" : "eval code"} to clipboard`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /copy [code|cmd]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "todo",
		description: "View or modify the agent's todo list",
		acpDescription: "Manage todos",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "edit", description: "Open todos in $EDITOR (Markdown round-trip)" },
			{ name: "copy", description: "Copy todos as Markdown to clipboard" },
			{ name: "export", description: "Write todos as Markdown to a file (default: TODO.md)", usage: "[<path>]" },
			{ name: "import", description: "Replace todos from a Markdown file (default: TODO.md)", usage: "[<path>]" },
			{
				name: "append",
				description: "Append a task; phase fuzzy-matched or auto-created",
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: "Mark task in_progress (fuzzy-matched)", usage: "<task>" },
			{ name: "done", description: "Mark task/phase/all completed (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "drop", description: "Mark task/phase/all abandoned (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "rm", description: "Remove task/phase/all (fuzzy-matched)", usage: "[<task|phase>]" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const tasks = runtime.ctx.todoPhases.flatMap(phase => phase.tasks);
			if (tasks.length === 0) return "Todos: none";
			const pending = tasks.filter(task => task.status === "pending").length;
			const inProgress = tasks.filter(task => task.status === "in_progress").length;
			const completed = tasks.filter(task => task.status === "completed").length;
			return `Todos: ${pending + inProgress} open (${inProgress} in progress, ${completed} done)`;
		},
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "session",
		description: "Session management commands",
		acpDescription: "Show session information",
		acpInputHint: "info|delete",
		subcommands: [
			{ name: "info", description: "Show session info and stats" },
			{ name: "delete", description: "Delete current session and return to selector" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args || command.args === "info") {
				await runtime.output(
					[
						`Session: ${runtime.session.sessionId}`,
						`Title: ${runtime.session.sessionName}`,
						`CWD: ${runtime.cwd}`,
					].join("\n"),
				);
				return commandConsumed();
			}
			if (command.args === "delete") {
				if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage("No session file to delete (in-memory session).", runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(`Failed to delete session: ${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					`Session deleted: ${sessionFile}. Use ACP \`session/load\` to switch to another session.`,
				);
				return commandConsumed();
			}
			return usage("Usage: /session [info|delete]", runtime);
		},
		handleTui: async (command, runtime) => {
			const sub = command.args.trim().toLowerCase() || "info";
			if (sub === "delete") {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			// Default: show session info
			await runtime.ctx.handleSessionCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "jobs",
		description: "Show async background jobs status",
		acpDescription: "Show background jobs",
		getTuiAutocompleteDescription: runtime => {
			const snapshot = runtime.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) return "Jobs: none";
			return `Jobs: ${snapshot.running.length} running, ${snapshot.recent.length} recent`;
		},
		handle: async (_command, runtime) => {
			const snapshot = runtime.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) {
				await runtime.output(
					"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and for ~5 minutes after.)",
				);
				return commandConsumed();
			}
			const now = Date.now();
			const lines: string[] = ["Background Jobs", `Running: ${snapshot.running.length}`];
			if (snapshot.running.length > 0) {
				lines.push("", "Running Jobs");
				for (const job of snapshot.running) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			if (snapshot.recent.length > 0) {
				lines.push("", "Recent Jobs");
				for (const job of snapshot.recent) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "usage",
		description: "Show provider usage and limits",
		acpDescription: "Show token usage",
		acpInputHint: "[show|reset [account|active]]",
		subcommands: [
			{ name: "show", description: "Show provider usage and limits" },
			{ name: "reset", description: "Spend a saved Codex rate-limit reset", usage: "[account|active]" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if (verb === "reset") {
				await handleUsageResetCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("Usage: /usage [show|reset [account|active]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.ctx.handleUsageCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "reset") {
				if (rest) {
					await handleUsageResetCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
				} else {
					await runtime.ctx.showResetUsageSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /usage [show|reset [account|active]]");
			runtime.ctx.editor.setText("");
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
		name: "stats",
		description: "Launch the local stats dashboard",
		inlineHint: "[--port <port>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);

			await runtime.output("Syncing session files...");
			try {
				const result = await launchStatsDashboard(parsed);
				await runtime.output(result.message);
			} catch (error) {
				await runtime.output(`Stats dashboard failed: ${errorMessage(error)}`);
			}
			return commandConsumed();
		},
	},
	{
		name: "changelog",
		description: "Show changelog entries",
		acpDescription: "Show changelog",
		acpInputHint: "[full]",
		subcommands: [{ name: "full", description: "Show complete changelog" }],
		allowArgs: true,
		handle: async (command, runtime) => {
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const showFull = command.args.trim().toLowerCase() === "full";
			const entriesToShow = showFull ? allEntries : allEntries.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT);
			if (entriesToShow.length === 0) {
				await runtime.output("No changelog entries found.");
				return commandConsumed();
			}
			await runtime.output(renderChangelogEntries(entriesToShow).markdown);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const showFull = command.args.split(/\s+/).filter(Boolean).includes("full");
			await runtime.ctx.handleChangelogCommand(showFull);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hotkeys",
		description: "Show all keyboard shortcuts",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		description: "Show tools currently visible to the agent",
		acpDescription: "Show available tools",
		getTuiAutocompleteDescription: runtime => {
			const active = runtime.ctx.session.getActiveToolNames().length;
			const all = runtime.ctx.session.getAllToolNames().length;
			return all === 0 ? "Tools: none available" : `Tools: ${active} active / ${all} available`;
		},
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("No tools are available.");
				return commandConsumed();
			}
			await runtime.output(all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`).join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
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
		name: "context",
		description: "Show estimated context usage breakdown",
		acpDescription: "Show context usage",
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			if (
				!usage ||
				typeof usage.percent !== "number" ||
				typeof usage.tokens !== "number" ||
				typeof usage.contextWindow !== "number"
			) {
				return "Context: unavailable";
			}
			return `Context: ${Math.round(usage.percent)}% (${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)})`;
		},
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			runtime.ctx.editor.setText("");
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
		name: "extensions",
		aliases: ["status"],
		description: "Open Extension Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "agents",
		description: "Open Agent Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
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
		name: "branch",
		description: "Create a new branch from a previous message",
		handleTui: (_command, runtime) => {
			if (settings.get("doubleEscapeAction") === "tree") {
				runtime.ctx.showTreeSelector();
			} else {
				runtime.ctx.showUserMessageSelector();
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fork",
		description: "Create a new fork from a previous message",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		description: "Navigate session tree (switch branches)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		description: "Login with OAuth provider",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.oauthManualInput.hasPending()
				? `Login: waiting for ${runtime.ctx.oauthManualInput.pendingProviderId ?? "OAuth"} callback`
				: "Login: choose provider",
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? `OAuth login already in progress for ${pendingProvider}. Paste the redirect URL with /login <url>.`
							: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus("OAuth callback received; completing login…");
				} else {
					runtime.ctx.showWarning("No OAuth login is waiting for a manual callback.");
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? `OAuth login already in progress for ${provider}. Paste the redirect URL with /login <url>.`
					: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "logout",
		description: "Logout from OAuth provider",
		inlineHint: "[provider]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === providerId);
				if (!matchedProvider) {
					runtime.ctx.showWarning(`Unknown OAuth provider: ${providerId}`);
					runtime.ctx.editor.setText("");
					return;
				}
				void runtime.ctx.showOAuthSelector("logout", matchedProvider.id);
				runtime.ctx.editor.setText("");
				return;
			}
			void runtime.ctx.showOAuthSelector("logout");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "mcp",
		description: "Manage MCP servers (add, list, remove, test)",
		acpDescription: "Manage MCP servers",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add a new MCP server",
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{
				name: "smithery-search",
				description: "Search Smithery registry and deploy an MCP server",
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: "Login to Smithery and cache API key" },
			{ name: "smithery-logout", description: "Remove cached Smithery API key" },
			{ name: "reconnect", description: "Reconnect to a specific MCP server", usage: "<name>" },
			{ name: "reload", description: "Force reload MCP runtime tools" },
			{ name: "resources", description: "List available resources from connected servers" },
			{ name: "prompts", description: "List available prompts from connected servers" },
			{ name: "notifications", description: "Show notification capabilities and subscriptions" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
	{
		name: "ssh",
		description: "Manage SSH hosts (add, list, remove)",
		acpDescription: "Manage SSH connections",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add an SSH host",
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]",
			},
			{ name: "list", description: "List all configured SSH hosts" },
			{ name: "remove", description: "Remove an SSH host", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		description: "Start a new session",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleClearCommand();
		},
	},
	{
		name: "fresh",
		description: "Reset provider stream state without changing the local transcript",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming ? "Fresh: unavailable while streaming" : "Fresh: ready",
		handle: async (_command, runtime) => {
			const result = runtime.session.freshSession();
			if (!result) {
				await runtime.output(
					"Wait for the current response to finish or abort it before refreshing provider state.",
				);
				return commandConsumed();
			}
			await runtime.output(formatFreshSessionResult(result));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleFreshCommand();
		},
	},
	{
		name: "drop",
		description: "Delete the current session and start a new one",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleDropCommand();
		},
	},
	{
		name: "compact",
		description: "Manually compact the session context",
		acpDescription: "Compact the conversation",
		subcommands: COMPACT_MODES.map(mode => ({
			name: mode.name,
			description: mode.description,
			usage: mode.rejectsFocus ? undefined : "[focus]",
		})),
		acpInputHint: `[${COMPACT_MODES.map(mode => mode.name).join("|")}] [focus]`,
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			if (!usage || typeof usage.percent !== "number") return "Compact: context unavailable";
			return `Compact: context ${Math.round(usage.percent)}% used`;
		},
		handle: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			const before = runtime.session.getContextUsage?.();
			const beforeTokens = before?.tokens;
			try {
				await runtime.session.compact(parsed.instructions, parsed.mode ? { mode: parsed.mode } : undefined);
			} catch (err) {
				// Compaction precondition failures (no model, already compacted, too
				// small) and provider errors propagate as plain Errors; surface them
				// via runtime.output so they don't fail the ACP prompt turn.
				return usage(`Compaction failed: ${errorMessage(err)}`, runtime);
			}
			const after = runtime.session.getContextUsage?.();
			const afterTokens = after?.tokens;
			if (beforeTokens != null && afterTokens != null) {
				const saved = beforeTokens - afterTokens;
				await runtime.output(`Compaction complete. Tokens: ${beforeTokens} -> ${afterTokens} (saved ${saved}).`);
			} else {
				await runtime.output("Compaction complete.");
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			runtime.ctx.editor.setText("");
			if ("error" in parsed) {
				runtime.ctx.showWarning(parsed.error);
				return;
			}
			await runtime.ctx.handleCompactCommand(parsed.instructions, parsed.mode);
		},
	},
	{
		name: "shake",
		description: "Drop heavy content from context (tool results, large blocks)",
		acpDescription: "Shake heavy content out of the conversation context",
		subcommands: [
			{ name: "elide", description: "Strip tool results + large blocks (default)" },
			{ name: "images", description: "Strip image blocks" },
		],
		acpInputHint: "[elide|images]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") return usage(mode.error, runtime);
			const result = await runtime.session.shake(mode);
			await runtime.output(formatShakeSummary(result));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") {
				runtime.ctx.showWarning(mode.error);
				return;
			}
			await runtime.ctx.handleShakeCommand(mode);
		},
	},
	{
		name: "handoff",
		description: "Hand off session context to a new session",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	{
		name: "resume",
		description: "Resume a different session",
		inlineHint: "[session id]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const sessionArg = command.args.trim();
			runtime.ctx.editor.setText("");
			if (!sessionArg) {
				runtime.ctx.showSessionSelector();
				return;
			}
			const match = await resolveResumableSession(
				sessionArg,
				runtime.ctx.sessionManager.getCwd(),
				runtime.ctx.sessionManager.getSessionDir(),
				{ allowGlobalFallback: true },
			);
			if (!match) {
				runtime.ctx.showError(`Session "${sessionArg}" not found`);
				return;
			}
			await runtime.ctx.handleResumeSession(match.session.path);
		},
	},
	{
		name: "btw",
		description: "Ask an ephemeral side question using the current session context",
		inlineHint: "<question>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleBtwCommand(question);
		},
	},
	{
		name: "tan",
		description: "Run a full background agent on tangential work",
		inlineHint: "<work>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const work = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleTanCommand(work);
		},
	},
	{
		name: "omfg",
		description: "Forge a TTSR rule from a complaint to stop a recurring behavior",
		inlineHint: "<complaint>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const complaint = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleOmfgCommand(complaint);
		},
	},
	{
		name: "retry",
		description: "Retry the last failed agent turn",
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus("Nothing to retry");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "debug",
		description: "Open debug tools selector",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "memory",
		description: "Inspect and operate memory maintenance",
		acpDescription: "Manage memory",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: "Show current memory injection payload" },
			{ name: "stats", description: "Show memory backend statistics" },
			{ name: "diagnose", description: "Run memory backend diagnostics" },
			{ name: "clear", description: "Clear persisted memory data and artifacts" },
			{ name: "reset", description: "Alias for clear" },
			{ name: "enqueue", description: "Enqueue memory consolidation maintenance" },
			{ name: "rebuild", description: "Alias for enqueue" },
			{ name: "mm list", description: "List mental models on the active bank" },
			{ name: "mm show", description: "Show one mental model (id required)" },
			{
				name: "mm refresh",
				description: "Refresh auto-refresh models bank-wide, or one model by id",
			},
			{ name: "mm history", description: "Diff the change history of a mental model" },
			{ name: "mm seed", description: "Create any built-in mental models that are missing" },
			{ name: "mm delete", description: "Delete a mental model from the bank (id required)" },
			{ name: "mm reload", description: "Re-pull the cached <mental_models> block" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = await resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await backend.buildDeveloperInstructions(
						runtime.settings.getAgentDir(),
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || "Memory payload is empty.");
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output("Memory cleared.");
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output("Memory consolidation enqueued.");
					return commandConsumed();
				}
				case "stats":
				case "diagnose": {
					const hook = verb === "stats" ? backend.stats : backend.diagnose;
					const payload = await hook?.(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(payload ?? `Memory ${verb} is not available for the ${backend.id} backend.`);
					return commandConsumed();
				}
				case "mm":
					return usage(
						"Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.",
						runtime,
					);
				default:
					return usage("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild>", runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMemoryCommand(command.text);
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
								entry =>
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
		name: "rename",
		description: "Rename the current session",
		inlineHint: "<title>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args) return usage("Usage: /rename <title>", runtime);
			const ok = await runtime.sessionManager.setSessionName(command.args, "user");
			if (!ok) {
				await runtime.output("Session name not changed (a user-set name takes precedence).");
				return commandConsumed();
			}
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Session renamed to ${command.args}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const title = command.args.trim();
			if (!title) {
				runtime.ctx.showError("Usage: /rename <title>");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		description: "Move the current session to a different directory",
		acpDescription: "Move the current session to a different directory",
		inlineHint: "[<path>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot move while streaming.", runtime);
			if (!command.args) return usage("Usage: /move <path>", runtime);
			const resolvedPath =
				resolveWorkspaceRootReference(command.args, runtime.session.workspaceRoots) ??
				resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isDirectory()) {
					return usage(`Not a directory: ${resolvedPath}`, runtime);
				}
			} catch {
				return usage(`Directory does not exist: ${resolvedPath}`, runtime);
			}
			try {
				await runtime.sessionManager.flush();
				await runtime.sessionManager.moveTo(resolvedPath);
			} catch (err) {
				return usage(`Move failed: ${errorMessage(err)}`, runtime);
			}
			setProjectDir(resolvedPath);
			await runtime.settings.reloadForCwd(resolvedPath);
			applyProviderGlobalsFromSettings(runtime.settings);
			// Reload plugin/capability caches so the next prompt sees commands and
			// capabilities scoped to the new cwd.
			await runtime.reloadPlugins();
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.notifyConfigChanged?.();
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Moved to ${runtime.sessionManager.getCwd()}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMoveCommand(command.args || undefined);
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
		name: "exit",
		description: "Exit the application",
		handleTui: shutdownHandlerTui,
	},
	{
		name: "marketplace",
		description: "Manage marketplace plugin sources and installed plugins",
		acpDescription: "Manage plugins from marketplaces",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "add", description: "Add a marketplace source", usage: "<source>" },
			{ name: "remove", description: "Remove a marketplace source", usage: "<name>" },
			{ name: "update", description: "Update marketplace catalog(s)", usage: "[name]" },
			{ name: "list", description: "List configured marketplaces" },
			{ name: "discover", description: "Browse available plugins", usage: "[marketplace]" },
			{
				name: "install",
				description: "Install a plugin (interactive browser if no args)",
				usage: "[--force] [name@marketplace]",
			},
			{ name: "uninstall", description: "Uninstall a plugin (selector if no args)", usage: "[name@marketplace]" },
			{ name: "installed", description: "List installed marketplace plugins" },
			{ name: "upgrade", description: "Upgrade outdated plugins", usage: "[name@marketplace]" },
			{ name: "help", description: "Show usage guide" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb) {
				try {
					const manager = await createMarketplaceManager(runtime);
					const marketplaces = await manager.listMarketplaces();
					if (marketplaces.length === 0) {
						await runtime.output(
							"No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse with /marketplace discover",
						);
					} else {
						const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
						await runtime.output(
							`Marketplaces:\n${lines.join("\n")}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands`,
						);
					}
					return commandConsumed();
				} catch (err) {
					return usage(`Marketplace error: ${errorMessage(err)}`, runtime);
				}
			}
			if (verb === "help") {
				await runtime.output(
					[
						"Marketplace commands:",
						"  /marketplace                              List configured marketplaces",
						"  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)",
						"  /marketplace remove <name>                 Remove a marketplace",
						"  /marketplace update [name]                 Re-fetch catalog(s)",
						"  /marketplace list                          List configured marketplaces",
						"  /marketplace discover [marketplace]        Browse available plugins",
						"  /marketplace install <name@marketplace>    Install a plugin",
						"  /marketplace uninstall <name@marketplace>  Uninstall a plugin",
						"  /marketplace installed                     List installed plugins",
						"  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)",
						"",
						"Quick start:",
						"  /marketplace add anthropics/claude-plugins-official",
					].join("\n"),
				);
				return commandConsumed();
			}
			if ((verb === "install" || verb === "uninstall") && !rest) {
				return usage(
					"Interactive plugin pickers are TUI-only. Pass an explicit name@marketplace argument.",
					runtime,
				);
			}
			try {
				const manager = await createMarketplaceManager(runtime);
				switch (verb) {
					case "add": {
						if (!rest) return usage("Usage: /marketplace add <source>", runtime);
						const entry = await manager.addMarketplace(rest);
						await runtime.output(`Added marketplace: ${entry.name}`);
						return commandConsumed();
					}
					case "remove":
					case "rm": {
						if (!rest) return usage("Usage: /marketplace remove <name>", runtime);
						await manager.removeMarketplace(rest);
						await runtime.output(`Removed marketplace: ${rest}`);
						return commandConsumed();
					}
					case "update": {
						if (rest) {
							await manager.updateMarketplace(rest);
							await runtime.output(`Updated marketplace: ${rest}`);
						} else {
							const results = await manager.updateAllMarketplaces();
							await runtime.output(`Updated ${results.length} marketplace(s)`);
						}
						return commandConsumed();
					}
					case "list": {
						const marketplaces = await manager.listMarketplaces();
						if (marketplaces.length === 0) {
							await runtime.output("No marketplaces configured.");
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							await runtime.output(`Marketplaces:\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					case "discover": {
						const plugins = await manager.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await manager.listMarketplaces();
							await runtime.output(
								marketplaces.length === 0
									? "No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official"
									: "No plugins available in configured marketplaces",
							);
							return commandConsumed();
						}
						const lines = ["Available plugins:"];
						for (const plugin of plugins) {
							lines.push(`  - ${plugin.name}${plugin.version ? `@${plugin.version}` : ""}`);
							if (plugin.description) lines.push(`      ${plugin.description}`);
						}
						await runtime.output(lines.join("\n"));
						return commandConsumed();
					}
					case "install": {
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) return usage(parsed.error, runtime);
						const atIndex = parsed.installSpec.lastIndexOf("@");
						const pluginName = parsed.installSpec.slice(0, atIndex);
						const marketplace = parsed.installSpec.slice(atIndex + 1);
						await manager.installPlugin(pluginName, marketplace, { force: parsed.force, scope: parsed.scope });
						await runtime.reloadPlugins();
						await runtime.output(`Installed ${pluginName} from ${marketplace}`);
						return commandConsumed();
					}
					case "uninstall": {
						const parsed = parsePluginScopeArgs(
							rest,
							"Usage: /marketplace uninstall [--scope user|project] <name@marketplace>",
						);
						if ("error" in parsed) return usage(parsed.error, runtime);
						await manager.uninstallPlugin(parsed.pluginId, parsed.scope);
						await runtime.reloadPlugins();
						await runtime.output(`Uninstalled ${parsed.pluginId}`);
						return commandConsumed();
					}
					case "installed": {
						const installed = await manager.listInstalledPlugins();
						if (installed.length === 0) {
							await runtime.output("No marketplace plugins installed");
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							await runtime.output(`Installed plugins:\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					case "upgrade": {
						if (rest) {
							const parsed = parsePluginScopeArgs(
								rest,
								"Usage: /marketplace upgrade [--scope user|project] <name@marketplace>",
							);
							if ("error" in parsed) return usage(parsed.error, runtime);
							const result = await manager.upgradePlugin(parsed.pluginId, parsed.scope);
							await runtime.reloadPlugins();
							await runtime.output(`Upgraded ${parsed.pluginId} to ${result.version}`);
							return commandConsumed();
						}
						const results = await manager.upgradeAllPlugins();
						if (results.length === 0) {
							await runtime.output("All marketplace plugins are up to date");
						} else {
							await runtime.reloadPlugins();
							const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
							await runtime.output(`Upgraded ${results.length} plugin(s):\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					default:
						return usage(
							`Unknown /marketplace subcommand: ${verb}. Use /marketplace help for available commands.`,
							runtime,
						);
				}
			} catch (err) {
				return usage(`Marketplace error: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "install";
			const rest = args.slice(1).join(" ").trim();

			// /marketplace (no args) or /marketplace install (no args) → interactive browser
			if ((sub === "install" && !rest) || (!args[0] && !command.args.trim())) {
				const mgr = new MarketplaceManager({
					marketplacesRegistryPath: getMarketplacesRegistryPath(),
					installedRegistryPath: getInstalledPluginsRegistryPath(),
					projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
						runtime.ctx.sessionManager.getCwd(),
					),
					marketplacesCacheDir: getMarketplacesCacheDir(),
					pluginsCacheDir: getPluginsCacheDir(),
					clearPluginRootsCache: clearPluginRootsAndCaches,
				});
				try {
					const installedSnapshot = await readInstalledPluginSnapshot(mgr);
					runtime.ctx.showPluginSelector("install");
					refreshPluginStateAfterSelectorMutation(runtime.ctx, mgr, installedSnapshot);
				} catch (err) {
					runtime.ctx.showStatus(`Marketplace error: ${err}`);
				}
				return;
			}

			const mgr = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
					runtime.ctx.sessionManager.getCwd(),
				),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});

			try {
				switch (sub) {
					case "add": {
						if (!rest) {
							runtime.ctx.showStatus("Usage: /marketplace add <source>");
							return;
						}
						const entry = await mgr.addMarketplace(rest);
						runtime.ctx.showStatus(`Added marketplace: ${entry.name}`);
						break;
					}
					case "remove":
					case "rm": {
						if (!rest) {
							runtime.ctx.showStatus("Usage: /marketplace remove <name>");
							return;
						}
						await mgr.removeMarketplace(rest);
						runtime.ctx.showStatus(`Removed marketplace: ${rest}`);
						break;
					}
					case "update": {
						if (rest) {
							await mgr.updateMarketplace(rest);
							runtime.ctx.showStatus(`Updated marketplace: ${rest}`);
						} else {
							const results = await mgr.updateAllMarketplaces();
							runtime.ctx.showStatus(`Updated ${results.length} marketplace(s)`);
						}
						break;
					}
					case "discover": {
						const plugins = await mgr.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await mgr.listMarketplaces();
							if (marketplaces.length === 0) {
								runtime.ctx.showStatus(
									"No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official",
								);
							} else {
								runtime.ctx.showStatus("No plugins available in configured marketplaces");
							}
						} else {
							const lines = plugins.map(
								p =>
									`  ${p.name}${p.version ? `@${p.version}` : ""}${p.description ? ` - ${p.description}` : ""}`,
							);
							runtime.ctx.showStatus(`Available plugins:\n${lines.join("\n")}`);
						}
						break;
					}
					case "install": {
						// Parse: /marketplace install [--force] [--scope user|project] name@marketplace
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const atIdx = parsed.installSpec.lastIndexOf("@");
						const name = parsed.installSpec.slice(0, atIdx);
						const marketplace = parsed.installSpec.slice(atIdx + 1);
						await mgr.installPlugin(name, marketplace, { force: parsed.force, scope: parsed.scope });
						await runtime.ctx.refreshPluginState();
						runtime.ctx.showStatus(`Installed ${name} from ${marketplace}`);
						break;
					}
					case "uninstall": {
						if (!rest) {
							// No args → open interactive uninstall selector
							const installedSnapshot = await readInstalledPluginSnapshot(mgr);
							runtime.ctx.showPluginSelector("uninstall");
							refreshPluginStateAfterSelectorMutation(runtime.ctx, mgr, installedSnapshot);
							return;
						}
						const uninstArgs = parsePluginScopeArgs(
							rest,
							"Usage: /marketplace uninstall [--scope user|project] <name@marketplace>",
						);
						if ("error" in uninstArgs) {
							runtime.ctx.showStatus(uninstArgs.error);
							return;
						}
						await mgr.uninstallPlugin(uninstArgs.pluginId, uninstArgs.scope);
						await runtime.ctx.refreshPluginState();
						runtime.ctx.showStatus(`Uninstalled ${uninstArgs.pluginId}`);
						break;
					}
					case "installed": {
						const installed = await mgr.listInstalledPlugins();
						if (installed.length === 0) {
							runtime.ctx.showStatus("No marketplace plugins installed");
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							runtime.ctx.showStatus(`Installed plugins:\n${lines.join("\n")}`);
						}
						break;
					}
					case "upgrade": {
						if (rest) {
							const upArgs = parsePluginScopeArgs(
								rest,
								"Usage: /marketplace upgrade [--scope user|project] <name@marketplace>",
							);
							if ("error" in upArgs) {
								runtime.ctx.showStatus(upArgs.error);
								return;
							}
							const result = await mgr.upgradePlugin(upArgs.pluginId, upArgs.scope);
							await runtime.ctx.refreshPluginState();
							runtime.ctx.showStatus(`Upgraded ${upArgs.pluginId} to ${result.version}`);
						} else {
							const results = await mgr.upgradeAllPlugins();
							if (results.length === 0) {
								runtime.ctx.showStatus("All marketplace plugins are up to date");
							} else {
								await runtime.ctx.refreshPluginState();
								const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
								runtime.ctx.showStatus(`Upgraded ${results.length} plugin(s):\n${lines.join("\n")}`);
							}
						}
						break;
					}
					case "help": {
						runtime.ctx.showStatus(
							[
								"Marketplace commands:",
								"  /marketplace                              Browse and install plugins",
								"  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)",
								"  /marketplace remove <name>                 Remove a marketplace",
								"  /marketplace update [name]                 Re-fetch catalog(s)",
								"  /marketplace list                          List configured marketplaces",
								"  /marketplace discover [marketplace]        Browse available plugins",
								"  /marketplace install <name@marketplace>    Install a plugin",
								"  /marketplace uninstall <name@marketplace>  Uninstall a plugin",
								"  /marketplace installed                     List installed plugins",
								"  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)",
								"",
								"Quick start:",
								"  /marketplace add anthropics/claude-plugins-official",
								"  /marketplace                               (opens interactive browser)",
							].join("\n"),
						);
						break;
					}
					default: {
						const marketplaces = await mgr.listMarketplaces();
						if (marketplaces.length === 0) {
							runtime.ctx.showStatus(
								"No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse plugins with /marketplace or /marketplace discover",
							);
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							runtime.ctx.showStatus(
								`Marketplaces:\n${lines.join("\n")}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands`,
							);
						}
						break;
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				runtime.ctx.showStatus(`Marketplace error: ${msg}`);
			}
		},
	},
	{
		name: "plugins",
		description: "View and manage installed plugins",
		acpDescription: "Manage plugins",
		acpInputHint: "[list|enable|disable]",
		subcommands: [
			{ name: "list", description: "List all installed plugins (npm + marketplace)" },
			{ name: "enable", description: "Enable a marketplace plugin", usage: "<name@marketplace>" },
			{ name: "disable", description: "Disable a marketplace plugin", usage: "<name@marketplace>" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			try {
				if (verb === "enable" || verb === "disable") {
					const parsed = parsePluginScopeArgs(
						rest,
						`Usage: /plugins ${verb} [--scope user|project] <name@marketplace>`,
					);
					if ("error" in parsed) return usage(parsed.error, runtime);
					const manager = await createMarketplaceManager(runtime);
					const isEnable = verb === "enable";
					await manager.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
					await runtime.reloadPlugins();
					await runtime.output(`${isEnable ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
					return commandConsumed();
				}
				// Default: list
				const lines: string[] = [];
				const npmManager = new PluginManager();
				const npmPlugins = await npmManager.list();
				if (npmPlugins.length > 0) {
					lines.push("npm plugins:");
					for (const plugin of npmPlugins) {
						const status = plugin.enabled === false ? " (disabled)" : "";
						lines.push(`  ${plugin.name}@${plugin.version}${status}`);
					}
				}

				const marketplaceManager = await createMarketplaceManager(runtime);
				const marketplacePlugins = await marketplaceManager.listInstalledPlugins();
				if (marketplacePlugins.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push("marketplace plugins:");
					for (const plugin of marketplacePlugins) {
						const entry = plugin.entries[0];
						const status = entry?.enabled === false ? " (disabled)" : "";
						const shadowed = plugin.shadowedBy ? " [shadowed]" : "";
						lines.push(`  ${plugin.id} v${entry?.version ?? "?"}${status} [${plugin.scope}]${shadowed}`);
					}
				}

				await runtime.output(lines.length === 0 ? "No plugins installed" : lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(`Plugin error: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "list";
			const rest = args.slice(1).join(" ").trim();

			try {
				const mgr = new MarketplaceManager({
					marketplacesRegistryPath: getMarketplacesRegistryPath(),
					installedRegistryPath: getInstalledPluginsRegistryPath(),
					projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
						runtime.ctx.sessionManager.getCwd(),
					),
					marketplacesCacheDir: getMarketplacesCacheDir(),
					pluginsCacheDir: getPluginsCacheDir(),
					clearPluginRootsCache: clearPluginRootsAndCaches,
				});

				switch (sub) {
					case "enable":
					case "disable": {
						const parsed = parsePluginScopeArgs(
							rest ?? "",
							`Usage: /plugins ${sub} [--scope user|project] <name@marketplace>`,
						);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const isEnable = sub === "enable";
						await mgr.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
						await runtime.ctx.refreshPluginState();
						runtime.ctx.showStatus(`${isEnable ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
						break;
					}
					default: {
						const lines: string[] = [];

						const npm = new PluginManager();
						const npmPlugins = await npm.list();
						if (npmPlugins.length > 0) {
							lines.push("npm plugins:");
							for (const p of npmPlugins) {
								const status = p.enabled === false ? " (disabled)" : "";
								lines.push(`  ${p.name}@${p.version}${status}`);
							}
						}

						const mktPlugins = await mgr.listInstalledPlugins();
						if (mktPlugins.length > 0) {
							if (lines.length > 0) lines.push("");
							lines.push("marketplace plugins:");
							for (const p of mktPlugins) {
								const entry = p.entries[0];
								const status = entry?.enabled === false ? " (disabled)" : "";
								const shadowed = p.shadowedBy ? " [shadowed]" : "";
								lines.push(`  ${p.id} v${entry?.version ?? "?"}${status} [${p.scope}]${shadowed}`);
							}
						}

						if (lines.length === 0) {
							runtime.ctx.showStatus("No plugins installed");
						} else {
							runtime.ctx.showStatus(lines.join("\n"));
						}
						break;
					}
				}
			} catch (err) {
				runtime.ctx.showStatus(`Plugin error: ${err}`);
			}
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
		name: "reload-plugins",
		description: "Reload all plugins (skills, commands, hooks, tools, agents, MCP)",
		acpDescription: "Reload all plugins",
		handle: async (_command, runtime) => {
			await runtime.reloadPlugins();
			await runtime.output("Plugins reloaded.");
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			// Invalidate registry fs caches and the plugin roots cache so
			// listClaudePluginRoots re-reads from disk on next access.
			const projectPath = await resolveActiveProjectRegistryPath(runtime.ctx.sessionManager.getCwd());
			clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
			await runtime.ctx.refreshPluginState();
			runtime.ctx.showStatus("Plugins reloaded.");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "force",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? "Force: no active tools" : `Force: ${count} active tools`;
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "quit",
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/**
 * Build getArgumentCompletions from declarative subcommand definitions.
 * Returns subcommand names filtered by prefix in the dropdown.
 */
function buildArgumentCompletions(subcommands: SubcommandDef[]): (prefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null; // past the subcommand
		const lower = argumentPrefix.toLowerCase();
		const matches = subcommands
			.filter(s => s.name.startsWith(lower))
			.map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
				hint: s.usage,
			}));
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build getInlineHint from declarative subcommand definitions.
 * Shows remaining completion + usage as dim ghost text after cursor.
 */
function buildSubcommandInlineHint(subcommands: SubcommandDef[]): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		const spaceIndex = trimmed.indexOf(" ");

		if (spaceIndex === -1) {
			// Still typing subcommand name — show remaining chars + usage
			const prefix = trimmed.toLowerCase();
			if (prefix.length === 0) return null;
			const match = subcommands.find(s => s.name.startsWith(prefix));
			if (!match) return null;
			const remaining = match.name.slice(prefix.length);
			return remaining + (match.usage ? ` ${match.usage}` : "");
		}

		// Subcommand typed — show remaining usage params
		const subName = trimmed.slice(0, spaceIndex).toLowerCase();
		const afterSub = trimmed.slice(spaceIndex + 1);
		const sub = subcommands.find(s => s.name === subName);
		if (!sub?.usage) return null;

		if (afterSub.length > 0) {
			const usageParts = sub.usage.split(" ");
			const inputParts = afterSub.trim().split(/\s+/);
			const remaining = usageParts.slice(inputParts.length);
			return remaining.length > 0 ? remaining.join(" ") : null;
		}

		return sub.usage;
	};
}

/**
 * Build getInlineHint for commands with a simple static hint string.
 * Shows the hint only when no arguments have been typed yet.
 */
function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

/**
 * Build getArgumentCompletions that suggests directories relative to the
 * current project directory. Used by /move so users can Tab-complete the
 * destination directory.
 */
function buildDirectoryArgumentCompletions(): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trim();

		const cwd = getProjectDir();
		const expandedPrefix = expandTilde(prefix);
		const isAbsolute = path.isAbsolute(expandedPrefix);

		let searchDir: string;
		let searchPrefix: string;
		if (
			prefix === "" ||
			prefix === "." ||
			prefix === "./" ||
			prefix === ".." ||
			prefix === "../" ||
			prefix === "~" ||
			prefix === "~/" ||
			prefix === "/"
		) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else if (expandedPrefix.endsWith("/")) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else {
			const dir = path.dirname(expandedPrefix);
			searchDir = isAbsolute ? dir : path.join(cwd, dir);
			searchPrefix = path.basename(expandedPrefix);
		}

		try {
			const entries = await fs.readdir(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];
			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;
				if (entry.name === ".git") continue;

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						isDirectory = (await fs.stat(path.join(searchDir, entry.name))).isDirectory();
					} catch {
						continue;
					}
				}
				if (!isDirectory) continue;

				const absoluteValue = path.join(searchDir, entry.name);
				const displayValue = buildDirectoryCompletionDisplayValue(prefix, absoluteValue, cwd);
				suggestions.push({ value: displayValue, label: `${entry.name}/` });
			}
			suggestions.sort((a, b) => a.label.localeCompare(b.label));
			return suggestions.length > 0 ? suggestions : null;
		} catch {
			return null;
		}
	};
}
function buildDirectoryCompletionDisplayValue(prefix: string, absoluteValue: string, cwd: string): string {
	// Preserve the user's prefix style where possible, but always return a
	// value that /move can resolve (absolute or relative) without escaping.
	const normalized = path.normalize(absoluteValue);

	if (prefix.startsWith("~/")) {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "~") {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("/")) {
		return `${normalized.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("./")) {
		const relative = path.relative(cwd, normalized);
		return `./${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("../")) {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "..") {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}

	// Default: relative to cwd.
	const relative = path.relative(cwd, normalized);
	return `${relative.replaceAll("\\", "/")}/`;
}

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
		materialized.getArgumentCompletions = buildArgumentCompletions(cmd.subcommands);
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
			reloadPlugins: async () => {
				const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
				clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
				await ctx.refreshPluginState();
			},
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
