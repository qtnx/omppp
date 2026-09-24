import { ThinkingLevel, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { DuoResolvedConfig } from "../src/config/model-resolver";
import { DuoController, type DuoControllerHost } from "../src/duo/controller";
import { formatRoutingHistory } from "../src/session/session-history-format";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { TYPESAFE_SYSTEMONE_URL, TurnSignalService, TypeSafeClient } from "../src/signals/index";
import type { TurnSignals } from "../src/signals/types";

const DEFAULT_CASES_PATH = `${import.meta.dir}/../test/fixtures/duo-routing-eval.json`;
const DEFAULT_REPEATS = 1;
const DEFAULT_MIN_ACCURACY = 0.85;
const REQUEST_TIMEOUT_MS = 10_000;
const ROUTING_MIN_CONFIDENCE = 0.7;
const MODEL_IDS = ["deepseek-v4.1-flash", "opus-5", "gpt-6-astra", "fable-5-1"] as const;
const DATASET_PHASES = ["preplanning", "planning", "implementing", "debugging", "verifying", "reporting"] as const;
const MESSAGE_ROLES = ["user", "assistant", "toolResult"] as const;
type ExpectedModel = (typeof MODEL_IDS)[number];
type DatasetPhase = (typeof DATASET_PHASES)[number];
type MessageRole = (typeof MESSAGE_ROLES)[number];
type DatasetSplit = "calibration" | "holdout";

type DatasetMessage = { role: MessageRole; text: string };
interface DatasetExpected {
	difficulty: string[];
	thinking: string[];
	models: ExpectedModel[];
}
interface DatasetCase {
	id: string;
	split: DatasetSplit;
	request: string;
	history: DatasetMessage[];
	transcript?: DatasetMessage[];
	phase: DatasetPhase;
	suppressed: string[];
	expected: DatasetExpected;
	critical: boolean;
}
interface Dataset {
	cases: DatasetCase[];
}
interface CliOptions {
	casesPath: string;
	repeats: number;
	limit?: number;
	jsonPath?: string;
	minAccuracy: number;
	help: boolean;
}
interface ObservedSignals {
	difficulty?: string;
	effort?: string;
	difficultyConfidence?: number;
	phaseConfidence?: number;
}
interface SampleResult {
	id: string;
	caseId: string;
	split: DatasetSplit;
	status: "PASS" | "FAIL" | "UNAVAILABLE";
	critical: boolean;
	phase: DatasetPhase;
	expected: DatasetExpected;
	observed: {
		difficulty?: string;
		effort?: string;
		model?: string;
		confidence: { difficulty?: number; phase?: number };
	};
	latencyMs: number;
	available: boolean;
	covered: boolean;
	abstainedForConfidence: boolean;
	criticalModelViolation: boolean;
	difficultyAllowed: boolean;
	effortAllowed: boolean;
	modelAllowed: boolean;
	exactAllowed: boolean;
	error?: string;
}
interface AccuracyMetrics {
	samples: number;
	available: number;
	unavailable: number;
	exactAllowedLabel: number;
	modelOnly: number;
	difficultyOnly: number;
	effortOnly: number;
	accuracy: number;
	modelAccuracy: number;
	coverage: number;
	covered: number;
	abstentions: number;
	criticalModelViolations: number;
}
interface EvaluationReport {
	endpoint: { hostname: string; model: string };
	options: { repeats: number; limit?: number; minAccuracy: number };
	counts: { cases: number; samples: number; failures: number; unavailable: number };
	samples: SampleResult[];
	metrics: AccuracyMetrics;
	splits: Record<DatasetSplit, AccuracyMetrics>;
	confusion: {
		difficulty: Record<string, Record<string, number>>;
		model: Record<string, Record<string, number>>;
	};
	failure: { endpointUnavailable: boolean; criticalModelViolation: boolean; belowMinAccuracy: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failAt(path: string, message: string): never {
	throw new Error(`${path}: ${message}`);
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (!allowedSet.has(key)) failAt(path, `unknown field ${JSON.stringify(key)}`);
	}
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) failAt(`${path}.${key}`, "expected non-empty string");
	return value;
}

function stringArray(record: Record<string, unknown>, key: string, path: string): string[] {
	const value = record[key];
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some(item => typeof item !== "string" || item.length === 0)
	) {
		failAt(`${path}.${key}`, "expected non-empty string array");
	}
	return value.slice();
}

function datasetMessage(value: unknown, path: string): DatasetMessage {
	if (!isRecord(value)) failAt(path, "expected object");
	onlyKeys(value, ["role", "text"], path);
	const role = requiredString(value, "role", path);
	if (!(MESSAGE_ROLES as readonly string[]).includes(role))
		failAt(`${path}.role`, `expected one of ${MESSAGE_ROLES.join(", ")}`);
	return { role: role as MessageRole, text: requiredString(value, "text", path) };
}

function datasetCase(value: unknown, index: number): DatasetCase {
	const path = `cases[${index}]`;
	if (!isRecord(value)) failAt(path, "expected object");
	onlyKeys(
		value,
		["id", "split", "request", "history", "transcript", "phase", "suppressed", "expected", "critical"],
		path,
	);
	const id = requiredString(value, "id", path);
	const split = requiredString(value, "split", path);
	if (split !== "calibration" && split !== "holdout") failAt(`${path}.split`, "expected calibration or holdout");
	const request = requiredString(value, "request", path);
	const historyValue = value.history;
	if (!Array.isArray(historyValue)) failAt(`${path}.history`, "expected array");
	const history = historyValue.map((item, messageIndex) => datasetMessage(item, `${path}.history[${messageIndex}]`));
	let transcript: DatasetMessage[] | undefined;
	if (value.transcript !== undefined) {
		if (!Array.isArray(value.transcript)) failAt(`${path}.transcript`, "expected array");
		transcript = value.transcript.map((item, messageIndex) =>
			datasetMessage(item, `${path}.transcript[${messageIndex}]`),
		);
	}
	const phase = requiredString(value, "phase", path);
	if (!(DATASET_PHASES as readonly string[]).includes(phase)) {
		failAt(`${path}.phase`, `expected one of ${DATASET_PHASES.join(", ")}`);
	}
	let suppressed: string[] = [];
	if (value.suppressed !== undefined) {
		if (
			!Array.isArray(value.suppressed) ||
			value.suppressed.some(item => typeof item !== "string" || item.length === 0)
		) {
			failAt(`${path}.suppressed`, "expected string array");
		}
		suppressed = value.suppressed.slice();
	}
	if (!isRecord(value.expected)) failAt(`${path}.expected`, "expected object");
	onlyKeys(value.expected, ["difficulty", "thinking", "models"], `${path}.expected`);
	const difficulty = stringArray(value.expected, "difficulty", `${path}.expected`);
	const thinking = stringArray(value.expected, "thinking", `${path}.expected`);
	const models = stringArray(value.expected, "models", `${path}.expected`);
	if (models.some(model => !(MODEL_IDS as readonly string[]).includes(model))) {
		failAt(`${path}.expected.models`, `expected only ${MODEL_IDS.join(", ")}`);
	}
	let critical = false;
	if (value.critical !== undefined) {
		if (typeof value.critical !== "boolean") failAt(`${path}.critical`, "expected boolean");
		critical = value.critical;
	}
	return {
		id,
		split: split as DatasetSplit,
		request,
		history,
		...(transcript === undefined ? {} : { transcript }),
		phase: phase as DatasetPhase,
		suppressed,
		expected: { difficulty, thinking, models: models as ExpectedModel[] },
		critical,
	};
}

function validateDataset(value: unknown): Dataset {
	if (!isRecord(value)) failAt("dataset", "expected object");
	onlyKeys(value, ["cases"], "dataset");
	if (!Array.isArray(value.cases)) failAt("dataset.cases", "expected array");
	const cases = value.cases.map((item, index) => datasetCase(item, index));
	const ids = new Set<string>();
	for (const item of cases) {
		if (ids.has(item.id)) failAt("dataset.cases", `duplicate id ${JSON.stringify(item.id)}`);
		ids.add(item.id);
	}
	if (cases.length === 0) failAt("dataset.cases", "must contain at least one case");
	return { cases };
}

function parsePositiveInteger(value: string, flag: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`${flag} expects a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} expects a positive integer`);
	return parsed;
}

function parseOptions(argv: string[]): CliOptions {
	let casesPath = DEFAULT_CASES_PATH;
	let repeats = DEFAULT_REPEATS;
	let limit: number | undefined;
	let jsonPath: string | undefined;
	let minAccuracy = DEFAULT_MIN_ACCURACY;
	let help = false;
	const seen = new Set<string>();
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help") {
			help = true;
			continue;
		}
		if (!arg.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
		const equals = arg.indexOf("=");
		const flag = equals === -1 ? arg : arg.slice(0, equals);
		if (!["--cases", "--repeats", "--limit", "--json", "--min-accuracy"].includes(flag)) {
			throw new Error(`unknown flag ${JSON.stringify(flag)}`);
		}
		if (seen.has(flag)) throw new Error(`duplicate flag ${flag}`);
		seen.add(flag);
		let value = equals === -1 ? undefined : arg.slice(equals + 1);
		if (value === undefined) {
			value = argv[++index];
			if (value === undefined || value.startsWith("--")) throw new Error(`${flag} expects a value`);
		}
		if (value.length === 0) throw new Error(`${flag} expects a non-empty value`);
		values.set(flag, value);
	}
	if (values.has("--cases")) casesPath = values.get("--cases") as string;
	if (values.has("--repeats")) repeats = parsePositiveInteger(values.get("--repeats") as string, "--repeats");
	if (values.has("--limit")) limit = parsePositiveInteger(values.get("--limit") as string, "--limit");
	if (values.has("--json")) jsonPath = values.get("--json") as string;
	if (values.has("--min-accuracy")) {
		const parsed = Number(values.get("--min-accuracy"));
		if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
			throw new Error("--min-accuracy expects decimal from 0 to 1");
		minAccuracy = parsed;
	}
	return {
		casesPath,
		repeats,
		...(limit === undefined ? {} : { limit }),
		...(jsonPath === undefined ? {} : { jsonPath }),
		minAccuracy,
		help,
	};
}

function usage(): string {
	return `Usage: bun scripts/eval-duo-routing.ts [options]

Runs live Jev classifications through DuoController against labeled cases.

Options:
  --cases PATH          Dataset JSON (default: test/fixtures/duo-routing-eval.json)
  --repeats N           Independent live runs per case (default: 1)
  --limit N             Evaluate first N cases after validation
  --json PATH           Write JSON report without credentials or prompt text
  --min-accuracy N      Minimum exact allowed-label accuracy, 0..1 (default: 0.85)
  --help                Show this help

Metrics: per-case PASS/FAIL, exact allowed-label accuracy, model-only accuracy,
coverage and confidence abstentions, unavailable requests, split metrics, and
expected/observed difficulty and model confusion matrices.`;
}

function fixtureModel(id: string): Model {
	return buildModel({
		id,
		name: `Fixture ${id}`,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://fixture.invalid",
		reasoning: true,
		thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
}

function messageToAgent(message: DatasetMessage, index: number, caseId: string, repeat: number): AgentMessage {
	const timestamp = index + 1;
	if (message.role === "user") {
		return { role: "user", content: message.text, timestamp } satisfies AgentMessage;
	}
	if (message.role === "assistant") {
		return {
			role: "assistant",
			content: [{ type: "text", text: message.text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: `duo-routing-eval-${caseId}-${repeat}`,
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp,
		} satisfies AgentMessage;
	}
	return {
		role: "toolResult",
		toolCallId: `duo-routing-${caseId}-${repeat}-${index}`,
		toolName: "bash",
		content: [{ type: "text", text: message.text }],
		isError: message.text.toLowerCase().includes("failure") || message.text.toLowerCase().includes("error"),
		timestamp,
	} satisfies AgentMessage;
}

function buildMessages(messages: DatasetMessage[], caseId: string, repeat: number, offset = 0): AgentMessage[] {
	return messages.map((message, index) => messageToAgent(message, index + offset, caseId, repeat));
}

interface EvaluationFixture {
	host: DuoControllerHost & { model: Model | undefined };
	controller: DuoController;
	service: TurnSignalService;
	priorContext?: string;
	transcriptContext?: string;
}

function buildFixture(testCase: DatasetCase, repeat: number): EvaluationFixture {
	const deepseek = fixtureModel("deepseek-v4.1-flash");
	const opus = fixtureModel("opus-5");
	const astra = fixtureModel("gpt-6-astra");
	const fable = fixtureModel("fable-5-1");
	const models = [deepseek, opus, astra, fable];
	const selectors = new Map(models.map(model => [model.id, `${model.provider}/${model.id}`]));
	const suppressed = new Set(testCase.suppressed);
	let currentModel: Model | undefined = opus;
	let currentThinking: ConfiguredThinkingLevel | undefined = ThinkingLevel.High;
	let orchestrator = true;
	let planMode = false;
	const host: DuoControllerHost & { model: Model | undefined } = {
		model: currentModel,
		currentModel: () => currentModel,
		availableModels: () => models,
		isStreaming: () => false,
		async setModelTemporary(model, thinkingLevel) {
			currentModel = model;
			host.model = model;
			if (thinkingLevel !== undefined) currentThinking = thinkingLevel;
		},
		setThinkingLevel(level) {
			currentThinking = level;
		},
		configuredThinkingLevel: () => currentThinking,
		ensureAdvisorStarted: () => true,
		stopDuoAdvisor() {},
		pauseAdvisor() {},
		resumeAdvisor() {},
		injectBrief() {},
		emitNotice() {},
		persistSnapshot() {},
		orchestratorEnabled: () => orchestrator,
		setOrchestratorEnabled(enabled) {
			orchestrator = enabled;
		},
		setPlanModeEnabled(enabled) {
			planMode = enabled;
		},
		planModeActive: () => planMode,
		duoMode: () => "on",
		isSelectorSuppressed(selector) {
			const modelId = selector.includes("/") ? selector.slice(selector.lastIndexOf("/") + 1) : selector;
			return suppressed.has(selector) || suppressed.has(modelId);
		},
		installFallbackChain() {},
		phasePolicy: () => ({ minConfidence: ROUTING_MIN_CONFIDENCE, stuckThreshold: Number.POSITIVE_INFINITY }),
	};
	const routingConfig: DuoResolvedConfig["routing"] = {
		ladder: models.map(model => ({ selector: selectors.get(model.id) ?? model.id, model })),
		thinking: {
			easy: ThinkingLevel.Medium,
			moderate: ThinkingLevel.High,
			hard: ThinkingLevel.High,
			extreme: ThinkingLevel.XHigh,
		},
	};
	const config: DuoResolvedConfig = {
		mode: "on",
		orchestrator: "auto",
		planner: fable,
		plannerThinking: ThinkingLevel.High,
		executor: deepseek,
		executorThinking: ThinkingLevel.High,
		cooldownTurns: 2,
		maxConsecutive: 0,
		doneGate: "strict",
		advisorPromptReview: false,
		manualSwitchIntent: "plan",
		signals: { enabled: false, sentiment: false, failureThreshold: 99, loopThreshold: 99, planningNeeded: false },
		phaseModels: {
			preplanning: [{ selector: selectors.get(opus.id) ?? opus.id, model: opus, thinkingLevel: ThinkingLevel.High }],
		},
		routing: routingConfig,
	};
	const client = new TypeSafeClient({
		apiKey: Bun.env.TYPESAFE_API_KEY,
		baseUrl: Bun.env.TYPESAFE_SYSTEMONE_URL ?? TYPESAFE_SYSTEMONE_URL,
		model: "jev-latest",
		timeoutMs: REQUEST_TIMEOUT_MS,
	});
	const service = new TurnSignalService(client);
	const history = buildMessages(testCase.history, testCase.id, repeat);
	const priorContext = history.length > 0 ? formatRoutingHistory(history) : undefined;
	const transcript =
		testCase.transcript === undefined
			? undefined
			: history.concat(buildMessages(testCase.transcript, testCase.id, repeat, history.length));
	const controller = new DuoController(host, config);
	return {
		host,
		controller,
		service,
		...(priorContext === undefined ? {} : { priorContext }),
		...(transcript === undefined ? {} : { transcriptContext: formatRoutingHistory(transcript) }),
	};
}

function emptyObserved(): ObservedSignals {
	return {};
}

function sampleResult(
	testCase: DatasetCase,
	repeat: number,
	started: number,
	observed: ObservedSignals,
	model: string | undefined,
	available: boolean,
	abstainedForConfidence: boolean,
	error?: string,
): SampleResult {
	const expected = testCase.expected;
	const difficultyAllowed = observed.difficulty !== undefined && expected.difficulty.includes(observed.difficulty);
	const effortAllowed = observed.effort !== undefined && expected.thinking.includes(observed.effort);
	const modelAllowed = model !== undefined && expected.models.includes(model as ExpectedModel);
	const exactAllowed = available && error === undefined && difficultyAllowed && effortAllowed && modelAllowed;
	const criticalModelViolation = testCase.critical && !modelAllowed;
	return {
		id: `${testCase.id}#${repeat}`,
		caseId: testCase.id,
		split: testCase.split,
		status: !available ? "UNAVAILABLE" : exactAllowed ? "PASS" : "FAIL",
		critical: testCase.critical,
		phase: testCase.phase,
		expected,
		observed: {
			...(observed.difficulty === undefined ? {} : { difficulty: observed.difficulty }),
			...(observed.effort === undefined ? {} : { effort: observed.effort }),
			...(model === undefined ? {} : { model }),
			confidence: { difficulty: observed.difficultyConfidence, phase: observed.phaseConfidence },
		},
		latencyMs: Math.round((performance.now() - started) * 100) / 100,
		available,
		covered: available && observed.difficulty !== undefined && observed.effort !== undefined && model !== undefined,
		abstainedForConfidence,
		criticalModelViolation,
		difficultyAllowed,
		effortAllowed,
		modelAllowed,
		exactAllowed,
		...(error === undefined ? {} : { error }),
	};
}

async function evaluateCase(testCase: DatasetCase, repeat: number): Promise<SampleResult> {
	const started = performance.now();
	const fixture = buildFixture(testCase, repeat);
	const observed = emptyObserved();
	let available = true;
	let abstainedForConfidence = false;
	try {
		await fixture.controller.reevaluate();
		const phaseResult = await fixture.controller.requestPhaseChange(testCase.phase, "routing evaluation");
		if (phaseResult !== "ok") {
			return sampleResult(
				testCase,
				repeat,
				started,
				observed,
				fixture.host.model?.id,
				true,
				false,
				`phase change ${phaseResult}`,
			);
		}
		const promptSignals = await fixture.service.classifyPrompt(testCase.request, fixture.priorContext);
		if (promptSignals === undefined) {
			available = false;
			return sampleResult(
				testCase,
				repeat,
				started,
				observed,
				fixture.host.model?.id,
				available,
				false,
				"prompt classification unavailable",
			);
		}
		const promptDecision = await fixture.controller.routeUserPrompt(promptSignals);
		if (promptDecision === undefined) {
			return sampleResult(
				testCase,
				repeat,
				started,
				observed,
				fixture.host.model?.id,
				true,
				false,
				"prompt route unavailable",
			);
		}
		if (testCase.transcript === undefined) {
			observed.difficulty = promptSignals.difficulty;
			observed.effort = fixture.host.configuredThinkingLevel();
			observed.difficultyConfidence = promptSignals.difficultyConfidence;
			const model = fixture.host.model?.id;
			return sampleResult(testCase, repeat, started, observed, model, available, false);
		}
		let latest: TurnSignals | undefined;
		for (let judgment = 0; judgment < 2; judgment++) {
			const signals = await fixture.service.classifyTurn(fixture.transcriptContext ?? "", {
				wip: true,
				duoPhase: testCase.phase,
			});
			if (signals === undefined) {
				available = false;
				return sampleResult(
					testCase,
					repeat,
					started,
					observed,
					fixture.host.model?.id,
					available,
					abstainedForConfidence,
					"turn classification unavailable",
				);
			}
			latest = signals;
			if (
				signals.routing === undefined ||
				signals.routing.difficultyConfidence < ROUTING_MIN_CONFIDENCE ||
				signals.phaseConfidence < ROUTING_MIN_CONFIDENCE
			) {
				abstainedForConfidence = true;
			}
			fixture.controller.notifyTurnSignals(signals);
			await fixture.controller.notifyTurnEnd();
			await fixture.controller.flushPendingSwitch();
		}
		const routing = latest?.routing;
		if (routing === undefined) {
			return sampleResult(
				testCase,
				repeat,
				started,
				observed,
				fixture.host.model?.id,
				true,
				abstainedForConfidence,
				"turn routing judgment missing",
			);
		}
		observed.difficulty = routing.difficulty;
		observed.effort = fixture.host.configuredThinkingLevel();
		observed.difficultyConfidence = routing.difficultyConfidence;
		observed.phaseConfidence = latest?.phaseConfidence;
		return sampleResult(
			testCase,
			repeat,
			started,
			observed,
			fixture.host.model?.id,
			available,
			abstainedForConfidence,
		);
	} catch (error) {
		return sampleResult(
			testCase,
			repeat,
			started,
			observed,
			fixture.host.model?.id,
			available,
			abstainedForConfidence,
			error instanceof Error ? error.message : "evaluation failed",
		);
	} finally {
		fixture.controller.dispose();
	}
}

function metric(samples: SampleResult[]): AccuracyMetrics {
	const samplesCount = samples.length;
	const available = samples.filter(sample => sample.available).length;
	const unavailable = samplesCount - available;
	const exact = samples.filter(sample => sample.exactAllowed).length;
	const modelOnly = samples.filter(sample => sample.available && sample.modelAllowed).length;
	const difficultyOnly = samples.filter(sample => sample.difficultyAllowed).length;
	const effortOnly = samples.filter(sample => sample.effortAllowed).length;
	const covered = samples.filter(sample => sample.covered).length;
	return {
		samples: samplesCount,
		available,
		unavailable,
		exactAllowedLabel: exact,
		modelOnly,
		difficultyOnly,
		effortOnly,
		accuracy: samplesCount === 0 ? 0 : exact / samplesCount,
		modelAccuracy: samplesCount === 0 ? 0 : modelOnly / samplesCount,
		coverage: samplesCount === 0 ? 0 : covered / samplesCount,
		covered,
		abstentions: samples.filter(sample => sample.abstainedForConfidence).length,
		criticalModelViolations: samples.filter(sample => sample.criticalModelViolation).length,
	};
}

function addConfusionCell(matrix: Record<string, Record<string, number>>, expected: string, observed: string): void {
	const row = matrix[expected] ?? {};
	row[observed] = (row[observed] ?? 0) + 1;
	matrix[expected] = row;
}

function endpointMetadata(): { hostname: string; model: string } {
	const baseUrl = Bun.env.TYPESAFE_SYSTEMONE_URL ?? TYPESAFE_SYSTEMONE_URL;
	let hostname = "invalid";
	try {
		hostname = new URL(baseUrl).hostname || "invalid";
	} catch {
		// Keep report safe and let the bounded client classify the endpoint as unavailable.
	}
	return { hostname, model: "jev-latest" };
}

function printReport(report: EvaluationReport): void {
	console.log(`Endpoint: ${report.endpoint.hostname} (${report.endpoint.model})`);
	for (const sample of report.samples) {
		const observed = sample.observed;
		console.log(
			`${sample.status} ${sample.id} difficulty=${observed.difficulty ?? "-"}/${sample.expected.difficulty.join("|")} effort=${observed.effort ?? "-"}/${sample.expected.thinking.join("|")} model=${observed.model ?? "-"}/${sample.expected.models.join("|")} confidence=${observed.confidence.difficulty?.toFixed(2) ?? "-"}${observed.confidence.phase === undefined ? "" : `/${observed.confidence.phase.toFixed(2)}`} latency=${sample.latencyMs}ms${sample.error === undefined ? "" : ` error=${sample.error}`}`,
		);
	}
	const formatMetrics = (metrics: AccuracyMetrics): string =>
		`samples=${metrics.samples} exact=${metrics.exactAllowedLabel}/${metrics.samples} accuracy=${metrics.accuracy.toFixed(3)} model=${metrics.modelAccuracy.toFixed(3)} coverage=${metrics.coverage.toFixed(3)} abstentions=${metrics.abstentions} unavailable=${metrics.unavailable}`;
	console.log(`Summary: ${formatMetrics(report.metrics)}`);
	console.log(`Calibration: ${formatMetrics(report.splits.calibration)}`);
	console.log(`Holdout: ${formatMetrics(report.splits.holdout)}`);
	console.log(`Confusion difficulty: ${JSON.stringify(report.confusion.difficulty)}`);
	console.log(`Confusion model: ${JSON.stringify(report.confusion.model)}`);
	if (report.failure.endpointUnavailable) console.log("Failure: endpoint unavailable");
	if (report.failure.criticalModelViolation) console.log("Failure: critical model violation");
	if (report.failure.belowMinAccuracy) console.log(`Failure: accuracy below ${report.options.minAccuracy}`);
}

async function loadDataset(path: string): Promise<Dataset> {
	try {
		return validateDataset(await Bun.file(path).json());
	} catch (error) {
		if (error instanceof Error && error.message.includes(": ")) throw error;
		throw new Error(`cannot read cases file ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
	}
}

async function run(options: CliOptions, dataset: Dataset): Promise<EvaluationReport> {
	const selectedCases = options.limit === undefined ? dataset.cases : dataset.cases.slice(0, options.limit);
	const samples: SampleResult[] = [];
	for (const testCase of selectedCases) {
		for (let repeat = 1; repeat <= options.repeats; repeat++) {
			samples.push(await evaluateCase(testCase, repeat));
		}
	}
	const splits: Record<DatasetSplit, AccuracyMetrics> = {
		calibration: metric(samples.filter(sample => sample.split === "calibration")),
		holdout: metric(samples.filter(sample => sample.split === "holdout")),
	};
	const difficultyConfusion: Record<string, Record<string, number>> = {};
	const modelConfusion: Record<string, Record<string, number>> = {};
	for (const sample of samples) {
		addConfusionCell(
			difficultyConfusion,
			sample.expected.difficulty.join("|"),
			sample.observed.difficulty ?? "unavailable",
		);
		addConfusionCell(
			modelConfusion,
			sample.expected.models.join("|"),
			sample.available ? (sample.observed.model ?? "unavailable") : "unavailable",
		);
	}
	const metrics = metric(samples);
	const criticalModelViolation = metrics.criticalModelViolations > 0;
	const endpointUnavailable = metrics.unavailable > 0;
	return {
		endpoint: endpointMetadata(),
		options: {
			repeats: options.repeats,
			...(options.limit === undefined ? {} : { limit: options.limit }),
			minAccuracy: options.minAccuracy,
		},
		counts: {
			cases: selectedCases.length,
			samples: samples.length,
			failures: samples.filter(sample => sample.status === "FAIL").length,
			unavailable: metrics.unavailable,
		},
		samples,
		metrics,
		splits,
		confusion: { difficulty: difficultyConfusion, model: modelConfusion },
		failure: {
			endpointUnavailable,
			criticalModelViolation,
			belowMinAccuracy: metrics.accuracy < options.minAccuracy,
		},
	};
}

async function main(): Promise<void> {
	let options: CliOptions;
	try {
		options = parseOptions(process.argv.slice(2));
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : "invalid options"}`);
		console.error(usage());
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		console.log(usage());
		return;
	}
	let dataset: Dataset;
	try {
		dataset = await loadDataset(options.casesPath);
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : "invalid dataset"}`);
		process.exitCode = 2;
		return;
	}
	const report = await run(options, dataset);
	printReport(report);
	if (options.jsonPath !== undefined) {
		await Bun.write(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
	}
	if (report.failure.endpointUnavailable || report.failure.criticalModelViolation || report.failure.belowMinAccuracy) {
		process.exitCode = 1;
	}
}

if (import.meta.main) void main();
