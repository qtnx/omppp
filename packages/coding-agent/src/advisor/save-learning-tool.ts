import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { resolveRepoKey } from "../learnings/repo-key";
import { closeLearningDb, learningMessageHash, openLearningDb, upsertLearning } from "../learnings/storage";
import saveLearningDescription from "../prompts/tools/advisor-save-learning.md" with { type: "text" };
import type { TurnSignalService } from "../signals/index";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";

const MAX_LEARNING_CHARS = 400;
const MIN_LEARNING_CHARS = 20;
/** Advisor-authored entries start above the classifier's typical band so a caught mistake outranks unrated noise. */
const ADVISOR_LEARNING_CONFIDENCE = 0.85;
/** Below this generic-rule probability the classifier reads the entry as a case-specific note. */
const MIN_GENERIC_RULE_PROBABILITY = 0.5;
const CASE_SPECIFIC_REJECTION =
	"Rejected: reads as case-specific. State the generic rule (what to do or avoid across tasks), without file names, values, or this task's details.";

const saveLearningSchema = type({
	content: type("string").describe(
		"Generic rule in imperative voice: trigger condition + required behavior + why. No paths, names, ids, or task nouns.",
	),
	scope: type("'global' | 'repo'").describe(
		"repo when the rule depends on this codebase's conventions; global otherwise.",
	),
	failure_class: type("string").describe(
		"Short label of the mistake class this prevents (e.g. hallucinated-api, done-without-evidence, symptom-fix, retry-loop).",
	),
});

export type SaveLearningParams = typeof saveLearningSchema.infer;

export class SaveLearningTool implements AgentTool<typeof saveLearningSchema> {
	readonly name = "save_learning";
	readonly approval = "read" as const;
	readonly label = "Save Learning";
	readonly loadMode = "essential" as const;
	readonly description = saveLearningDescription;
	readonly parameters = saveLearningSchema;
	readonly strict = true;
	readonly summary = "Store a generic learning so future executors avoid a caught mistake";

	constructor(
		private readonly session: ToolSession,
		private readonly turnSignals?: TurnSignalService,
	) {}

	static createIf(session: ToolSession, turnSignals?: TurnSignalService): SaveLearningTool | null {
		return session.settings.get("learning.enabled") ? new SaveLearningTool(session, turnSignals) : null;
	}

	async execute(_id: string, params: SaveLearningParams): Promise<AgentToolResult> {
		const content = params.content.trim().replace(/\s+/g, " ");
		if (content.length < MIN_LEARNING_CHARS) {
			throw new ToolError(`save_learning: content is too short to be a rule (min ${MIN_LEARNING_CHARS} chars).`);
		}
		if (content.length > MAX_LEARNING_CHARS) {
			throw new ToolError(`save_learning: content exceeds ${MAX_LEARNING_CHARS} chars; state one generic rule.`);
		}
		const failureClass = params.failure_class.trim().toLowerCase().replace(/\s+/g, "-");
		if (!failureClass) throw new ToolError("save_learning: failure_class is required.");

		const judged = await this.turnSignals?.classifyLearning(content);
		if (judged && judged.genericRule < MIN_GENERIC_RULE_PROBABILITY) {
			throw new ToolError(CASE_SPECIFIC_REJECTION);
		}

		const repoKey = await resolveRepoKey(this.session.cwd);
		const db = openLearningDb(getAgentDbPath(this.session.settings.getAgentDir()));
		try {
			const stored = upsertLearning(db, {
				scope: params.scope,
				cwd: this.session.cwd,
				repoKey,
				content,
				sourceMessageHash: learningMessageHash(content),
				trigger: `advisor:${failureClass}`,
				confidence: ADVISOR_LEARNING_CONFIDENCE,
				nowSec: Math.floor(Date.now() / 1_000),
			});
			return {
				content: [
					{
						type: "text",
						text: stored
							? `Learning recorded (${params.scope}, ${failureClass}); an identical active entry is reinforced instead of duplicated. It reaches future sessions through Live Learning Guidance.`
							: `No change: the learning store rejected the entry as stale.`,
					},
				],
			};
		} finally {
			closeLearningDb(db);
		}
	}
}
