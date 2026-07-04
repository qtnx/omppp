import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	countTrailingToolFailures,
	detectDoneClaimWithoutEvidence,
	detectNegativeSentiment,
	detectPlanningNeeded,
	detectPlanningShapedWork,
	detectToolLoop,
	evaluateTakeoverSignals,
	hasMutationsSince,
} from "../takeover-signals";

const userMsg = (text: string): AgentMessage =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as unknown as AgentMessage;
const devMsg = (text: string): AgentMessage =>
	({ role: "user", attribution: "agent", content: [{ type: "text", text }], timestamp: 1 }) as unknown as AgentMessage;
const assistantMsg = (
	text: string,
	toolCalls: Array<{ name: string; args?: Record<string, unknown> }> = [],
): AgentMessage =>
	({
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCalls.map((c, i) => ({ type: "toolCall", id: `c${i}`, name: c.name, arguments: c.args ?? {} })),
		],
		timestamp: 2,
	}) as unknown as AgentMessage;
const toolResult = (toolName: string, isError = false): AgentMessage =>
	({ role: "toolResult", toolName, isError, content: [], timestamp: 3 }) as unknown as AgentMessage;

describe("detectNegativeSentiment", () => {
	it("matches English and Vietnamese scolding in the LAST genuine user message", () => {
		for (const t of [
			"wtf, it's still broken",
			"this still does not work",
			"you broke it again",
			"vẫn lỗi mà",
			"sao vẫn chưa được",
			"đã bảo là sai rồi",
		]) {
			expect(detectNegativeSentiment([userMsg(t)])).toBe(true);
		}
	});

	it("ignores earlier scolding once a calm prompt follows, and agent-attributed messages", () => {
		expect(detectNegativeSentiment([userMsg("still broken!"), userMsg("thanks, now add tests")])).toBe(false);
		expect(detectNegativeSentiment([userMsg("add tests"), devMsg("still broken")])).toBe(false);
	});
});

describe("countTrailingToolFailures", () => {
	it("counts the trailing failure run and stops at the last success or user boundary", () => {
		expect(
			countTrailingToolFailures([
				userMsg("go"),
				toolResult("bash", true),
				toolResult("bash", true),
				toolResult("edit", true),
			]),
		).toBe(3);
		expect(
			countTrailingToolFailures([
				userMsg("go"),
				toolResult("bash", true),
				toolResult("bash"),
				toolResult("edit", true),
			]),
		).toBe(1);
		expect(countTrailingToolFailures([toolResult("bash", true), userMsg("go")])).toBe(0);
	});
});

describe("detectToolLoop", () => {
	it("flags N identical tool calls since the last user prompt", () => {
		const call = { name: "bash", args: { command: "bun test x" } };
		const messages = [
			userMsg("fix"),
			assistantMsg("try", [call]),
			assistantMsg("try", [call]),
			assistantMsg("try", [call]),
		];
		expect(detectToolLoop(messages, 3)).toBe(true);
		expect(detectToolLoop(messages, 4)).toBe(false);
	});

	it("different arguments are not a loop, and a user prompt resets the window", () => {
		expect(
			detectToolLoop(
				[
					userMsg("fix"),
					assistantMsg("a", [{ name: "bash", args: { command: "a" } }]),
					assistantMsg("b", [{ name: "bash", args: { command: "b" } }]),
				],
				2,
			),
		).toBe(false);
		expect(
			detectToolLoop(
				[
					assistantMsg("x", [{ name: "bash", args: {} }]),
					userMsg("new ask"),
					assistantMsg("x", [{ name: "bash", args: {} }]),
				],
				2,
			),
		).toBe(false);
	});
});

describe("detectDoneClaimWithoutEvidence", () => {
	it("fires on done-claim + mutation + no verification run", () => {
		expect(
			detectDoneClaimWithoutEvidence([
				userMsg("do it"),
				toolResult("edit"),
				assistantMsg("Done, everything works."),
			]),
		).toBe(true);
	});

	it("a successful bash run counts as evidence; Q&A and error-only turns never fire", () => {
		expect(
			detectDoneClaimWithoutEvidence([
				userMsg("do it"),
				toolResult("edit"),
				toolResult("bash"),
				assistantMsg("Done."),
			]),
		).toBe(false);
		expect(
			detectDoneClaimWithoutEvidence([userMsg("question?"), assistantMsg("Done reading, here's the answer.")]),
		).toBe(false);
		expect(detectDoneClaimWithoutEvidence([userMsg("do it"), toolResult("edit", true), assistantMsg("Done.")])).toBe(
			false,
		);
	});
});

describe("detectPlanningShapedWork", () => {
	it("flags plan-document writes and plan-structured essays", () => {
		expect(
			detectPlanningShapedWork([
				userMsg("go"),
				assistantMsg("writing", [{ name: "write", args: { path: "docs/plans/2026-x.md" } }]),
			]),
		).toBe(true);
		expect(
			detectPlanningShapedWork([
				userMsg("go"),
				assistantMsg("## Phase 1\ntext\n## Phase 2\ntext\n## Phase 3\ntext"),
			]),
		).toBe(true);
		expect(
			detectPlanningShapedWork([
				userMsg("go"),
				assistantMsg("edit", [{ name: "write", args: { path: "src/foo.ts" } }]),
			]),
		).toBe(false);
	});
});

describe("evaluateTakeoverSignals", () => {
	it("strong = sentiment AND (failure streak OR loop); sentiment toggle gates it", () => {
		const messages = [
			userMsg("vẫn lỗi, làm lại đi"),
			toolResult("bash", true),
			toolResult("bash", true),
			toolResult("bash", true),
			assistantMsg("trying"),
		];
		const on = evaluateTakeoverSignals(messages, { failureThreshold: 3, loopThreshold: 3, sentimentEnabled: true });
		expect(on.strong).toBe(true);
		expect(on.consecutiveFailures).toBe(3);
		expect(on.evidence.length).toBeGreaterThan(0);

		const off = evaluateTakeoverSignals(messages, { failureThreshold: 3, loopThreshold: 3, sentimentEnabled: false });
		expect(off.sentiment).toBe(false);
		expect(off.strong).toBe(false);
	});
});

describe("detectPlanningNeeded", () => {
	it("fires on an imperative with an itemized scope list", () => {
		const result = detectPlanningNeeded(
			"Implement rate limiting on the API gateway:\n1. token bucket per key\n2. config flag\n3. tests",
		);
		expect(result.needed).toBe(true);
		expect(result.evidence.length).toBeGreaterThanOrEqual(2);
	});

	it("fires on an imperative with multiple clauses", () => {
		expect(
			detectPlanningNeeded(
				"Build a new onboarding flow with email verification. Then add analytics events for each step and integrate the welcome screen.",
			).needed,
		).toBe(true);
	});

	it("fires on an imperative with multiple file mentions", () => {
		expect(
			detectPlanningNeeded("Refactor the payment module to support stripe.ts and paypal.ts providers").needed,
		).toBe(true);
	});

	it("fires on Vietnamese imperatives with stacked build verbs", () => {
		expect(
			detectPlanningNeeded(
				"Làm tính năng đăng nhập bằng Google: thêm nút login, tạo API callback, viết test cho flow mới",
			).needed,
		).toBe(true);
	});

	it("fires on Vietnamese redesign requests with scope", () => {
		expect(
			detectPlanningNeeded("Thiết kế lại trang dashboard, thêm biểu đồ doanh thu và tích hợp bộ lọc theo ngày")
				.needed,
		).toBe(true);
	});

	it("never fires on pure questions, even ones containing build verbs", () => {
		expect(detectPlanningNeeded("why does the build fail?").needed).toBe(false);
		expect(detectPlanningNeeded("Tại sao server bị lỗi 500?").needed).toBe(false);
		expect(detectPlanningNeeded("how does the duo controller work?").needed).toBe(false);
		expect(
			detectPlanningNeeded("What would happen if we migrated to Postgres? Would the ORM need changes?").needed,
		).toBe(false);
	});

	it("never fires on acks and continuations", () => {
		for (const text of ["ok", "continue", "làm tiếp", "làm tiếp đi", "tiếp đi", "status", "proceed", "vâng"]) {
			expect(detectPlanningNeeded(text).needed).toBe(false);
		}
	});

	it("never fires on trivial fixes, slash commands, or empty text", () => {
		expect(detectPlanningNeeded("fix typo in README").needed).toBe(false);
		expect(detectPlanningNeeded("sửa lỗi chính tả trong trang chủ").needed).toBe(false);
		expect(detectPlanningNeeded("/duo exec").needed).toBe(false);
		expect(detectPlanningNeeded("").needed).toBe(false);
		expect(detectPlanningNeeded("   ").needed).toBe(false);
	});

	it("never fires on a bare imperative without scope markers", () => {
		expect(detectPlanningNeeded("add a comment").needed).toBe(false);
	});
});

describe("hasMutationsSince", () => {
	it("detects mutations at or after the start index only", () => {
		const messages = [userMsg("go"), toolResult("edit"), toolResult("bash")];
		expect(hasMutationsSince(messages, 0)).toBe(true);
		expect(hasMutationsSince(messages, 2)).toBe(true);
		expect(hasMutationsSince(messages, 3)).toBe(false);
	});

	it("ignores error tool results and clamps negative starts", () => {
		expect(hasMutationsSince([toolResult("edit", true)], -5)).toBe(false);
	});
});
