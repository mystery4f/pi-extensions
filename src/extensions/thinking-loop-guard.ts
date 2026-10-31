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
 *     "action": "abort",               // "abort" (default) | "warn"
 *     "windowTokens": 500,
 *     "minPeriod": 4,
 *     "threshold": 20,
 *     "distinctMin": 3
 *   }
 * Env: THINKING_LOOP_GUARD_ENABLED, THINKING_LOOP_GUARD_PROVIDERS (comma),
 *      THINKING_LOOP_GUARD_MODELS (comma), THINKING_LOOP_GUARD_ACTION,
 *      THINKING_LOOP_GUARD_WINDOW, THINKING_LOOP_GUARD_MIN_PERIOD,
 *      THINKING_LOOP_GUARD_THRESHOLD, THINKING_LOOP_GUARD_DISTINCT_MIN
 */

import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Config ─────────────────────────────────────────────────────

interface GuardConfig {
	enabled: boolean;
	providers: string[];
	models: string[];
	action: "abort" | "warn";
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
	if (block?.action === "abort" || block?.action === "warn") cfg.action = block.action;
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
	if (process.env.THINKING_LOOP_GUARD_ACTION === "abort" || process.env.THINKING_LOOP_GUARD_ACTION === "warn")
		cfg.action = process.env.THINKING_LOOP_GUARD_ACTION;
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

// ── Extension ──────────────────────────────────────────────────

export default function thinkingLoopGuard(pi: ExtensionAPI) {
	let cfg = loadConfig(process.cwd());

	pi.on("session_start", () => {
		cfg = loadConfig(process.cwd());
	});

	// One detector per content stream (thinking / text), keyed by contentIndex.
	const detectors = new Map<string, LoopDetector>();
	let fired = false; // one abort per assistant message

	const getDetector = (key: string): LoopDetector => {
		let d = detectors.get(key);
		if (!d) {
			d = new LoopDetector(cfg);
			detectors.set(key, d);
		}
		return d;
	};

	pi.on("message_update", (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;

		const ev = event.assistantMessageEvent;
		if (ev.type === "start") {
			detectors.clear();
			fired = false;
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
		const msg2 = `thinking-loop-guard: ${phase} loop detected (${msg.provider}/${msg.model}, period=${period}, "${preview}") — ${cfg.action === "abort" ? "aborting run" : "warning only"}`;
		ctx.ui.notify(msg2, "warning");
		if (cfg.action === "abort") ctx.abort();
	});
}
