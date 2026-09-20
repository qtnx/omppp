import { logger } from "@oh-my-pi/pi-utils";
import { JevError, jevAvailable, jevModel, postSystemOne, type JevQuestion, validateNoul } from "../jev/systemone";
import evidenceInstructions from "../prompts/task/jev/result-evidence.md" with { type: "text" };

export interface ResultEvidenceInput {
	assignment?: string;
	output: string;
	post?: typeof postSystemOne;
	signal?: AbortSignal;
}

export interface ResultEvidenceAssessment {
	evidence: "strong" | "weak";
	noul: number;
}

export async function assessResultEvidence(input: ResultEvidenceInput): Promise<ResultEvidenceAssessment | undefined> {
	if (!jevAvailable()) return undefined;
	const questions: Record<string, JevQuestion> = {
		"evidence::acceptance": {
			type: "noul",
			instructions: evidenceInstructions,
		},
	};
	try {
		const response = await (input.post ?? postSystemOne)(
			{
				model: jevModel(),
				state: {
					assignment: (input.assignment ?? "").slice(0, 4_000),
					output: input.output.slice(0, 8_000),
				},
				questions,
			},
			{ timeoutMs: 5_000, signal: input.signal },
		);
		const noul = validateNoul(response.answers["evidence::acceptance"]);
		return { evidence: noul < 0.5 ? "weak" : "strong", noul };
	} catch (error) {
		if (error instanceof JevError) {
			logger.debug("Jev result-evidence assessment unavailable", { error: error.message });
			return undefined;
		}
		throw error;
	}
}
