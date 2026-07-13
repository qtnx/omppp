export interface PreviewQuestionOption {
	label: string;
	description?: string;
}

export interface PreviewQuestion {
	id: string;
	question: string;
	options: PreviewQuestionOption[];
	multi: boolean;
}

export function parseQuestionBlock(text: string): PreviewQuestion | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const question = value as Record<string, unknown>;
	if (typeof question.id !== "string" || !question.id.trim()) return null;
	if (typeof question.question !== "string" || !question.question.trim()) return null;
	if (!Array.isArray(question.options) || question.options.length < 2) return null;

	const options: PreviewQuestionOption[] = [];
	for (const option of question.options) {
		if (!option || typeof option !== "object" || Array.isArray(option)) return null;
		const candidate = option as Record<string, unknown>;
		if (typeof candidate.label !== "string") return null;
		if (candidate.description !== undefined && typeof candidate.description !== "string") return null;
		options.push(
			candidate.description === undefined
				? { label: candidate.label }
				: { label: candidate.label, description: candidate.description },
		);
	}
	return { id: question.id, question: question.question, options, multi: question.multi === true };
}
