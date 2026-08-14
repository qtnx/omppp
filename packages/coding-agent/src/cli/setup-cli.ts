/**
 * Setup CLI command handler.
 *
 * Handles `ompx setup` for onboarding and `ompx setup <component>` for optional dependencies.
 */
import * as path from "node:path";
import { $which, APP_NAME, getProjectDir, getPythonEnvDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { $ } from "bun";
import { DEFAULT_LINUX_PODMAN_IMAGE } from "../config/sandbox-defaults";
import { Settings, settings } from "../config/settings";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import { theme } from "../modes/theme/theme";
import { downloadSttModel, isSttModelCached } from "../stt/downloader";
import { isSttModelKey, STT_MODEL_OPTIONS } from "../stt/models";
import { resolveLinuxPodmanSandboxImage, validateLinuxPodmanSandboxImage } from "../task/omp-command";
import { downloadTtsModel, isTtsLocalModelKey, isTtsModelCached, TTS_LOCAL_MODEL_OPTIONS } from "../tts";
import { selectSetupModel } from "./setup-model-picker";

export type SetupComponent = "python" | "speech" | "podman";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = ["python", "speech", "podman"];

const MANAGED_PYTHON_ENV = getPythonEnvDir();

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	if (args.length < 2) {
		console.error(chalk.red(`Usage: ${APP_NAME} setup <component>`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const component = args[1];
	if (!VALID_COMPONENTS.includes(component as SetupComponent)) {
		console.error(chalk.red(`Unknown component: ${component}`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		}
	}

	return {
		component: component as SetupComponent,
		flags,
	};
}

export interface PythonCheckResult {
	available: boolean;
	pythonPath?: string;
	usingManagedEnv?: boolean;
	managedEnvPath?: string;
}

function managedPythonPath(): string {
	return process.platform === "win32"
		? path.join(MANAGED_PYTHON_ENV, "Scripts", "python.exe")
		: path.join(MANAGED_PYTHON_ENV, "bin", "python");
}

/**
 * Check Python environment and kernel dependencies.
 */
export async function checkPythonSetup(cwd: string, interpreter?: string): Promise<PythonCheckResult> {
	const availability = await checkPythonKernelAvailability(cwd, interpreter, { forceProbe: true });
	return {
		available: availability.ok,
		pythonPath: availability.pythonPath,
		usingManagedEnv: availability.pythonPath === managedPythonPath(),
		managedEnvPath: MANAGED_PYTHON_ENV,
	};
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
// Python installation helper removed: the subprocess runner has no Python
// package dependencies beyond a working interpreter. `ompx setup python --check`
// remains as a probe; users install optional libs (pandas, matplotlib, ...)
// directly via pip or the in-process `%pip` magic.

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	switch (cmd.component) {
		case "python":
			await handlePythonSetup(cmd.flags);
			break;
		case "speech":
			await handleSpeechSetup(cmd.flags);
			break;
		case "podman":
			await handlePodmanSetup(cmd.flags);
			break;
	}
}

async function handlePythonSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const cwd = getProjectDir();
	const projectSettings = await Settings.init({ cwd });
	const interpreter = projectSettings.get("python.interpreter")?.trim() || undefined;
	const check = await checkPythonSetup(cwd, interpreter);

	if (flags.json) {
		console.log(JSON.stringify(check, null, 2));
		if (!check.available) process.exit(1);
		return;
	}

	if (!check.pythonPath) {
		console.error(chalk.red(`${theme.status.error} Python not found`));
		console.error(chalk.dim("Install Python 3.8+ or set python.interpreter to its executable path"));
		process.exit(1);
	}

	console.log(chalk.dim(`Python: ${check.pythonPath}`));
	if (check.usingManagedEnv) {
		console.log(chalk.dim(`Using managed environment: ${check.managedEnvPath}`));
	}

	if (check.available) {
		console.log(chalk.green(`\n${theme.status.success} Python execution is ready`));
		return;
	}

	console.error(chalk.red(`\n${theme.status.error} Python interpreter reported failure`));
	process.exit(1);
}

/**
 * One installable speech dependency. `isReady`/`status` are read-only probes;
 * `pick` (optional) lets an interactive user choose + persist a model; `ensure`
 * performs the download, streaming a normalized progress event.
 */
interface SpeechComponent {
	name: string;
	isReady(): Promise<boolean>;
	status(): Promise<string>;
	pick?(): Promise<boolean>;
	ensure(onProgress: (progress: { stage: string; percent?: number }) => void): Promise<void>;
}

function buildSpeechComponents(): SpeechComponent[] {
	return [
		{
			name: "Speech-to-Text model",
			isReady: () => isSttModelCached(settings.get("stt.modelName")),
			status: async () => {
				const key = settings.get("stt.modelName");
				return (await isSttModelCached(key)) ? key : `${key} — not downloaded`;
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					"Speech-to-Text model",
					[...STT_MODEL_OPTIONS],
					settings.get("stt.modelName"),
				);
				if (chosen === null) return false;
				if (isSttModelKey(chosen)) {
					settings.set("stt.modelName", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: onProgress =>
				downloadSttModel(settings.get("stt.modelName"), progress =>
					onProgress({ stage: `Downloading ${progress.label} model`, percent: progress.percent }),
				),
		},
		{
			name: "Text-to-Speech model",
			isReady: () => isTtsModelCached(settings.get("tts.localModel")),
			status: async () => {
				const key = settings.get("tts.localModel");
				return (await isTtsModelCached(key)) ? key : `${key} — model/runtime not installed`;
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					"Text-to-Speech model",
					[...TTS_LOCAL_MODEL_OPTIONS],
					settings.get("tts.localModel"),
				);
				if (chosen === null) return false;
				if (isTtsLocalModelKey(chosen)) {
					settings.set("tts.localModel", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: async onProgress => {
				const ok = await downloadTtsModel(settings.get("tts.localModel"), progress =>
					onProgress({ stage: progress.stage, percent: progress.percent }),
				);
				if (!ok) throw new Error("Failed to download the local text-to-speech model.");
			},
		},
	];
}

/**
 * Unified `omp setup speech` flow. Drives every {@link SpeechComponent} through
 * one path: report (`--json`/`--check`) or install (interactive pick + ensure
 * with single-line progress; non-TTY skips pickers and installs configured
 * values).
 */
async function handleSpeechSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	await Settings.init({ cwd: getProjectDir() });
	const components = buildSpeechComponents();

	if (flags.json) {
		const report: Record<string, { ready: boolean; status: string }> = {};
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			report[component.name] = { ready, status: await component.status() };
		}
		console.log(JSON.stringify(report, null, 2));
		if (!allReady) process.exit(1);
		return;
	}

	if (flags.check) {
		console.log(chalk.bold("Speech dependencies:"));
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			const mark = ready ? chalk.green("[ok]") : chalk.yellow("[missing]");
			console.log(`  ${mark} ${component.name}: ${await component.status()}`);
		}
		if (!allReady) process.exit(1);
		return;
	}

	const interactive = Boolean(process.stdout.isTTY);
	for (const component of components) {
		if (interactive && component.pick) {
			await component.pick();
		}
		if (await component.isReady()) {
			console.log(chalk.green(`${theme.status.success} ${component.name} ready`));
			continue;
		}
		console.log(chalk.dim(`Preparing ${component.name}...`));
		try {
			await component.ensure(progress => {
				const percent = typeof progress.percent === "number" ? ` (${progress.percent}%)` : "";
				process.stdout.write(`\r${chalk.dim(`${progress.stage}${percent}`)}\x1b[K`);
			});
			process.stdout.write("\n");
		} catch (err) {
			process.stdout.write("\n");
			const msg = err instanceof Error ? err.message : `Failed to set up ${component.name}`;
			console.error(chalk.red(`${theme.status.error} ${msg}`));
			process.exit(1);
		}
	}

	console.log(chalk.green(`\n${theme.status.success} Speech is ready`));
	console.log(
		chalk.dim(
			"Enable speech-to-text via stt.enabled, then hold Space to talk (or bind app.stt.toggle); enable the speech-generation tool via speechgen.enabled; speak replies aloud via speech.enabled.",
		),
	);
}

interface PodmanCheckResult {
	available: boolean;
	podmanPath?: string;
	version?: string;
	rootless?: boolean;
	graphDriver?: string;
	ociRuntime?: string;
	image?: string;
	imageValid?: boolean;
	installHint: string;
}

async function checkPodmanSetup(): Promise<PodmanCheckResult> {
	const podmanPath = $which("podman");
	const image = resolveLinuxPodmanSandboxImage(process.env);
	const imageValid = image ? validateLinuxPodmanSandboxImage(image) : undefined;
	const result: PodmanCheckResult = {
		available: false,
		image,
		imageValid,
		installHint:
			"Install rootless Podman plus uidmap/newuidmap/newgidmap and fuse-overlayfs from your OS package manager.",
	};
	if (!podmanPath) return result;
	result.podmanPath = podmanPath;
	const version = await $`${podmanPath} --version`.quiet().nothrow();
	if (version.exitCode === 0) result.version = version.text().trim();
	const info =
		await $`${podmanPath} info --format "{{.Host.Security.Rootless}} {{.Store.GraphDriverName}} {{.Host.OCIRuntime.Name}}"`
			.quiet()
			.nothrow();
	if (info.exitCode !== 0) return result;
	const [rootless, graphDriver, ociRuntime] = info.text().trim().split(/\s+/, 3);
	result.available = true;
	result.rootless = rootless === "true";
	result.graphDriver = graphDriver;
	result.ociRuntime = ociRuntime;
	return result;
}

async function handlePodmanSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const status = await checkPodmanSetup();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
		if (!status.available || status.rootless === false || !status.image || status.imageValid === false)
			process.exit(1);
		return;
	}

	if (!status.available) {
		process.stderr.write(`${chalk.red(`${theme.status.error} Podman not ready`)}\n`);
		process.stderr.write(`${chalk.dim(status.installHint)}\n`);
		process.exit(1);
	}
	process.stdout.write(`${chalk.dim(`Podman: ${status.podmanPath ?? "podman"}`)}\n`);
	if (status.version) process.stdout.write(`${chalk.dim(`Version: ${status.version}`)}\n`);
	process.stdout.write(`${chalk.dim(`Rootless: ${status.rootless === true ? "yes" : "no"}`)}\n`);
	if (status.graphDriver) process.stdout.write(`${chalk.dim(`Storage: ${status.graphDriver}`)}\n`);
	if (status.image) process.stdout.write(`${chalk.dim(`Image: ${status.image}`)}\n`);
	if (status.image === DEFAULT_LINUX_PODMAN_IMAGE) {
		process.stdout.write(
			`${chalk.dim("Default dev image: build with `bun run pi:image` from a source checkout, or override with PI_OMPX_PODMAN_IMAGE/sandbox.podman.image.")}\n`,
		);
	}
	if (status.ociRuntime) process.stdout.write(`${chalk.dim(`Runtime: ${status.ociRuntime}`)}\n`);
	if (!status.rootless) {
		process.stderr.write(chalk.red(`\n${theme.status.error} Rootless Podman is required for workspace sandboxing\n`));
		process.exit(1);
	}
	if (!status.image) {
		process.stderr.write(chalk.red(`\n${theme.status.error} Podman image could not be resolved\n`));
		process.exit(1);
	}
	if (status.imageValid === false) {
		process.stderr.write(chalk.red(`\n${theme.status.error} Podman image must be a single OCI image reference\n`));
		process.exit(1);
	}
	process.stdout.write(chalk.green(`\n${theme.status.success} Linux Podman sandbox prerequisites are ready\n`));
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} setup`)} - Run onboarding or install dependencies for optional features

${chalk.bold("Usage:")}
  ${APP_NAME} setup                     Run the onboarding wizard
  ${APP_NAME} setup <component> [options]

${chalk.bold("Components:")}
  python    Verify a Python 3 interpreter is reachable for code execution
  speech    Pick and download speech-to-text and text-to-speech models
  podman    Check Linux Podman prerequisites for workspace sandboxing

${chalk.bold("Options:")}
  -c, --check   Check if dependencies are installed without installing
  --json        Output status as JSON

${chalk.bold("Examples:")}
  ${APP_NAME} setup                  Run the onboarding wizard
  ${APP_NAME} setup python           Check Python execution dependencies
  ${APP_NAME} setup speech           Pick and download the STT and TTS models
  ${APP_NAME} setup speech --check   Check if speech dependencies are available
  ${APP_NAME} setup podman --check   Check Linux Podman workspace sandbox prerequisites
  ${APP_NAME} setup python --check   Check if Python execution is available
`);
}
