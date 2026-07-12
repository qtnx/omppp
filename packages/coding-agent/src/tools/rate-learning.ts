import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { resolveRepoKey } from "../learnings/repo-key";
import { closeLearningDb, findActiveByAliasPrefix, openLearningDb, recordLearningFeedback } from "../learnings/storage";
import rateLearningDescription from "../prompts/tools/rate-learning.md" with { type: "text" };
import type { ToolSession } from ".";

const rateLearningSchema = type({
	ratings: type({
		id: type("string").describe("learning alias, e.g. l:abc123def456 or its 6-16 hex-char prefix"),
		verdict: "'useful' | 'not_useful'",
		"reason?": "string",
	})
		.array()
		.atLeastLength(1)
		.atMostLength(20),
});

export type RateLearningParams = typeof rateLearningSchema.infer;

export class RateLearningTool implements AgentTool<typeof rateLearningSchema> {
	readonly name = "rate_learning";
	readonly approval = "read" as const;
	readonly label = "Rate Learning";
	readonly description = rateLearningDescription;
	readonly parameters = rateLearningSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Rate injected live learnings as useful or not useful";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RateLearningTool | null {
		if (!session.settings.get("learning.enabled") || (session.taskDepth ?? 0) !== 0) return null;
		return new RateLearningTool(session);
	}

	async execute(_id: string, params: RateLearningParams): Promise<AgentToolResult> {
		const repoKey = await resolveRepoKey(this.session.cwd);
		const db = openLearningDb(getAgentDbPath(this.session.settings.getAgentDir()));
		try {
			const sessionId = this.session.getSessionId?.() ?? "unknown";
			const results = params.ratings.map((rating, index) => {
				const aliasPrefix = rating.id.replace(/^l:/i, "").toLowerCase();
				if (!/^[a-f0-9]{6,16}$/.test(aliasPrefix)) return `rating ${index + 1}: unknown id`;

				const matches = findActiveByAliasPrefix(db, { aliasPrefix, repoKey });
				const label = `l:${aliasPrefix}`;
				if (matches.length === 0) return `${label}: unknown id`;
				if (matches.length > 1) return `${label}: ambiguous`;

				const recorded = recordLearningFeedback(db, {
					learningId: matches[0].id,
					sessionId,
					verdict: rating.verdict,
					reason: rating.reason,
					nowSec: Math.floor(Date.now() / 1_000),
				});
				return recorded ? `${label}: ok` : `${label}: stale`;
			});
			return { content: [{ type: "text", text: results.join("\n") }] };
		} finally {
			closeLearningDb(db);
		}
	}
}
