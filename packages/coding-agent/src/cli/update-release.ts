import * as fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { APP_NAME } from "@oh-my-pi/pi-utils";

const REPO = "qtnx/omppp";
const GITHUB_API = `https://api.github.com/repos/${REPO}`;
const GITHUB_RELEASE_DOWNLOAD = `https://github.com/${REPO}/releases/download`;
const STABLE_VERSION_TAG = /^v(\d+\.\d+\.\d+)$/;
const SHA256_SUM_LINE = /^([0-9a-fA-F]{64})[\t ]+\*?([^\s]+)$/;

export interface ReleaseInfo {
	tag: string;
	version: string;
}

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface GitHubReleasePayload {
	tag_name?: unknown;
	draft?: unknown;
	prerelease?: unknown;
}

export function releaseInfoFromTag(tagName: string): ReleaseInfo {
	const tag = tagName.trim();
	const match = STABLE_VERSION_TAG.exec(tag);
	if (!match) {
		throw new Error(`GitHub release tag ${JSON.stringify(tagName)} does not contain a valid semver version`);
	}

	const version = match[1];
	if (!version)
		throw new Error(`GitHub release tag ${JSON.stringify(tagName)} does not contain a valid semver version`);
	return { tag, version };
}

function githubHeaders(): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		"User-Agent": `${APP_NAME}-update`,
	};
}

function formatGitHubFetchError(response: Response): string {
	const retryAfter = response.headers.get("retry-after");
	const resetEpochSeconds = response.headers.get("x-ratelimit-reset");
	if ((response.status === 403 || response.status === 429) && (retryAfter || resetEpochSeconds)) {
		const retryHint = retryAfter ? `retry after ${retryAfter}s` : `retry after unix timestamp ${resetEpochSeconds}`;
		return `GitHub release lookup was rate limited (${response.status}); ${retryHint}`;
	}
	return `Failed to fetch GitHub release info: ${response.status} ${response.statusText}`;
}

function nextLink(linkHeader: string | null): string | undefined {
	if (!linkHeader) return undefined;
	for (const part of linkHeader.split(",")) {
		const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
		if (match) return match[1];
	}
	return undefined;
}

function releaseInfoFromPayload(payload: GitHubReleasePayload): ReleaseInfo | undefined {
	if (payload.draft === true || payload.prerelease === true || typeof payload.tag_name !== "string") {
		return undefined;
	}
	try {
		return releaseInfoFromTag(payload.tag_name);
	} catch {
		return undefined;
	}
}

export async function fetchLatestReleaseInfo(fetchImpl: FetchImpl = fetch): Promise<ReleaseInfo> {
	let url: string | undefined = `${GITHUB_API}/releases?per_page=100`;
	let latest: ReleaseInfo | undefined;

	while (url) {
		const response = await fetchImpl(url, { headers: githubHeaders() });
		if (!response.ok) throw new Error(formatGitHubFetchError(response));

		const data = (await response.json()) as unknown;
		if (!Array.isArray(data)) {
			throw new Error("GitHub releases response was not an array");
		}

		for (const payload of data) {
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
			const release = releaseInfoFromPayload(payload as GitHubReleasePayload);
			if (release && (!latest || Bun.semver.order(release.version, latest.version) > 0)) {
				latest = release;
			}
		}

		url = nextLink(response.headers.get("link"));
	}

	if (!latest) throw new Error("GitHub releases did not include a stable semver tag");
	return latest;
}

export function releaseAssetUrl(tag: string, assetName: string): string {
	return `${GITHUB_RELEASE_DOWNLOAD}/${tag}/${assetName}`;
}

export function getChecksumForAsset(checksums: string, assetName: string): string {
	let matchedChecksum: string | undefined;

	for (const line of checksums.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const match = SHA256_SUM_LINE.exec(trimmed);
		if (!match) {
			throw new Error(`Malformed SHA256SUMS line: ${trimmed}`);
		}

		const rawHash = match[1];
		const name = match[2];
		if (!rawHash || !name) throw new Error(`Malformed SHA256SUMS line: ${trimmed}`);
		const hash = rawHash.toLowerCase();
		if (name !== assetName) continue;

		if (matchedChecksum) {
			throw new Error(`SHA256SUMS contains duplicate entries for ${assetName}`);
		}
		matchedChecksum = hash;
	}

	if (!matchedChecksum) throw new Error(`SHA256SUMS does not contain ${assetName}`);
	return matchedChecksum;
}

async function fetchText(fetchImpl: FetchImpl, url: string, description: string): Promise<string> {
	const response = await fetchImpl(url, { redirect: "follow" });
	if (!response.ok) {
		throw new Error(`${description} failed: ${response.status} ${response.statusText}`);
	}
	return response.text();
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}

async function sha256FileHex(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	const reader = Bun.file(filePath).stream().getReader();
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			hasher.update(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	return hasher.digest("hex");
}

export async function downloadReleaseAsset(options: {
	release: ReleaseInfo;
	binaryName: string;
	tempPath: string;
	fetchImpl?: FetchImpl;
}): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	await unlinkIfExists(options.tempPath);

	const checksumUrl = releaseAssetUrl(options.release.tag, "SHA256SUMS");
	const checksums = await fetchText(fetchImpl, checksumUrl, "Checksum download");
	const expectedChecksum = getChecksumForAsset(checksums, options.binaryName);

	const binaryUrl = releaseAssetUrl(options.release.tag, options.binaryName);
	const response = await fetchImpl(binaryUrl, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.status} ${response.statusText}`);
	}

	try {
		const fileStream = fs.createWriteStream(options.tempPath, { mode: 0o755 });
		await pipeline(response.body, fileStream);
		const actualChecksum = await sha256FileHex(options.tempPath);
		if (actualChecksum !== expectedChecksum) {
			throw new Error(`Downloaded ${options.binaryName} checksum mismatch`);
		}
	} catch (err) {
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}
