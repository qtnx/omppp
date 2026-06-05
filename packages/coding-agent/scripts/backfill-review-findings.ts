#!/usr/bin/env bun
import * as path from "node:path";
import { getAgentDbPath, getAgentDir } from "@oh-my-pi/pi-utils";
import { backfillReviewFindings } from "../src/task/review-findings-backfill";

interface CliOptions {
	sessionDir: string;
	agentDbPath: string;
	repoRoot?: string;
	dryRun: boolean;
	limitFiles?: number;
}

function printUsage(): void {
	process.stdout.write(`Usage: bun packages/coding-agent/scripts/backfill-review-findings.ts [options]

Backfills review_findings from prior task results for reviewer/code-reviewer agents.

Options:
  --session-dir <path>  Session root to scan (default: ~/.omp/agent/sessions)
  --agent-db <path>     SQLite agent DB to write (default: ~/.omp/agent/agent.db)
  --repo-root <path>    Only backfill sessions for this repo root
  --limit-files <n>     Stop after scanning n JSONL files
  --dry-run             Report counts without writing SQLite rows
  -h, --help            Show this help
`);
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {
		sessionDir: path.join(getAgentDir(), "sessions"),
		agentDbPath: getAgentDbPath(),
		dryRun: false,
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--dry-run") {
			options.dryRun = true;
		} else if (arg === "--session-dir") {
			const value = args[++i];
			if (!value) throw new Error("--session-dir requires a path");
			options.sessionDir = path.resolve(value);
		} else if (arg === "--agent-db") {
			const value = args[++i];
			if (!value) throw new Error("--agent-db requires a path");
			options.agentDbPath = path.resolve(value);
		} else if (arg === "--repo-root") {
			const value = args[++i];
			if (!value) throw new Error("--repo-root requires a path");
			options.repoRoot = path.resolve(value);
		} else if (arg === "--limit-files") {
			const value = args[++i];
			if (!value) throw new Error("--limit-files requires a number");
			const limit = Number(value);
			if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit-files must be a positive integer");
			options.limitFiles = limit;
		} else if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

async function main(): Promise<void> {
	const options = parseArgs(Bun.argv.slice(2));
	const result = await backfillReviewFindings(options);
	process.stdout.write(`${JSON.stringify({ ...result, dryRun: options.dryRun }, null, 2)}\n`);
	if (result.errors.length > 0) process.exitCode = 1;
}

main().catch(err => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
