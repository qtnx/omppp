import { logger } from "@oh-my-pi/pi-utils";
import {
	JevError,
	jevAvailable,
	jevModel,
	postSystemOne,
	type JevQuestion,
	type JevRequest,
	validateChoice,
	validateNoul,
} from "../jev/systemone";
import briefAcceptanceInstructions from "../prompts/task/jev/brief-acceptance.md" with { type: "text" };
import briefAnchorsInstructions from "../prompts/task/jev/brief-anchors.md" with { type: "text" };
import briefScopeInstructions from "../prompts/task/jev/brief-scope.md" with { type: "text" };
import spawnRouteInstructions from "../prompts/task/jev/spawn-route.md" with { type: "text" };

export interface BriefAssignment {
	name: string;
	task: string;
	context: string;
}

export type BriefGapKind = "anchors" | "acceptance" | "scope";

export interface BriefAssessment {
	name: string;
	gaps: BriefGapKind[];
}

export interface AssessBriefsInput {
	assignments: BriefAssignment[];
	post?: typeof postSystemOne;
	signal?: AbortSignal;
	timeoutMs: number;
}

export interface RouteAgentInput {
	assignment: string;
	context: string;
	agents: Array<{ name: string; description: string }>;
	post?: typeof postSystemOne;
	signal?: AbortSignal;
}

function buildBriefRequest(assignments: BriefAssignment[]): JevRequest {
	const questions: Record<string, JevQuestion> = {};
	for (const [index] of assignments.entries()) {
		questions[`brief::${index}::anchors`] = { type: "noul", instructions: briefAnchorsInstructions };
		questions[`brief::${index}::acceptance`] = { type: "noul", instructions: briefAcceptanceInstructions };
		questions[`brief::${index}::scope`] = { type: "noul", instructions: briefScopeInstructions };
	}
	return { model: jevModel(), state: { assignments }, questions };
}

function buildRouteRequest(input: RouteAgentInput): JevRequest {
	const criteria: Record<string, string | null> = {};
	for (const agent of input.agents) criteria[agent.name] = agent.description;
	return {
		model: jevModel(),
		state: { assignment: input.assignment, context: input.context },
		questions: {
			"route::pick": {
				type: "choice",
				instructions: spawnRouteInstructions,
				criteria,
			},
		},
	};
}

export async function assessBriefs(input: AssessBriefsInput): Promise<BriefAssessment[]> {
	if (!jevAvailable() || input.assignments.length === 0) return [];
	try {
		const response = await (input.post ?? postSystemOne)(buildBriefRequest(input.assignments), {
			timeoutMs: input.timeoutMs,
			signal: input.signal,
		});
		const assessments: BriefAssessment[] = [];
		for (const [index, assignment] of input.assignments.entries()) {
			const gaps: BriefGapKind[] = [];
			for (const kind of ["anchors", "acceptance", "scope"] as const) {
				const answer = response.answers[`brief::${index}::${kind}`];
				if (answer === undefined) continue;
				try {
					if (validateNoul(answer) < 0.5) gaps.push(kind);
				} catch (error) {
					if (error instanceof JevError)
						logger.debug("task: invalid Jev brief answer", { name: assignment.name, kind });
				}
			}
			if (gaps.length > 0) assessments.push({ name: assignment.name, gaps });
		}
		return assessments;
	} catch (error) {
		logger.debug("task: Jev brief assessment unavailable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

export async function routeAgent(input: RouteAgentInput): Promise<string | undefined> {
	if (!jevAvailable() || input.agents.length === 0) return undefined;
	try {
		const response = await (input.post ?? postSystemOne)(buildRouteRequest(input), {
			timeoutMs: 2_000,
			signal: input.signal,
		});
		const answer = validateChoice(
			response.answers["route::pick"],
			input.agents.map(agent => agent.name),
		);
		logger.debug("task: Jev selected spawn agent", { chosen: answer.choice, confidence: answer.confidence });
		return answer.confidence >= 0.6 ? answer.choice : undefined;
	} catch (error) {
		logger.debug("task: Jev agent routing unavailable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
