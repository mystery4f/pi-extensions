/**
 * Thinking Loop Guard — detect repetitive loops in thinking/text streams and abort.
 *
 * MiMo (and some other models) can get stuck in reasoning loops during long
 * thinking: they repeat a block of tokens over and over until max_tokens or
 * timeout. This extension watches the streaming deltas of both the thinking
 * and the text content and, when a repetition loop is detected, notifies the
 * user and (by default) aborts the run.
 *
 * Detection algorithm: consecutive-period repetition (as used by MiMo Code):
 * keep a sliding window of tokens; for each period p in
 * [minPeriod, window/threshold], if the last p*(threshold-1) tokens satisfy
 * tok[i] == tok[i+p] and the repeating block has >= distinctMin distinct
 * tokens, a loop is declared.
 *
 * Config (~/.pi/agent/settings.json, project .pi/settings.json overrides;
 * env vars override settings):
 *   "thinkingLoopGuard": {
 *     "enabled": true,                 // master switch, default false
 *     "providers": ["xiaomi"],         // provider glob list, hit = on
 *     "models": ["*mimo*"],            // model id glob list, hit = on
 *     "action": "abort",               // "abort" (default) | "warn" | "retry"
 *     "maxRetries": 2,                 // retry escalation budget (action=retry)
 *     "toolRepeatCount": 3,            // same-args tool-call doom-loop threshold
 *     "windowTokens": 500,
 *     "minPeriod": 4,
 *     "threshold": 20,
 *     "distinctMin": 3
 *   }
 * Env: THINKING_LOOP_GUARD_ENABLED, THINKING_LOOP_GUARD_PROVIDERS (comma),
 *      THINKING_LOOP_GUARD_MODELS (comma), THINKING_LOOP_GUARD_ACTION,
 *      THINKING_LOOP_GUARD_MAX_RETRIES, THINKING_LOOP_GUARD_TOOL_REPEAT_COUNT,
 *      THINKING_LOOP_GUARD_WINDOW, THINKING_LOOP_GUARD_MIN_PERIOD,
 *      THINKING_LOOP_GUARD_THRESHOLD, THINKING_LOOP_GUARD_DISTINCT_MIN
 *
 * action: "retry" aborts the run then re-prompts the model with an escalating
 * reminder (attempt 1: suggest a different approach; attempt 2: demand a full
 * replan). The counter resets when a real user message arrives. After
 * maxRetries the run aborts without re-prompting. Each re-prompt text starts
 * with a synthetic-user prefix so the retry handler never loops on itself.
 */

import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Config ─────────────────────────────────────────────────────

interface GuardConfig {
	enabled: boolean;
	providers: string[];
	models: string[];
	action: "abort" | "warn" | "retry";
	maxRetries: number;
	toolRepeatCount: number;
	windowTokens: number;
	minPeriod: number;
	threshold: number;
	distinctMin: number;
}

const DEFAULT_CONFIG: GuardConfig = {
	enabled: false,
	providers: [],
	models: [],
	action: "abort",
	maxRetries: 2,
	toolRepeatCount: 3,
	windowTokens: 500,
	minPeriod: 4,
	threshold: 20,
	distinctMin: 3,
};

const AGENT_DIR = path.join(
	process.env.USERPROFILE || process.env.HOME || "~",
	".pi/agent",
);

function readSettingsBlock(settingsPath: string): Record<string, unknown> | undefined {
	try {
		if (!fs.existsSync(settingsPath)) return undefined;
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		return settings.thinkingLoopGuard as Record<string, unknown> | undefined;
	} catch {
		return undefined;
	}
}

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function strList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.filter((v): v is string => typeof v === "string" && v.length > 0);
	return out.length > 0 ? out : undefined;
}

function loadConfig(cwd: string): GuardConfig {
	// Layered: global settings → project settings (wins) → env (wins over both)
	const globalBlock = readSettingsBlock(path.join(AGENT_DIR, "settings.json"));
	const projectBlock = readSettingsBlock(path.join(cwd, ".pi", "settings.json"));
	const block = { ...globalBlock, ...projectBlock };

	const cfg: GuardConfig = { ...DEFAULT_CONFIG };
	if (typeof block?.enabled === "boolean") cfg.enabled = block.enabled;
	cfg.providers = strList(block?.providers) ?? DEFAULT_CONFIG.providers;
	cfg.models = strList(block?.models) ?? DEFAULT_CONFIG.models;
	if (block?.action === "abort" || block?.action === "warn" || block?.action === "retry")
		cfg.action = block.action;
	cfg.maxRetries = num(block?.maxRetries, DEFAULT_CONFIG.maxRetries);
	cfg.toolRepeatCount = num(block?.toolRepeatCount, DEFAULT_CONFIG.toolRepeatCount);
	cfg.windowTokens = num(block?.windowTokens, DEFAULT_CONFIG.windowTokens);
	cfg.minPeriod = num(block?.minPeriod, DEFAULT_CONFIG.minPeriod);
	cfg.threshold = num(block?.threshold, DEFAULT_CONFIG.threshold);
	cfg.distinctMin = num(block?.distinctMin, DEFAULT_CONFIG.distinctMin);

	// Env overrides
	if (process.env.THINKING_LOOP_GUARD_ENABLED !== undefined)
		cfg.enabled = /^(1|true|yes|on)$/i.test(process.env.THINKING_LOOP_GUARD_ENABLED);
	const envProviders = process.env.THINKING_LOOP_GUARD_PROVIDERS?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (envProviders?.length) cfg.providers = envProviders;
	const envModels = process.env.THINKING_LOOP_GUARD_MODELS?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (envModels?.length) cfg.models = envModels;
	if (process.env.THINKING_LOOP_GUARD_ACTION === "abort" || process.env.THINKING_LOOP_GUARD_ACTION === "warn" || process.env.THINKING_LOOP_GUARD_ACTION === "retry")
		cfg.action = process.env.THINKING_LOOP_GUARD_ACTION;
	cfg.maxRetries = num(process.env.THINKING_LOOP_GUARD_MAX_RETRIES, cfg.maxRetries);
	cfg.toolRepeatCount = num(process.env.THINKING_LOOP_GUARD_TOOL_REPEAT_COUNT, cfg.toolRepeatCount);
	cfg.windowTokens = num(process.env.THINKING_LOOP_GUARD_WINDOW, cfg.windowTokens);
	cfg.minPeriod = num(process.env.THINKING_LOOP_GUARD_MIN_PERIOD, cfg.minPeriod);
	cfg.threshold = num(process.env.THINKING_LOOP_GUARD_THRESHOLD, cfg.threshold);
	cfg.distinctMin = num(process.env.THINKING_LOOP_GUARD_DISTINCT_MIN, cfg.distinctMin);

	return cfg;
}

// ── Glob matching ──────────────────────────────────────────────

function globMatch(pattern: string, value: string): boolean {
	const rx = new RegExp(
		"^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
	);
	return rx.test(value);
}

/** Config gate: enabled AND (provider hit OR model hit). Empty lists never match. */
function shouldGuard(cfg: GuardConfig, provider: string, model: string): boolean {
	if (!cfg.enabled) return false;
	if (cfg.providers.some((p) => globMatch(p, provider))) return true;
	if (cfg.models.some((m) => globMatch(m, model))) return true;
	return false;
}

// ── Tokenizer: words for latin, per-char for CJK ──────────────

const TOKEN_RE = /[㐀-䶿一-鿿぀-ヿ]|[^\s㐀-䶿一-鿿぀-ヿ]+/g;

// ── Detector: consecutive-period repetition ───────────────────

class LoopDetector {
	private tokens: string[] = [];

	constructor(private cfg: GuardConfig) {}

	reset(): void {
		this.tokens = [];
	}

	/** Append streamed text; returns the loop period when detected, else undefined. */
	feed(chunk: string): number | undefined {
		const found = chunk.match(TOKEN_RE);
		if (!found) return undefined;
		this.tokens.push(...found);
		const max = this.cfg.windowTokens;
		if (this.tokens.length > max) this.tokens.splice(0, this.tokens.length - max);

		const { minPeriod, threshold, distinctMin } = this.cfg;
		const maxPeriod = Math.floor(max / threshold);
		if (maxPeriod < minPeriod) return undefined;

		for (let p = minPeriod; p <= maxPeriod; p++) {
			// Walk backwards while tok[i] == tok[i+p]; need run >= p*(threshold-1)
			// (i.e. the block appears >= threshold times back-to-back).
			const need = p * (threshold - 1);
			const n = this.tokens.length;
			if (n < need + p) continue;
			let run = 0;
			for (let i = n - p - 1; i >= 0 && run < need; i--) {
				if (this.tokens[i] !== this.tokens[i + p]) break;
				run++;
			}
			if (run < need) continue;
			// Reject degenerate blocks (e.g. all-newline padding): the repeated
			// block itself must have enough distinct tokens.
			const block = this.tokens.slice(n - p);
			if (new Set(block).size < distinctMin) continue;
			return p;
		}
		return undefined;
	}

	/** Short excerpt of the repeating block for the warning message. */
	preview(): string {
		const block = this.tokens.slice(-Math.min(this.cfg.minPeriod * 4, this.tokens.length));
		const text = block.join(" ").replace(/\s+/g, " ").trim();
		return text.length > 80 ? text.slice(0, 80) + "…" : text;
	}
}
// ── Tool-call signature: name + key-sorted args JSON ──────────

/** Stable JSON: object keys sorted, so arg order does not matter. */
function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? String(v);
	if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return "{" + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",") + "}";
}

function toolSig(name: string, args: unknown): string {
	return `${name}(${stableStringify(args)})`;
}

// ── Extension ──────────────────────────────────────────────────

export default function thinkingLoopGuard(pi: ExtensionAPI) {
	let cfg = loadConfig(process.cwd());

	pi.on("session_start", () => {
		cfg = loadConfig(process.cwd());
	});

	// One detector per content stream (thinking / text), keyed by contentIndex.
	const detectors = new Map<string, LoopDetector>();
	let fired = false; // one abort per assistant message
	// Retry escalation state. Reset only on a real user message.
	let retries = 0;
	// Deferred retry reminder: delivered only after the aborted run fully
	// settles, so it starts a fresh turn instead of dying in the followUp queue.
	let pendingReminder: string | undefined;
	// Doom-loop state: identical same-args tool calls within one assistant message.
	let lastToolSig = "";
	let toolRepeat = 0;

	const getDetector = (key: string): LoopDetector => {
		let d = detectors.get(key);
		if (!d) {
			d = new LoopDetector(cfg);
			detectors.set(key, d);
		}
		return d;
	};

	// Escalating action for one loop event. detail describes what was detected.
	const intervene = (ctx: import("@earendil-works/pi-coding-agent").ExtensionContext, detail: string) => {
		if (cfg.action === "warn") {
			ctx.ui.notify(`thinking-loop-guard: ${detail} (warning only)`, "warning");
			return;
		}
		if (cfg.action === "abort") {
			ctx.ui.notify(`thinking-loop-guard: ${detail} — aborting run`, "warning");
			ctx.abort();
			return;
		}
		// action === "retry": abort, then re-prompt with escalating reminder.
		if (retries >= cfg.maxRetries) {
			ctx.ui.notify(
				`thinking-loop-guard: ${detail} — retry budget exhausted (${retries}/${cfg.maxRetries}), aborting run`,
				"warning",
			);
			ctx.abort();
			return;
		}
		retries += 1;
		const reminder =
			retries === 1
				? `Your last response was cut off by the loop guard: you repeated the same block ${detail}. Stop that line of thinking. Take a different approach, use a different tool, or state plainly what you are stuck on.`
				: `Your last response hit the loop guard again (${detail}). You MUST completely replan before continuing. Do not reuse the earlier wording or reasoning. If the task is impossible right now, say so and stop.`;
		ctx.ui.notify(
			`thinking-loop-guard: ${detail} — aborting and re-prompting (attempt ${retries}/${cfg.maxRetries})`,
			"warning",
		);
		ctx.abort();
		// Deliver the reminder only after the run settles: a followUp queued on
		// the run we just killed is orphaned (abort never drains the queue).
		pendingReminder = reminder;
		// Backstop: if agent_settled never fires, deliver after 8s anyway.
		setTimeout(() => {
			if (pendingReminder === reminder) {
				pendingReminder = undefined;
				pi.sendUserMessage(`[thinking-loop-guard] ${reminder}`);
			}
		}, 8000);
	};

	// Reset escalation when a real user speaks. Skip our own synthetic re-prompts.
	pi.on("message_start", (event) => {
		const msg = event.message;
		if (msg.role !== "user") return;
		const text = typeof msg.content === "string" ? msg.content : "";
		if (text.startsWith("[thinking-loop-guard]")) return;
		retries = 0;
		pendingReminder = undefined; // user took over; don't fire a stale reminder
	});

	// The run is fully settled (aborted or finished) and the session is idle:
	// sendUserMessage without deliverAs now starts a fresh turn (prompt() →
	// _startRun), instead of queueing on a dead run.
	pi.on("agent_settled", () => {
		const text = pendingReminder;
		if (text === undefined) return;
		pendingReminder = undefined;
		pi.sendUserMessage(`[thinking-loop-guard] ${text}`);
	});

	pi.on("message_update", (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;

		const ev = event.assistantMessageEvent;
		if (ev.type === "start") {
			detectors.clear();
			fired = false;
			lastToolSig = "";
			toolRepeat = 0;
			return;
		}

		let key: string | undefined;
		let delta: string | undefined;
		let phase: "thinking" | "text" | undefined;
		switch (ev.type) {
			case "thinking_start":
				getDetector(`t:${ev.contentIndex}`);
				break;
			case "thinking_delta":
				key = `t:${ev.contentIndex}`;
				delta = ev.delta;
				phase = "thinking";
				break;
			case "thinking_end":
				detectors.delete(`t:${ev.contentIndex}`);
				break;
			case "text_start":
				getDetector(`x:${ev.contentIndex}`);
				break;
			case "text_delta":
				key = `x:${ev.contentIndex}`;
				delta = ev.delta;
				phase = "text";
				break;
			case "text_end":
				detectors.delete(`x:${ev.contentIndex}`);
				break;
			case "toolcall_end": {
				if (fired || !shouldGuard(cfg, msg.provider, msg.model)) return;
				const sig = toolSig(ev.toolCall.name, ev.toolCall.arguments);
				if (sig === lastToolSig) {
					toolRepeat += 1;
				} else {
					lastToolSig = sig;
					toolRepeat = 1;
				}
				if (toolRepeat >= cfg.toolRepeatCount) {
					fired = true;
					intervene(
						ctx,
						`doom loop: tool "${ev.toolCall.name}" called ${toolRepeat}× with identical arguments`,
					);
				}
				return;
			}
			default:
				return;
		}

		if (!key || !delta || fired) return;
		if (!shouldGuard(cfg, msg.provider, msg.model)) return;

		const period = getDetector(key).feed(delta);
		if (period === undefined) return;

		fired = true;
		const detector = getDetector(key);
		const preview = detector.preview();
		intervene(ctx, `repetitive ${phase} loop (period=${period}, "${preview}")`);
	});
}
