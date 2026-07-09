import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AnnotationPayload } from "../annotate";
import { type AnnotateHttpInfo, disableAnnotateHttp, enableAnnotateHttp } from "../annotate-http";
import type { AnnotationSubmission } from "../tab-protocol";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const enabledKeys: object[] = [];

function preferredPort(): number {
	return 30_000 + Math.floor(Math.random() * 20_000);
}

function validPayload(): AnnotationPayload {
	return {
		comment: "looks off here",
		rects: [
			{
				x: 10,
				y: 10,
				width: 100,
				height: 50,
				element: {
					selector: "#hero",
					tag: "div",
					rect: { x: 10, y: 10, width: 100, height: 50 },
				},
			},
		],
		url: "http://localhost/demo",
		title: "Demo",
	};
}

function validScreenshot(): { data: string; mimeType: string } {
	return { data: PNG_1X1, mimeType: "image/png" };
}

async function enableSession(sessionLabel: string): Promise<{
	key: object;
	info: AnnotateHttpInfo;
	captured: AnnotationSubmission[];
}> {
	const key = {};
	const captured: AnnotationSubmission[] = [];
	const info = await enableAnnotateHttp({
		key,
		sessionLabel,
		host: "127.0.0.1",
		port: preferredPort(),
		deliver: submission => {
			captured.push(submission);
		},
	});
	enabledKeys.push(key);
	return { key, info, captured };
}

async function postJson(url: string, body: unknown): Promise<Response> {
	return await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

afterEach(async () => {
	for (const key of enabledKeys.splice(0)) {
		await disableAnnotateHttp(key);
	}
	vi.restoreAllMocks();
});

describe("annotate HTTP intake", () => {
	it("binds to a port beyond the first ten failed port attempts", async () => {
		const key = {};
		const port = 41_000;
		const stop = vi.fn();
		let serveCalls = 0;
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(((options: { hostname?: string; port?: number }) => {
			serveCalls += 1;
			if (serveCalls <= 12) {
				throw new Error(`port ${options.port} unavailable`);
			}
			return {
				hostname: options.hostname ?? "127.0.0.1",
				port: options.port ?? 0,
				stop,
			} as unknown as Bun.Server<undefined>;
		}) as typeof Bun.serve);

		const info = await enableAnnotateHttp({
			key,
			sessionLabel: "Port fallback",
			host: "127.0.0.1",
			port,
			deliver: () => {},
		});
		enabledKeys.push(key);

		expect(info.port).toBe(port + 12);
		expect(serveSpy).toHaveBeenCalledTimes(13);
		expect(await disableAnnotateHttp(key)).toBe(true);
		expect(stop).toHaveBeenCalledWith(true);
	});

	it("pairs issued and normalized codes and rejects unknown codes", async () => {
		const { info } = await enableSession("Design review");

		async function expectPairOk(code: string): Promise<void> {
			const response = await postJson(`${info.url}/v1/pair`, { code });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true, session: "Design review" });
		}

		await expectPairOk(info.code);
		await expectPairOk(info.code.toLowerCase());
		await expectPairOk(info.code.replace("-", ""));

		const response = await postJson(`${info.url}/v1/pair`, { code: "0000-0000" });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ ok: false, error: "invalid_code" });
	});

	it("accepts a valid annotation and delivers the normalized submission", async () => {
		const { captured, info } = await enableSession("Annotation success");

		const response = await postJson(`${info.url}/v1/annotations`, {
			code: info.code,
			payload: validPayload(),
			screenshot: validScreenshot(),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(captured).toHaveLength(1);
		const submission = captured[0];
		expect(submission.payload.comment).toBe("looks off here");
		expect(submission.payload.rects[0]?.width).toBe(100);
		expect(submission.payload.url).toBe("http://localhost/demo");
		expect(submission.payload.title).toBe("Demo");
		expect(typeof submission.ts).toBe("number");
		expect(submission.screenshot.mimeType.startsWith("image/")).toBe(true);
	});

	it("rejects an annotation payload with neither comment nor rects", async () => {
		const { captured, info } = await enableSession("Invalid payload");

		const response = await postJson(`${info.url}/v1/annotations`, {
			code: info.code,
			payload: { comment: "", rects: [] },
			screenshot: validScreenshot(),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false });
		expect(captured).toHaveLength(0);
	});

	it("rejects missing or undecodable screenshots without delivering", async () => {
		const { captured, info } = await enableSession("Bad screenshot");

		const missing = await postJson(`${info.url}/v1/annotations`, {
			code: info.code,
			payload: validPayload(),
		});
		expect(missing.status).toBe(400);
		expect(await missing.json()).toEqual({ ok: false, error: "invalid_screenshot" });
		expect(captured).toHaveLength(0);

		const invalidBase64 = await postJson(`${info.url}/v1/annotations`, {
			code: info.code,
			payload: validPayload(),
			screenshot: { data: "not-base64!!!", mimeType: "image/png" },
		});
		expect(invalidBase64.status).toBe(400);
		expect(await invalidBase64.json()).toEqual({ ok: false, error: "invalid_screenshot" });
		expect(captured).toHaveLength(0);
	});

	it("stops the server when the last registration is disabled", async () => {
		const { info, key } = await enableSession("Shutdown");

		expect(await disableAnnotateHttp(key)).toBe(true);
		await expect(postJson(`${info.url}/v1/pair`, { code: info.code })).rejects.toThrow();
		expect(await disableAnnotateHttp(key)).toBe(false);
	});

	it("routes annotations by code when multiple registrations share the server", async () => {
		const a = await enableSession("Session A");
		const b = await enableSession("Session B");

		const response = await postJson(`${b.info.url}/v1/annotations`, {
			code: b.info.code,
			payload: validPayload(),
			screenshot: validScreenshot(),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(b.captured).toHaveLength(1);
		expect(a.captured).toHaveLength(0);
	});
});
