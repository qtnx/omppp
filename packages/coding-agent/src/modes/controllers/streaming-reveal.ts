import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getSegmenter } from "@oh-my-pi/pi-tui";
import type { AssistantMessageComponent } from "../components/assistant-message";

export const STREAMING_REVEAL_FRAME_MS = 1000 / 30;
export const MIN_STEP = 3;
export const CATCHUP_FRAMES = 8;

type AssistantContentBlock = AssistantMessage["content"][number];
type StreamingRevealComponent = Pick<AssistantMessageComponent, "updateContent">;

type StreamingRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	getHideThinkingBlock(): boolean;
	requestRender(): void;
};

// Grapheme counting dominates the 30fps reveal: `visibleUnits` + `buildDisplayMessage`
// each run a full `Intl.Segmenter` pass over the whole growing message every frame
// (~2.5ms per 16KB pass; measured ~433ms of CPU per 16KB reply). Two cheap, correct
// guards: (1) pure-ASCII text (with no CR) has grapheme count == length — the only
// ASCII grapheme cluster is CRLF — so skip the segmenter entirely; (2) memoize counts
// in a small LRU so the repeated passes over the same snapshot (within a frame) and
// over stable blocks (across frames) don't re-segment.
const GRAPHEME_COUNT_CACHE_MAX = 16;
const graphemeCountCache = new Map<string, number>();

function isFastAsciiText(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		// >127: non-ASCII (may combine/join/surrogate). 13: CR (CRLF is one cluster).
		if (code > 127 || code === 13) return false;
	}
	return true;
}
function countGraphemes(text: string): number {
	if (text.length === 0) return 0;
	const cached = graphemeCountCache.get(text);
	if (cached !== undefined) {
		// Refresh LRU position so stable blocks survive churn from the growing block.
		graphemeCountCache.delete(text);
		graphemeCountCache.set(text, cached);
		return cached;
	}
	let count: number;
	if (isFastAsciiText(text)) {
		count = text.length;
	} else {
		count = 0;
		for (const _segment of getSegmenter().segment(text)) count += 1;
	}
	graphemeCountCache.set(text, count);
	if (graphemeCountCache.size > GRAPHEME_COUNT_CACHE_MAX) {
		const oldest = graphemeCountCache.keys().next().value;
		if (oldest !== undefined) graphemeCountCache.delete(oldest);
	}
	return count;
}

function sliceGraphemes(text: string, units: number): string {
	if (units <= 0 || text.length === 0) return "";
	// ASCII fast-path: 1 char == 1 grapheme (CRLF excluded by isFastAsciiText),
	// so the first `units` graphemes are exactly `text.slice(0, units)`.
	if (isFastAsciiText(text)) return units >= text.length ? text : text.slice(0, units);
	let count = 0;
	for (const { index, segment } of getSegmenter().segment(text)) {
		count += 1;
		if (count >= units) {
			const end = index + segment.length;
			return end >= text.length ? text : text.slice(0, end);
		}
	}
	return text;
}

export function visibleUnits(message: AssistantMessage, hideThinking: boolean): number {
	let total = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			total += countGraphemes(block.text);
		} else if (block.type === "thinking" && !hideThinking) {
			total += countGraphemes(block.thinking);
		}
	}
	return total;
}

function revealTextBlock(
	block: Extract<AssistantContentBlock, { type: "text" }>,
	remaining: number,
): AssistantContentBlock {
	if (remaining <= 0) return block.text.length === 0 ? block : { ...block, text: "" };
	const units = countGraphemes(block.text);
	if (remaining >= units) return block;
	return { ...block, text: sliceGraphemes(block.text, remaining) };
}

function revealThinkingBlock(
	block: Extract<AssistantContentBlock, { type: "thinking" }>,
	remaining: number,
): AssistantContentBlock {
	if (remaining <= 0) return block.thinking.length === 0 ? block : { ...block, thinking: "" };
	const units = countGraphemes(block.thinking);
	if (remaining >= units) return block;
	return { ...block, thinking: sliceGraphemes(block.thinking, remaining) };
}

export function buildDisplayMessage(
	target: AssistantMessage,
	revealed: number,
	hideThinking: boolean,
): AssistantMessage {
	let remaining = Math.max(0, Math.floor(revealed));
	const content: AssistantContentBlock[] = [];
	for (const block of target.content) {
		if (block.type === "text") {
			content.push(revealTextBlock(block, remaining));
			remaining = Math.max(0, remaining - countGraphemes(block.text));
		} else if (block.type === "thinking" && !hideThinking) {
			content.push(revealThinkingBlock(block, remaining));
			remaining = Math.max(0, remaining - countGraphemes(block.thinking));
		} else {
			content.push(block);
		}
	}
	return { ...target, content };
}

export function nextStep(backlog: number): number {
	return Math.max(MIN_STEP, Math.ceil(Math.max(0, backlog) / CATCHUP_FRAMES));
}

export class StreamingRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #getHideThinkingBlock: () => boolean;
	readonly #requestRender: () => void;
	#target: AssistantMessage | undefined;
	#component: StreamingRevealComponent | undefined;
	#timer: NodeJS.Timeout | undefined;
	#revealed = 0;
	#hideThinkingBlock = false;
	#smoothStreaming = true;
	#targetTotal = 0;

	constructor(options: StreamingRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#getHideThinkingBlock = options.getHideThinkingBlock;
		this.#requestRender = options.requestRender;
	}

	begin(component: StreamingRevealComponent, message: AssistantMessage): void {
		this.stop();
		this.#component = component;
		this.#target = message;
		this.#revealed = 0;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#smoothStreaming = this.#getSmoothStreaming();
		if (!this.#smoothStreaming) {
			component.updateContent(message);
			return;
		}
		const total = visibleUnits(message, this.#hideThinkingBlock);
		this.#targetTotal = total;
		if (message.content.some(block => block.type === "toolCall")) {
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			this.#revealed = total;
			component.updateContent(buildDisplayMessage(message, this.#revealed, this.#hideThinkingBlock));
			return;
		}
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	setTarget(message: AssistantMessage): void {
		this.#target = message;
		if (!this.#component) return;
		if (!this.#smoothStreaming) {
			this.#component.updateContent(message);
			return;
		}
		const total = visibleUnits(message, this.#hideThinkingBlock);
		this.#targetTotal = total;
		if (message.content.some(block => block.type === "toolCall")) {
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			this.#revealed = total;
			this.#stopTimer();
			this.#component.updateContent(buildDisplayMessage(message, this.#revealed, this.#hideThinkingBlock));
			return;
		}
		if (this.#revealed > total) {
			this.#revealed = total;
		}
		this.#syncTimer(total);
		// When the reveal is animating, the 30fps #tick performs the single build+render;
		// avoid the O(N) buildDisplayMessage on the per-delta event-thread path. Only render
		// synchronously when no tick will fire (already fully revealed, timer stopped).
		if (!this.#timer) this.#renderCurrent();
	}

	stop(): void {
		this.#stopTimer();
		this.#target = undefined;
		this.#component = undefined;
		this.#revealed = 0;
		this.#targetTotal = 0;
	}

	#renderCurrent(): void {
		if (!this.#target || !this.#component) return;
		this.#component.updateContent(buildDisplayMessage(this.#target, this.#revealed, this.#hideThinkingBlock));
	}

	#syncTimer(total = this.#targetTotal): void {
		if (!this.#target || !this.#component || this.#revealed >= total) {
			this.#stopTimer();
			return;
		}
		this.#startTimer();
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			this.#tick();
		}, STREAMING_REVEAL_FRAME_MS);
		this.#timer.unref?.();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#tick(): void {
		const target = this.#target;
		const component = this.#component;
		if (!target || !component) {
			this.stop();
			return;
		}
		const total = this.#targetTotal;
		if (this.#revealed >= total) {
			this.#stopTimer();
			return;
		}
		this.#revealed = Math.min(total, this.#revealed + nextStep(total - this.#revealed));
		component.updateContent(buildDisplayMessage(target, this.#revealed, this.#hideThinkingBlock));
		this.#requestRender();
		if (this.#revealed >= total) {
			this.#stopTimer();
		}
	}
}
