import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	getBehaviorDashboardStats,
	getCostDashboardStats,
	getDashboardStats,
	getModelDashboardStats,
	getOverviewStats,
	getRecentErrors,
	getRecentRequests,
	getRequestDetails,
	getTotalMessageCount,
	syncAllSessions,
} from "./aggregator";
import embeddedClientArchiveTxt from "./embedded-client.generated.txt";
import { getLearningAuditDetail, listLearningAudits } from "./learning-audit";
import {
	getReviewFindingDetail,
	listReviewFindingLessonGenerationEvents,
	listReviewFindings,
	ReviewFindingLessonGeneratorUnavailableError,
	type ReviewFindingStorageOptions,
	triggerReviewFindingLessonGeneration,
} from "./review-findings";
import { getSessionTrace, listSessions } from "./sessions";

const getEmbeddedClientArchive = (() => {
	const txt = embeddedClientArchiveTxt.replaceAll(/[\s\r\n]/g, "").trim();
	if (!txt) return null;
	return () => Buffer.from(txt, "base64");
})();

const CLIENT_DIR = path.join(import.meta.dir, "client");
const STATIC_DIR = path.join(import.meta.dir, "..", "dist", "client");
const IS_BUN_COMPILED =
	Bun.env.PI_COMPILED ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");

const COMPILED_CLIENT_DIR_ROOT = path.join(os.tmpdir(), "omp-stats-client");
let compiledClientDirPromise: Promise<string> | null = null;

interface StatsApiOptions extends ReviewFindingStorageOptions {}

function jsonError(message: string, status: number): Response {
	return Response.json({ error: message }, { status });
}

function decodePathSegment(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function isSameOriginMutation(req: Request, url: URL): boolean {
	const origin = req.headers.get("Origin");
	if (origin) return origin === url.origin;
	const referer = req.headers.get("Referer");
	if (!referer) return true;
	try {
		return new URL(referer).origin === url.origin;
	} catch {
		return false;
	}
}

function parseReviewFindingStatus(value: string | null): "all" | "pending" | "saved" {
	return value === "pending" || value === "saved" ? value : "all";
}

function sanitizeArchivePath(archivePath: string): string | null {
	const normalized = archivePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized === ".") return null;
	if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
	return normalized;
}

async function extractEmbeddedClientArchive(archiveBytes: Buffer, outputDir: string): Promise<void> {
	const archive = new Bun.Archive(archiveBytes);
	const files = await archive.files();
	const extractRoot = path.resolve(outputDir);

	for (const [archivePath, file] of files) {
		const sanitizedPath = sanitizeArchivePath(archivePath);
		if (!sanitizedPath) continue;
		const destinationPath = path.resolve(extractRoot, sanitizedPath);
		if (!destinationPath.startsWith(extractRoot + path.sep)) {
			throw new Error(`Archive entry escapes extraction directory: ${archivePath}`);
		}
		await Bun.write(destinationPath, file);
	}
}

async function getCompiledClientDir(): Promise<string> {
	if (!IS_BUN_COMPILED) return STATIC_DIR;
	if (compiledClientDirPromise) return compiledClientDirPromise;

	const archiveBytes = getEmbeddedClientArchive?.();
	if (!archiveBytes) {
		throw new Error("Compiled stats client bundle missing. Rebuild binary with embedded stats assets.");
	}

	compiledClientDirPromise = (async () => {
		const bundleHash = Bun.hash(archiveBytes).toString(16);
		const outputDir = path.join(COMPILED_CLIENT_DIR_ROOT, bundleHash);
		const markerPath = path.join(outputDir, "index.html");
		try {
			const marker = await fs.stat(markerPath);
			if (marker.isFile()) return outputDir;
		} catch {}

		await fs.rm(outputDir, { recursive: true, force: true });
		await fs.mkdir(outputDir, { recursive: true });
		await extractEmbeddedClientArchive(archiveBytes, outputDir);
		return outputDir;
	})();

	return compiledClientDirPromise;
}

async function getLatestMtime(dir: string): Promise<number> {
	const entries = await fs.readdir(dir, { withFileTypes: true });

	const promises = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			promises.push(getLatestMtime(fullPath));
		} else if (entry.isFile()) {
			promises.push(fs.stat(fullPath).then(stats => stats.mtimeMs));
		}
	}

	let latest = 0;
	await Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "fulfilled") {
				latest = Math.max(latest, result.value);
			}
		}
	});
	return latest;
}

const ensureClientBuild = async () => {
	if (IS_BUN_COMPILED) return;
	const indexPath = path.join(STATIC_DIR, "index.html");
	const cssPath = path.join(STATIC_DIR, "styles.css");
	const clientSourceMtime = await getLatestMtime(CLIENT_DIR);
	const tailwindConfigPath = path.join(import.meta.dir, "..", "tailwind.config.js");
	let tailwindConfigMtime = 0;
	try {
		const tailwindConfigStats = await fs.stat(tailwindConfigPath);
		tailwindConfigMtime = tailwindConfigStats.mtimeMs;
	} catch {}
	const sourceMtime = Math.max(clientSourceMtime, tailwindConfigMtime);
	let shouldBuild = true;
	try {
		const [indexStats, cssStats] = await Promise.all([fs.stat(indexPath), fs.stat(cssPath)]);
		if (
			indexStats.isFile() &&
			cssStats.isFile() &&
			indexStats.mtimeMs >= sourceMtime &&
			cssStats.mtimeMs >= sourceMtime
		) {
			shouldBuild = false;
		}
	} catch {
		shouldBuild = true;
	}

	if (!shouldBuild) return;

	await fs.rm(STATIC_DIR, { recursive: true, force: true });

	console.log("Building stats client...");
	const packageRoot = path.join(import.meta.dir, "..");
	const buildResult = await $`bun run build.ts`.cwd(packageRoot).quiet().nothrow();
	if (buildResult.exitCode !== 0) {
		const output = buildResult.text().trim();
		const details = output ? `\n${output}` : "";
		throw new Error(`Failed to build stats client (exit ${buildResult.exitCode})${details}`);
	}

	const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Usage Statistics</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

	await Bun.write(path.join(STATIC_DIR, "index.html"), indexHtml);
};
/**
 * Handle API requests.
 */
export async function handleStatsApiRequest(req: Request, options: StatsApiOptions = {}): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	// Stats reads are DB-only; explicit /api/sync does the expensive session scan.
	const range = url.searchParams.get("range");

	if (path === "/api/review-findings") {
		if (req.method !== "GET") return jsonError("Method not allowed", 405);
		const limit = url.searchParams.get("limit");
		const offset = url.searchParams.get("offset");
		const findings = await listReviewFindings({
			...options,
			query: url.searchParams.get("query"),
			status: parseReviewFindingStatus(url.searchParams.get("status")),
			repoRoot: url.searchParams.get("repoRoot"),
			limit: limit ? Number(limit) : undefined,
			offset: offset ? Number(offset) : undefined,
		});
		return Response.json(findings);
	}

	if (path.startsWith("/api/review-findings/")) {
		const segments = path.split("/").filter(Boolean);
		const encodedId = segments[2];
		if (segments[0] !== "api" || segments[1] !== "review-findings" || !encodedId) {
			return jsonError("Bad Request", 400);
		}
		const id = decodePathSegment(encodedId);
		if (!id) return jsonError("Bad Request", 400);

		if (segments.length === 4 && segments[3] === "generation-events") {
			if (req.method !== "GET") return jsonError("Method not allowed", 405);
			const after = url.searchParams.get("after");
			const limit = url.searchParams.get("limit");
			const events = await listReviewFindingLessonGenerationEvents(id, {
				...options,
				afterSequence: after ? Number(after) : undefined,
				limit: limit ? Number(limit) : undefined,
			});
			if (!events) return jsonError("Not Found", 404);
			return Response.json(events);
		}

		if (segments.length === 4 && segments[3] === "generate-learning") {
			if (req.method !== "POST") return jsonError("Method not allowed", 405);
			if (!isSameOriginMutation(req, url)) {
				return jsonError("Cross-origin learning generation requests are not allowed", 403);
			}
			try {
				const generated = await triggerReviewFindingLessonGeneration(id, options);
				if (!generated) return jsonError("Not Found", 404);
				return Response.json(generated);
			} catch (err) {
				if (err instanceof ReviewFindingLessonGeneratorUnavailableError) {
					return jsonError(err.message, 503);
				}
				throw err;
			}
		}

		if (segments.length === 4 && segments[3] === "save-learning") {
			return jsonError("Use generate-learning to create a distilled lesson", 410);
		}

		if (segments.length === 3) {
			if (req.method !== "GET") return jsonError("Method not allowed", 405);
			const detail = await getReviewFindingDetail(id, options);
			if (!detail) return jsonError("Not Found", 404);
			return Response.json(detail);
		}

		return jsonError("Bad Request", 400);
	}

	if (path === "/api/sessions") {
		const limit = url.searchParams.get("limit");
		const offset = url.searchParams.get("offset");
		const sessions = await listSessions({
			query: url.searchParams.get("query"),
			limit: limit ? Number(limit) : undefined,
			offset: offset ? Number(offset) : undefined,
			includeSubagents: url.searchParams.get("includeSubagents") === "1",
		});
		return Response.json(sessions);
	}

	if (path === "/api/sessions/trace") {
		const sessionPath = url.searchParams.get("path");
		if (!sessionPath) return new Response("Missing session path", { status: 400 });
		const maxDepth = url.searchParams.get("maxDepth");
		const maxSubtraces = url.searchParams.get("maxSubtraces");
		const trace = await getSessionTrace(sessionPath, {
			maxDepth: maxDepth ? Number(maxDepth) : undefined,
			maxSubtraces: maxSubtraces ? Number(maxSubtraces) : undefined,
		});
		if (!trace) return new Response("Not Found", { status: 404 });
		return Response.json(trace);
	}

	if (path === "/api/learnings/audit") {
		const limit = url.searchParams.get("limit");
		const offset = url.searchParams.get("offset");
		const audits = await listLearningAudits({
			query: url.searchParams.get("query"),
			limit: limit ? Number(limit) : undefined,
			offset: offset ? Number(offset) : undefined,
		});
		return Response.json(audits);
	}

	if (path.startsWith("/api/learnings/audit/")) {
		const id = path.slice("/api/learnings/audit/".length);
		if (!id) return new Response("Bad Request", { status: 400 });
		const detail = await getLearningAuditDetail(decodeURIComponent(id));
		if (!detail) return new Response("Not Found", { status: 404 });
		return Response.json(detail);
	}
	if (path === "/api/stats") {
		const stats = await getDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/overview") {
		const stats = await getOverviewStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/model-dashboard") {
		const stats = await getModelDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/costs") {
		const stats = await getCostDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/behavior") {
		const stats = await getBehaviorDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/recent") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentRequests(limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/errors") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentErrors(limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/models") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.byModel);
	}

	if (path === "/api/stats/folders") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.byFolder);
	}

	if (path === "/api/stats/timeseries") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.timeSeries);
	}

	if (path.startsWith("/api/request/")) {
		const id = path.split("/").pop();
		if (!id) return new Response("Bad Request", { status: 400 });
		const details = await getRequestDetails(parseInt(id, 10));
		if (!details) return new Response("Not Found", { status: 404 });
		return Response.json(details);
	}

	if (path === "/api/sync") {
		const result = await syncAllSessions();
		const count = await getTotalMessageCount();
		return Response.json({ ...result, totalMessages: count });
	}

	return new Response("Not Found", { status: 404 });
}

/**
 * Handle static file requests.
 */
async function handleStatic(requestPath: string): Promise<Response> {
	const staticDir = IS_BUN_COMPILED ? await getCompiledClientDir() : STATIC_DIR;
	const filePath = requestPath === "/" ? "/index.html" : requestPath;
	const fullPath = path.join(staticDir, filePath);

	const file = Bun.file(fullPath);
	if (await file.exists()) {
		return new Response(file);
	}

	// SPA fallback
	const index = Bun.file(path.join(staticDir, "index.html"));
	if (await index.exists()) {
		return new Response(index);
	}

	return new Response("Not Found", { status: 404 });
}

/**
 * Start the HTTP server.
 */
export async function startServer(
	port = 3847,
	options: StatsApiOptions = {},
): Promise<{ port: number; stop: () => void }> {
	await ensureClientBuild();

	const server = Bun.serve({
		port,
		async fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;

			// CORS headers for local development
			const corsHeaders = {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
			};

			if (req.method === "OPTIONS") {
				return new Response(null, { headers: corsHeaders });
			}

			try {
				let response: Response;

				if (path.startsWith("/api/")) {
					response = await handleStatsApiRequest(req, options);
				} else {
					response = await handleStatic(path);
				}

				// Add CORS headers to all responses
				const headers = new Headers(response.headers);
				for (const [key, value] of Object.entries(corsHeaders)) {
					headers.set(key, value);
				}

				return new Response(response.body, {
					status: response.status,
					headers,
				});
			} catch (error) {
				console.error("Server error:", error);
				return Response.json(
					{ error: error instanceof Error ? error.message : "Unknown error" },
					{ status: 500, headers: corsHeaders },
				);
			}
		},
	});

	return {
		port: server.port ?? port,
		stop: () => server.stop(),
	};
}
