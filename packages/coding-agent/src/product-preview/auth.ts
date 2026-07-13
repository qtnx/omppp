import { AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW_MS, PREVIEW_COOKIE_NAME } from "./types";

export type PreviewAuthMethod = "loopback" | "cookie" | "bearer";

export interface PreviewAuthIdentity {
	method: PreviewAuthMethod;
	viaShare: boolean;
}

export interface PreviewAuthFailure {
	throttled: boolean;
}

interface AuthenticatePreviewRequest {
	authorization: string | null;
	cookie: string | null;
	host: string;
	loopback: boolean;
	shareEnabled: boolean;
	verifyShareToken: (candidate: string) => boolean;
}

/**
 * Server-local cookie sessions for the preview's token exchange. Sessions bind
 * to the exact Host because browser cookies are scoped by hostname, not port.
 */
export class PreviewAuth {
	#sessions = new Map<string, string>();
	#failures = new Map<string, number[]>();

	exchangeToken(candidate: string, host: string, verifyShareToken: (candidate: string) => boolean): string | null {
		if (!verifyShareToken(candidate)) return null;
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		const sid = Buffer.from(bytes).toString("base64url");
		this.#sessions.set(sid, host);
		return sid;
	}

	authenticate(request: AuthenticatePreviewRequest): PreviewAuthIdentity | null {
		if (request.loopback) return { method: "loopback", viaShare: false };
		if (!request.shareEnabled) return null;

		const bearer = request.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
		if (bearer && request.verifyShareToken(bearer)) return { method: "bearer", viaShare: true };

		const sid = readCookie(request.cookie, PREVIEW_COOKIE_NAME);
		if (sid && this.#sessions.get(sid) === request.host) return { method: "cookie", viaShare: true };
		return null;
	}

	recordFailure(peer: string): PreviewAuthFailure {
		const now = Date.now();
		const failures = (this.#failures.get(peer) ?? []).filter(timestamp => now - timestamp < AUTH_FAIL_WINDOW_MS);
		failures.push(now);
		this.#failures.set(peer, failures);
		return { throttled: failures.length > AUTH_FAIL_LIMIT };
	}

	clearSessions(): void {
		this.#sessions.clear();
	}
}

export function previewSessionCookie(sid: string): string {
	return `${PREVIEW_COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Strict`;
}

function readCookie(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() !== name) continue;
		const value = part.slice(separator + 1).trim();
		return value.length > 0 ? value : null;
	}
	return null;
}
