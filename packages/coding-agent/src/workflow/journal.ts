/**
 * Append-only journal of agent() results, keyed by a chained hash of
 * (prompt, opts, prevKey). On resume, the longest unchanged prefix returns
 * cached results; the first diverging key (and everything after) re-runs live.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkflowAgentOpts } from "./types";

export interface JournalEntry {
	type: "result";
	key: string;
	agentId: string;
	result: string;
}

/** Stable cache key chaining the previous key so order + content both matter. */
export function computeCacheKey(prompt: string, opts: WorkflowAgentOpts, prevKey: string): string {
	const optsCanonical = JSON.stringify({
		schema: opts.schema ?? null,
		model: opts.model ?? null,
		agentType: opts.agentType ?? null,
		isolation: opts.isolation ?? null,
	});
	return Bun.hash(`${prevKey}\u0000${prompt}\u0000${optsCanonical}`).toString(16);
}

export class WorkflowJournal {
	#handle: fs.FileHandle | null;
	readonly #cache = new Map<string, JournalEntry>();

	private constructor(handle: fs.FileHandle | null, cache: Map<string, JournalEntry>) {
		this.#handle = handle;
		for (const [k, v] of cache) this.#cache.set(k, v);
	}

	/** Open for writing (truncates a fresh run's journal). */
	static async open(file: string): Promise<WorkflowJournal> {
		await fs.mkdir(path.dirname(file), { recursive: true });
		const handle = await fs.open(file, "w");
		return new WorkflowJournal(handle, new Map());
	}

	/** Open for resume: load prior entries (read-only cache + append handle). */
	static async openForResume(file: string): Promise<WorkflowJournal> {
		const cache = new Map<string, JournalEntry>();
		try {
			const text = await fs.readFile(file, "utf8");
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				const entry = JSON.parse(line) as JournalEntry;
				if (entry.type === "result") cache.set(entry.key, entry);
			}
		} catch {
			// No prior journal — nothing cached.
		}
		await fs.mkdir(path.dirname(file), { recursive: true });
		const handle = await fs.open(file, "a");
		return new WorkflowJournal(handle, cache);
	}

	lookup(key: string): JournalEntry | undefined {
		return this.#cache.get(key);
	}

	async recordResult(key: string, agentId: string, result: string): Promise<void> {
		const entry: JournalEntry = { type: "result", key, agentId, result };
		this.#cache.set(key, entry);
		await this.#handle?.write(`${JSON.stringify(entry)}\n`);
	}

	async close(): Promise<void> {
		await this.#handle?.close();
		this.#handle = null;
	}
}
