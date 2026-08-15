import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { $which } from "@oh-my-pi/pi-utils/which";

export type CodeGraphStatus = "idle" | "initializing" | "ready" | "unavailable" | "failed";

export interface CodeGraphState {
	status: CodeGraphStatus;
	projectRoot: string;
	error?: string;
}

export interface CodeGraphCommandResult {
	command: readonly string[];
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface CodeGraphExploreOptions {
	projectPath?: string;
	maxFiles?: number;
	signal?: AbortSignal;
}

const CODEGRAPH_COMMAND = "codegraph";
const COMMAND_NOT_FOUND_EXIT_CODE = 127;
const managers = new Map<string, CodeGraphManager>();

export class CodeGraphManager {
	static async forProject(cwd: string): Promise<CodeGraphManager> {
		const absoluteCwd = path.resolve(cwd);
		let projectRoot = absoluteCwd;
		try {
			const child = Bun.spawn(["git", "-C", absoluteCwd, "rev-parse", "--show-toplevel"], {
				cwd: absoluteCwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			if (exitCode === 0 && stdout.trim()) projectRoot = stdout.trim();
		} catch (error) {
			logger.warn("CodeGraph could not resolve repository root; using current directory.", {
				cwd: absoluteCwd,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		const existing = managers.get(projectRoot);
		if (existing) return existing;
		const manager = new CodeGraphManager(projectRoot);
		managers.set(projectRoot, manager);
		return manager;
	}

	static disposeAll(): void {
		for (const manager of managers.values()) manager.close();
		managers.clear();
	}

	readonly projectRoot: string;
	#state: CodeGraphState;
	#executable: string | undefined;
	#readiness: Promise<CodeGraphState> | undefined;
	#mutation = Promise.resolve();
	#listeners = new Set<(state: CodeGraphState) => void>();
	#controller = new AbortController();
	#closed = false;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
		this.#state = { status: "idle", projectRoot };
	}

	getState(): CodeGraphState {
		return { ...this.#state };
	}

	onReady(listener: (state: CodeGraphState) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	start(): void {
		if (this.#closed || this.#readiness || this.#state.status === "ready") return;
		void this.ensureReady().catch(error => {
			logger.warn("CodeGraph background initialization failed.", {
				projectRoot: this.projectRoot,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	ensureReady(signal?: AbortSignal): Promise<CodeGraphState> {
		if (this.#state.status === "ready") return Promise.resolve(this.getState());
		if (this.#closed) return Promise.resolve(this.#setState("failed", "CodeGraph manager is closed."));
		if (this.#readiness) return this.#readiness;

		this.#readiness = this.#ensureReady(signal).finally(() => {
			this.#readiness = undefined;
		});
		return this.#readiness;
	}

	async init(signal?: AbortSignal): Promise<CodeGraphCommandResult> {
		return await this.#serializeMutation(async () => {
			const result = await this.#run(["init", this.projectRoot], signal);
			if (result.exitCode === 0) await this.#ignoreGeneratedIndex();
			return result;
		});
	}

	async index(signal?: AbortSignal): Promise<CodeGraphCommandResult> {
		return await this.#serializeMutation(async () => await this.#run(["index", "--quiet", this.projectRoot], signal));
	}

	async explore(query: string, options: CodeGraphExploreOptions = {}): Promise<CodeGraphCommandResult> {
		const state = await this.ensureReady(options.signal);
		if (state.status !== "ready") {
			throw new Error(state.error ?? "CodeGraph is not ready. Install codegraph and initialize this project first.");
		}

		const args = ["explore"];
		if (options.projectPath) args.push("--path", options.projectPath);
		if (options.maxFiles !== undefined) args.push("--max-files", String(options.maxFiles));
		args.push(query);
		return await this.#run(args, options.signal);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#controller.abort();
		this.#listeners.clear();
	}

	async #ensureReady(signal?: AbortSignal): Promise<CodeGraphState> {
		const executable = await this.#resolveExecutable();
		if (!executable) {
			return this.#setState(
				"unavailable",
				"CodeGraph executable was not found. Install it with: curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh",
			);
		}
		this.#executable = executable;
		this.#setState("initializing");

		try {
			const status = await this.#status(signal);
			if (status.initialized) {
				const sync = await this.#run(["sync", "--quiet", this.projectRoot], signal);
				if (sync.exitCode === 0) {
					await this.#ignoreGeneratedIndex();
					return this.#setState("ready");
				}
				return this.#setState("failed", this.#commandError("CodeGraph sync failed.", sync));
			}

			if (status.error) return this.#setState("failed", status.error);
			const initialized = await this.init(signal);
			if (initialized.exitCode === 0) return this.#setState("ready");

			const recheck = await this.#status(signal);
			if (recheck.initialized) {
				await this.#ignoreGeneratedIndex();
				return this.#setState("ready");
			}
			return this.#setState("failed", this.#commandError("CodeGraph initialization failed.", initialized));
		} catch (error) {
			return this.#setState("failed", error instanceof Error ? error.message : String(error));
		}
	}

	async #status(signal?: AbortSignal): Promise<{ initialized: boolean; error?: string }> {
		const result = await this.#run(["status", "--json", this.projectRoot], signal);
		if (result.exitCode !== 0)
			return { initialized: false, error: this.#commandError("CodeGraph status failed.", result) };
		try {
			const parsed: unknown = JSON.parse(result.stdout);
			return {
				initialized:
					typeof parsed === "object" && parsed !== null && "initialized" in parsed && parsed.initialized === true,
			};
		} catch (error) {
			return {
				initialized: false,
				error: `CodeGraph status returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	async #resolveExecutable(): Promise<string | null> {
		const searchPath = process.env.PATH;
		const executable = $which(CODEGRAPH_COMMAND, { cwd: this.projectRoot, PATH: searchPath });
		if (executable) return executable;

		const home = process.env.HOME;
		if (!home) return null;
		const managedExecutable = path.join(home, ".local", "bin", CODEGRAPH_COMMAND);
		return (await Bun.file(managedExecutable).exists()) ? managedExecutable : null;
	}

	async #run(args: readonly string[], signal?: AbortSignal): Promise<CodeGraphCommandResult> {
		const command = [CODEGRAPH_COMMAND, ...args] as const;
		const executable = this.#executable ?? (await this.#resolveExecutable());
		if (!executable) {
			return {
				command,
				exitCode: COMMAND_NOT_FOUND_EXIT_CODE,
				stdout: "",
				stderr:
					"CodeGraph executable was not found. Install it with: curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh",
			};
		}
		this.#executable = executable;

		try {
			const child = Bun.spawn([executable, ...args], {
				cwd: this.projectRoot,
				env: process.env,
				signal: signal ? AbortSignal.any([this.#controller.signal, signal]) : this.#controller.signal,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { command, exitCode, stdout, stderr };
		} catch (error) {
			return {
				command,
				exitCode: COMMAND_NOT_FOUND_EXIT_CODE,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#mutation;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#mutation = promise;
		await previous;
		try {
			return await operation();
		} finally {
			resolve();
		}
	}

	async #ignoreGeneratedIndex(): Promise<void> {
		const ignorePath = path.join(this.projectRoot, ".codegraph", ".gitignore");
		if (!(await Bun.file(ignorePath).exists())) return;
		try {
			await Bun.write(ignorePath, "*\n");
		} catch (error) {
			logger.warn("CodeGraph index was initialized but its generated ignore file could not be normalized.", {
				projectRoot: this.projectRoot,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#commandError(prefix: string, result: CodeGraphCommandResult): string {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
		return `${prefix} ${detail}`;
	}

	#setState(status: CodeGraphStatus, error?: string): CodeGraphState {
		const previousStatus = this.#state.status;
		this.#state = error
			? { status, projectRoot: this.projectRoot, error }
			: { status, projectRoot: this.projectRoot };
		if (status === "ready" && previousStatus !== "ready") {
			const state = this.getState();
			for (const listener of this.#listeners) {
				try {
					listener(state);
				} catch (listenerError) {
					logger.warn("CodeGraph readiness listener failed.", {
						projectRoot: this.projectRoot,
						error: listenerError instanceof Error ? listenerError.message : String(listenerError),
					});
				}
			}
		}
		return this.getState();
	}
}
