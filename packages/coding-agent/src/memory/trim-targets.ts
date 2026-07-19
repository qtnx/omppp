import { logger } from "@oh-my-pi/pi-utils";
import { closeAllAutoresearchStorages } from "../autoresearch/storage";
import { clearCache } from "../capability/fs";
import { disposeAllJuliaKernelSessions } from "../eval/jl/executor";
import { disposeAllVmContexts } from "../eval/js/context-manager";
import { disposeAllKernelSessions } from "../eval/py/executor";
import { mnemopiEmbedClient } from "../mnemopi/embed-client";
import { sttClient } from "../stt/asr-client";
import { tinyTitleClient } from "../tiny/title-client";
import { ttsClient } from "../tts/tts-client";

export interface WorkerTrimTargets {
	terminateAll(): Promise<void>;
}

export interface CacheTrimTargets {
	clear(): void;
}

export function buildWorkerTrimTargets(): WorkerTrimTargets {
	return {
		async terminateAll(): Promise<void> {
			await runWorkerTarget("tiny title client", () => tinyTitleClient.terminate());
			await runWorkerTarget("speech-to-text client", () => sttClient.terminate());
			await runWorkerTarget("text-to-speech client", () => ttsClient.terminate());
			await runWorkerTarget("mnemopi embed client", () => mnemopiEmbedClient.terminate());
			await runWorkerTarget("JavaScript eval contexts", disposeAllVmContexts);
			await runWorkerTarget("Python kernel sessions", disposeAllKernelSessions);
			await runWorkerTarget("Julia kernel sessions", disposeAllJuliaKernelSessions);
		},
	};
}

export function buildCacheTrimTargets(): CacheTrimTargets {
	return {
		clear(): void {
			runCacheTarget("capability filesystem cache", clearCache);
			runCacheTarget("autoresearch storages", closeAllAutoresearchStorages);
		},
	};
}

async function runWorkerTarget(name: string, operation: () => Promise<void>): Promise<void> {
	try {
		await operation();
	} catch (error) {
		logger.warn("idle memory trim worker cleanup failed", {
			target: name,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function runCacheTarget(name: string, operation: () => void): void {
	try {
		operation();
	} catch (error) {
		logger.warn("idle memory trim cache cleanup failed", {
			target: name,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
