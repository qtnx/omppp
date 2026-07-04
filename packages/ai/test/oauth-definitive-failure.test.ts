/**
 * Contract for {@link isDefinitiveOAuthFailure} — the shared classifier that
 * decides whether an OAuth refresh error tears the credential down (re-login
 * required) or is a transient blip to block-and-retry. A false positive here
 * permanently disables a healthy account, so the 401 / 403 / rate-limit / 5xx
 * cases below are load-bearing, not cosmetic.
 */
import { describe, expect, it } from "bun:test";
import { isDefinitiveOAuthFailure } from "@oh-my-pi/pi-ai/auth-storage";

describe("isDefinitiveOAuthFailure", () => {
	it("treats explicit dead-grant errors as definitive", () => {
		for (const msg of [
			'HTTP 400 invalid_grant {"error":"invalid_grant"}',
			"OAuth refresh failed: refresh token revoked",
			'invalid_grant {"error_description":"Refresh token expired"}',
			"unauthorized_client",
		]) {
			expect(isDefinitiveOAuthFailure(msg)).toBe(true);
		}
	});

	it("treats a bare 401 from the Anthropic token endpoint as transient", () => {
		// Regression: transient token-endpoint 401s are WAF/auth-service blips unless
		// the response body carries an explicit dead-grant code such as invalid_grant.
		expect(
			isDefinitiveOAuthFailure(
				'OAuthError: Anthropic token refresh request failed. url=https://api.anthropic.com/v1/oauth/token; details=ProviderHttpError: HTTP request failed. status=401; url=https://api.anthropic.com/v1/oauth/token; body={"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
			),
		).toBe(false);
		expect(isDefinitiveOAuthFailure("HTTP 401 Unauthorized")).toBe(false);
	});

	it("treats invalid_token access-token errors as transient", () => {
		// RFC 6750 invalid_token is a bad access-token signal; refreshing can
		// recover it, so it must not disable the stored OAuth refresh grant.
		expect(isDefinitiveOAuthFailure("invalid_token")).toBe(false);
		expect(isDefinitiveOAuthFailure('HTTP 401 {"error":{"type":"invalid_token"}}')).toBe(false);
	});

	it("never treats a bare 403 as definitive (WAF / egress / permission, not a dead token)", () => {
		// Regression: a shared broker egress IP that gets 403'd by the provider,
		// or a google PERMISSION_DENIED / account-verification 403, must NOT
		// permanently disable an otherwise-valid credential.
		expect(isDefinitiveOAuthFailure("HTTP 403 Forbidden")).toBe(false);
		expect(isDefinitiveOAuthFailure("403 PERMISSION_DENIED: account verification required")).toBe(false);
		expect(isDefinitiveOAuthFailure("blocked by cloudflare (403)")).toBe(false);
	});

	it("treats rate-limit and server/gateway errors as transient", () => {
		for (const msg of [
			"429 too many requests",
			"HTTP 503 Service Unavailable",
			"500 internal server error",
			"rate limit exceeded",
		]) {
			expect(isDefinitiveOAuthFailure(msg)).toBe(false);
		}
	});

	it("treats network blips as transient (incl. ECONNRESET)", () => {
		for (const msg of [
			"fetch failed: ECONNRESET",
			"fetch failed: ECONNREFUSED",
			"ETIMEDOUT",
			"socket hang up",
			"network error",
			"OAuth token refresh timed out for provider: anthropic",
		]) {
			expect(isDefinitiveOAuthFailure(msg)).toBe(false);
		}
	});

	it("lets a transient signal override a bare 401 (rate-limited auth endpoint)", () => {
		// A 401 wrapped in a rate-limit / 5xx context is the provider throttling,
		// not a dead grant — block-and-retry instead of nuking the row.
		expect(isDefinitiveOAuthFailure("401 unauthorized — 429 too many requests")).toBe(false);
		expect(isDefinitiveOAuthFailure("502 bad gateway (was 401 upstream)")).toBe(false);
	});
});
