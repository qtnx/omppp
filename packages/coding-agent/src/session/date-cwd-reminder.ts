/**
 * Date/cwd reminder injection.
 *
 * The system prompt must stay byte-stable so open-weight chat templates that
 * render tool schemas *after* the system content keep their prefix cache
 * (#7404). The per-request date/cwd line used to live at the tail of the
 * system prompt (`project-prompt.md`), which invalidated the whole tool array
 * on every directory change or day rollover. It now rides on the first user
 * turn of each provider request instead: built at request time (never stored
 * in the session), deterministic per `(date, cwd)`, so the bytes are stable
 * for the lifetime of a session/day and refresh automatically at midnight.
 */
import type { Context, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import dateCwdReminderTemplate from "../prompts/system/date-cwd-reminder.md" with { type: "text" };

/** Renders the reminder text for the given local calendar date and cwd. */
export function renderDateCwdReminder(date: string, cwd: string): string {
	return prompt.render(dateCwdReminderTemplate, { date, cwd }).trim();
}
function messageStartsWithReminder(message: UserMessage, reminder: string): boolean {
	if (typeof message.content === "string") return message.content.startsWith(reminder);
	return message.content[0]?.type === "text" && message.content[0].text === reminder;
}

const injectCache = new WeakMap<Message, { reminder: string; injected: Message }>();

/**
 * Prepends `reminder` to the first user message without mutating the input.
 * Reuses the injected message for the same pristine message/reminder pair so
 * append-only context transforms preserve object identity across requests.
 */
export function injectDateCwdReminder(messages: Message[], reminder: string): Message[] {
	const index = messages.findIndex(message => message.role === "user");
	if (index < 0) return messages;
	const first = messages[index]!;
	if (first.role !== "user" || messageStartsWithReminder(first, reminder)) return messages;
	const cached = injectCache.get(first);
	if (cached?.reminder === reminder) {
		const out = messages.slice();
		out[index] = cached.injected;
		return out;
	}
	const injected = injectReminder(first, reminder);
	injectCache.set(first, { reminder, injected });
	const out = messages.slice();
	out[index] = injected;
	return out;
}

function injectReminder(message: UserMessage, reminder: string): UserMessage {
	const cached = injectCache.get(message);
	if (cached?.reminder === reminder && cached.injected.role === "user") return cached.injected;
	const content: UserMessage["content"] =
		typeof message.content === "string"
			? `${reminder}\n\n${message.content}`
			: [{ type: "text", text: reminder }, ...message.content];
	const injected = { ...message, content };
	injectCache.set(message, { reminder, injected });
	return injected;
}

/**
 * Applies the current date/cwd reminder to a provider context while keeping
 * the system prompt byte-stable.
 */
export function withDateCwdReminder(context: Context, date: string, cwd: string): Context {
	if (!context.systemPrompt || context.systemPrompt.length === 0 || context.messages.length === 0) return context;
	const messages = injectDateCwdReminder(context.messages, renderDateCwdReminder(date, cwd));
	return messages === context.messages ? context : { ...context, messages };
}

/**
 * Keeps volatile date/cwd reminders append-only across provider requests.
 *
 * The first value is attached to the first user turn. A changed value attaches
 * to a newly appended user turn or a persistent developer turn, leaving every
 * previously sent message byte-identical.
 */
export class DateCwdReminderInjector {
	#root: UserMessage | undefined;
	#currentReminder: string | undefined;
	#injections = new Map<Message, Message>();
	#controls: Array<{ anchor: Message; message: Message }> = [];
	#seen = new WeakSet<object>();

	/** Apply the current reminder while preserving all earlier injected bytes. */
	transform(context: Context, date: string, cwd: string): Context {
		if (!context.systemPrompt || context.systemPrompt.length === 0 || context.messages.length === 0) return context;
		const reminder = renderDateCwdReminder(date, cwd);
		const messages = this.#inject(context.messages, reminder);
		return messages === context.messages ? context : { ...context, messages };
	}

	#inject(messages: Message[], reminder: string): Message[] {
		const firstUser = messages.find((message): message is UserMessage => message.role === "user");
		if (!firstUser) return messages;
		if (this.#root !== firstUser) {
			this.#root = firstUser;
			this.#currentReminder = reminder;
			this.#injections.clear();
			this.#controls = [];
			this.#seen = new WeakSet();
			if (!messageStartsWithReminder(firstUser, reminder)) {
				this.#injections.set(firstUser, injectReminder(firstUser, reminder));
			}
		} else if (this.#currentReminder !== reminder) {
			let newUser: UserMessage | undefined;
			for (let index = messages.length - 1; index >= 0; index--) {
				const candidate = messages[index]!;
				if (candidate.role === "user" && !this.#seen.has(candidate)) {
					newUser = candidate;
					break;
				}
			}
			if (newUser) {
				this.#injections.set(newUser, injectReminder(newUser, reminder));
			} else {
				const anchor = messages.at(-1)!;
				this.#controls.push({
					anchor,
					message: {
						role: "developer",
						content: reminder,
						timestamp: Date.now(),
					},
				});
			}
			this.#currentReminder = reminder;
		}

		const controlsByAnchor = new Map<Message, Message[]>();
		for (const control of this.#controls) {
			const controls = controlsByAnchor.get(control.anchor);
			if (controls) controls.push(control.message);
			else controlsByAnchor.set(control.anchor, [control.message]);
		}

		let changed = false;
		const out: Message[] = [];
		for (const message of messages) {
			const injected = this.#injections.get(message);
			out.push(injected ?? message);
			if (injected) changed = true;
			const controls = controlsByAnchor.get(message);
			if (controls) {
				out.push(...controls);
				changed = true;
			}
			this.#seen.add(message);
		}
		return changed ? out : messages;
	}
}
