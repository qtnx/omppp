import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import macosSandboxDescription from "../prompts/tools/macos-sandbox.md" with { type: "text" };
import type { MacOSSandboxRelaunchResult } from "../task/omp-command";
import {
	buildMacOSSandboxRelaunchArgv,
	formatMacOSSandboxRestartCommand,
	resolveMacOSSandboxWorkspaceDirs,
} from "../task/omp-command";
import type { ToolSession } from "./index";

const macosSandboxSchema = z
	.object({
		paths: z
			.array(z.string().min(1).describe("trusted workspace directory path"))
			.min(1)
			.describe("directories to allow"),
	})
	.describe("request a macOS sandbox relaunch with extra working directories");

export interface MacOSSandboxToolDetails {
	paths: string[];
	relaunchRequested: boolean;
	reason?: MacOSSandboxRelaunchResult["reason"];
	restartArgs?: string[];
}

type MacOSSandboxParams = z.infer<typeof macosSandboxSchema>;

export class MacOSSandboxTool implements AgentTool<typeof macosSandboxSchema, MacOSSandboxToolDetails> {
	readonly name = "sandbox";
	readonly approval = "write" as const;
	readonly label = "Sandbox";
	readonly summary = "Add trusted working directories to the macOS sandbox allowlist";
	readonly description = prompt.render(macosSandboxDescription);
	readonly parameters = macosSandboxSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: MacOSSandboxParams): Promise<AgentToolResult<MacOSSandboxToolDetails>> {
		const resolved = resolveMacOSSandboxWorkspaceDirs(params.paths, this.session.cwd);
		const paths = resolved.paths;
		if (resolved.error) {
			return {
				content: [
					{
						type: "text",
						text: `Refusing to whitelist unsafe sandbox directory: ${resolved.error}. Use a project/workspace directory instead.`,
					},
				],
				details: { paths, relaunchRequested: false, reason: "unsafe-path" },
				isError: true,
			};
		}
		const sessionFile = this.session.getSessionFile();
		const sessionId = sessionFile ? (this.session.getSessionId?.() ?? null) : null;
		const relaunchPaths = [
			this.session.cwd,
			...(this.session.workspaceRoots?.map(root => root.path) ?? []),
			...paths,
		];
		const result = sessionId
			? (this.session.requestMacOSSandboxRelaunch?.(relaunchPaths) ?? {
					requested: false,
					reason: "missing-supervisor" as const,
				})
			: ({ requested: false, reason: "missing-session" } as const);
		if (result.requested) {
			return {
				content: [
					{
						type: "text",
						text: `Requested a sandbox relaunch with additional working directories:\n${paths.map(p => `- ${p}`).join("\n")}`,
					},
				],
				details: { paths, relaunchRequested: true },
			};
		}

		const previousArgv = sessionFile ? ["--session-dir", path.dirname(sessionFile)] : [];
		const restartArgs = sessionId ? buildMacOSSandboxRelaunchArgv(previousArgv, sessionId, relaunchPaths) : undefined;
		const restartLine = restartArgs ? `\n\nManual restart: ${formatMacOSSandboxRestartCommand(restartArgs)}` : "";
		return {
			content: [
				{
					type: "text",
					text: `Could not relaunch the active macOS sandbox (${result.reason ?? "unknown"}); restart OMPx from your shell with the extra working directories.${restartLine}`,
				},
			],
			details: { paths, relaunchRequested: false, reason: result.reason, restartArgs },
			isError: true,
		};
	}
}
