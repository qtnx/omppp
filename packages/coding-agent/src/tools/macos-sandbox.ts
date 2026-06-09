import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import macosSandboxDescription from "../prompts/tools/macos-sandbox.md" with { type: "text" };
import type { MacOSSandboxRelaunchResult } from "../task/omp-command";
import {
	buildMacOSSandboxRelaunchArgv,
	formatMacOSSandboxRestartCommand,
	resolveMacOSSandboxAllowedPaths,
} from "../task/omp-command";
import type { ToolSession } from "./index";

const macosSandboxSchema = z
	.object({
		paths: z
			.array(z.string().min(1).describe("trusted file or directory path"))
			.min(1)
			.describe("directories or files to allow"),
		remember: z
			.boolean()
			.default(false)
			.describe("persist these paths to the global sandbox.allowedPaths config after user approval")
			.optional(),
	})
	.describe("request a macOS sandbox relaunch with extra allowed files or directories");

export interface MacOSSandboxToolDetails {
	paths: string[];
	relaunchRequested: boolean;
	reason?: MacOSSandboxRelaunchResult["reason"];
	restartArgs?: string[];
	persisted?: boolean;
}

type MacOSSandboxParams = z.infer<typeof macosSandboxSchema>;

function appendSandboxAllowedPaths(current: readonly string[], paths: readonly string[]): string[] {
	const next = [...current];
	for (const allowedPath of paths) {
		if (!next.includes(allowedPath)) {
			next.push(allowedPath);
		}
	}
	return next;
}
export class MacOSSandboxTool implements AgentTool<typeof macosSandboxSchema, MacOSSandboxToolDetails> {
	readonly name = "sandbox";
	readonly approval = "write" as const;
	readonly label = "Sandbox";
	readonly summary = "Add trusted files or directories to the macOS sandbox allowlist";
	readonly description = prompt.render(macosSandboxDescription);
	readonly parameters = macosSandboxSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: MacOSSandboxParams): Promise<AgentToolResult<MacOSSandboxToolDetails>> {
		const resolved = resolveMacOSSandboxAllowedPaths(params.paths, this.session.cwd);
		const paths = resolved.paths;
		if (resolved.error) {
			return {
				content: [
					{
						type: "text",
						text: `Refusing to whitelist unsafe sandbox path: ${resolved.error}. Use a trusted project/workspace directory or specific file instead.`,
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
		const persisted = params.remember
			? appendSandboxAllowedPaths(this.session.settings.getTrusted("sandbox.allowedPaths"), paths)
			: null;
		if (persisted) {
			this.session.settings.set("sandbox.allowedPaths", persisted);
			await this.session.settings.flush();
		}
		const result = sessionId
			? (this.session.requestMacOSSandboxRelaunch?.(relaunchPaths) ?? {
					requested: false,
					reason: "missing-supervisor" as const,
				})
			: ({ requested: false, reason: "missing-session" } as const);
		if (result.requested) {
			const savedLine = persisted ? "\nSaved to sandbox.allowedPaths for future sessions." : "";
			return {
				content: [
					{
						type: "text",
						text: `Successfully added paths to the macOS sandbox allowlist for the relaunched session.${savedLine}\nRetry the original operation after OMPx relaunches.\n${paths.map(p => `- ${p}`).join("\n")}`,
					},
				],
				details: { paths, relaunchRequested: true, persisted: !!persisted },
			};
		}
		const previousArgv = sessionFile ? ["--session-dir", path.dirname(sessionFile)] : [];
		const restartArgs = sessionId ? buildMacOSSandboxRelaunchArgv(previousArgv, sessionId, relaunchPaths) : undefined;
		const restartLine = restartArgs ? `\n\nManual restart: ${formatMacOSSandboxRestartCommand(restartArgs)}` : "";
		const savedLine = persisted ? " Saved to sandbox.allowedPaths for future sessions." : "";
		return {
			content: [
				{
					type: "text",
					text: `Could not relaunch the active macOS sandbox (${result.reason ?? "unknown"}); restart OMPx from your shell with the extra allowed paths, then retry the original operation.${savedLine}${restartLine}`,
				},
			],
			details: { paths, relaunchRequested: false, reason: result.reason, restartArgs, persisted: !!persisted },
			isError: true,
		};
	}
}
