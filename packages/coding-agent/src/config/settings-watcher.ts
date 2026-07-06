import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "./settings";

const SETTINGS_WATCH_DEBOUNCE_MS = 250;

export interface SettingsWatchTarget {
	dir: string;
	filenames?: readonly string[];
}

export class SettingsWatcher {
	#settings: Settings;
	#watchers: fs.FSWatcher[] = [];
	#reloadTimer?: NodeJS.Timeout;
	#pendingPaths = new Set<string>();
	#started = false;

	constructor(settings: Settings) {
		this.#settings = settings;
	}

	start(): void {
		if (this.#started) return;
		this.#started = true;

		this.#openWatches();
	}

	stop(): void {
		if (this.#reloadTimer) {
			clearTimeout(this.#reloadTimer);
			this.#reloadTimer = undefined;
		}
		this.#pendingPaths.clear();
		for (const watcher of this.#watchers) {
			watcher.close();
		}
		this.#watchers = [];
		this.#started = false;
	}

	#openWatches(): void {
		const configPath = this.#settings.getConfigPath();
		if (configPath) {
			this.#watchDirectory({ dir: path.dirname(configPath), filenames: [path.basename(configPath)] });
		}

		this.#watchDirectory({ dir: this.#settings.getCwd() });
		for (const filePath of this.#settings.getProjectSettingsPaths()) {
			this.#watchDirectory({ dir: path.dirname(filePath), filenames: [path.basename(filePath)] });
		}
	}

	#restartWatches(): void {
		for (const watcher of this.#watchers) {
			watcher.close();
		}
		this.#watchers = [];
		if (this.#started) {
			this.#openWatches();
		}
	}

	#watchDirectory(target: SettingsWatchTarget): void {
		try {
			const watcher = fs.watch(target.dir, (eventType, filename) => {
				this.#handleEvent(target, eventType, filename);
			});
			watcher.on("error", error => {
				logger.debug("Settings watcher error", { dir: target.dir, error: String(error) });
			});
			watcher.unref();
			this.#watchers.push(watcher);
		} catch (error) {
			logger.debug("Settings watcher unavailable", { dir: target.dir, error: String(error) });
		}
	}

	#handleEvent(target: SettingsWatchTarget, _eventType: string, filename: string | Buffer | null): void {
		const changedPath = filename ? path.join(target.dir, path.basename(filename.toString())) : target.dir;
		if (target.filenames && !target.filenames.includes(path.basename(changedPath))) return;
		this.#scheduleReload(changedPath);
	}

	#scheduleReload(changedPath: string): void {
		this.#pendingPaths.add(changedPath);
		clearTimeout(this.#reloadTimer);
		this.#reloadTimer = setTimeout(() => {
			this.#reloadTimer = undefined;
			const pendingPaths = [...this.#pendingPaths];
			this.#pendingPaths.clear();
			void this.#reloadPendingPaths(pendingPaths);
		}, SETTINGS_WATCH_DEBOUNCE_MS);
		this.#reloadTimer.unref?.();
	}

	async #reloadPendingPaths(pendingPaths: string[]): Promise<void> {
		try {
			for (const pendingPath of pendingPaths) {
				await this.#settings.reloadFromDisk({ source: "watcher", changedPath: pendingPath });
			}
		} catch (error) {
			logger.debug("Settings watcher reload failed", { error: String(error) });
		} finally {
			this.#restartWatches();
		}
	}
}
