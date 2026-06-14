/**
 * Router Bridge Extension
 *
 * Bridges pi-auto-router and pi-bar: exposes the actual underlying model's
 * context window and token usage so the status bar can show accurate numbers.
 *
 * Problem:
 *   When using pi-auto-router, the model seen by the framework is a virtual
 *   model (e.g. "auto-router/subscription-reasoning") whose contextWindow is
 *   taken from the route's first target — not necessarily the actual model
 *   being routed to. This makes pi-bar's meter segment (e.g. "13% of 200k")
 *   display incorrect values.
 *
 * Solution:
 *   1. Listen to pi events to track which underlying model was actually routed.
 *   2. Resolve the real contextWindow from the model registry.
 *   3. Fallback to route's first target when no routing decision yet.
 *   4. Expose `globalThis.__piRouterBridge` with simple accessor methods.
 *
 * Usage in pi-bar config.toml:
 *   ```toml
 *   [[statusbar.segments]]
 *   type = "meter"
 *   value_eval = "globalThis.__piRouterBridge?.getActualPercent() ?? ctx.getContextUsage()?.percent ?? 0"
 *   eval = """
 *     (() => {
 *       const b = globalThis.__piRouterBridge;
 *       const pct = Math.round(value);
 *       const cw = b?.getContextWindowLabel() ?? (ctx.model?.contextWindow ? humanReadable(ctx.model.contextWindow) : '');
 *       return `${pct}% of ${cw}`;
 *     })()
 *   """
 *   ```
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Logging (debug only) ──────────────────────────────────────

const DEBUG_ENABLED = !!process.env.ROUTER_BRIDGE_DEBUG;
const LOG_FILE = path.join(os.homedir(), ".pi", "agent", "extensions", "router-bridge.debug.log");

function log(...args: any[]) {
	if (!DEBUG_ENABLED) return;
	try {
		fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.join(" ")}\n`);
	} catch { /* best-effort */ }
}

// ── Types ──────────────────────────────────────────────────────

interface RoutedModel {
	provider: string;
	modelId: string;
}

export interface RouterBridgeAPI {
	/** Get the currently routed underlying model info */
	getRoutedModel(): RoutedModel | undefined;

	/** Get the actual context window (in tokens) of the routed model */
	getActualContextWindow(): number | undefined;

	/** Get the actual usage percent based on real context window */
	getActualPercent(): number | undefined;

	/** Get a human-readable context window label (e.g. "128k", "1M") */
	getContextWindowLabel(): string | undefined;

	/**
	 * Get the per-target hang-guard timeout (ms) for tryTarget.
	 * Return 0 to disable (default). Set >0 for providers known to silently
	 * hang on overload (e.g. opencode).
	 */
	getTargetTimeoutMs(provider: string): number;
}

// ── Route config helpers ──────────────────────────────────────

const ROUTES_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "auto-router.routes.json");

function loadFirstTargets(): Map<string, { provider: string; modelId: string }> {
	const map = new Map<string, { provider: string; modelId: string }>();
	try {
		const content = JSON.parse(fs.readFileSync(ROUTES_CONFIG_PATH, "utf-8"));
		const routes: Record<string, any> = content.routes;
		if (!routes || typeof routes !== "object") return map;
		for (const [routeId, def] of Object.entries(routes)) {
			const targets: any[] = def?.targets;
			if (!Array.isArray(targets) || targets.length === 0) continue;
			const first = targets[0];
			if (first?.provider && first?.modelId) {
				map.set(routeId, { provider: first.provider, modelId: first.modelId });
			}
		}
	} catch { /* routes file missing or unparseable */ }
	return map;
}

// ── Extension ──────────────────────────────────────────────────

export default function routerBridgeExtension(pi: ExtensionAPI) {
	log("extension loaded");

	let currentRouteId: string | undefined;
	let latestCtx: ExtensionContext | undefined;
	let firstTargets = new Map<string, { provider: string; modelId: string }>();
	let targetsLoaded = false;

	// ── Helpers ──────────────────────────────────────────────

	/** Find a model's contextWindow in the modelRegistry by provider + id. */
	function findCtxInRegistry(provider: string, modelId: string): number | undefined {
		if (!latestCtx?.modelRegistry?.getAvailable) return undefined;
		try {
			const available = latestCtx.modelRegistry.getAvailable() as Array<{ provider: string; id: string; contextWindow?: number }>;
			const found = available.find(m => m.provider === provider && m.id === modelId);
			return found?.contextWindow;
		} catch {
			return undefined;
		}
	}

	/** Read the last routing decision from auto-router (via globalThis hook). */
	function getRoutedModel(): RoutedModel | undefined {
		if (!currentRouteId) return undefined;
		try {
			return (globalThis as any).__piCacheOptimizerRouter?.getRoutedModel?.(currentRouteId) as RoutedModel | undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Resolve the effective contextWindow with 3-level fallback:
	 *
	 * 1. Routing decision exists → use the routed model's contextWindow
	 * 2. No routing decision, but route's first target known → resolve its contextWindow
	 * 3. Everything else → use the current (virtual) model's contextWindow
	 */
	function resolveCtxWindow(): number | undefined {
		// Level 1: routed model (after auto-router made a decision)
		if (currentRouteId) {
			const routed = getRoutedModel();
			if (routed) {
				const cw = findCtxInRegistry(routed.provider, routed.modelId);
				if (cw) return cw;
				log(`resolveCtxWindow: routed model ${routed.provider}/${routed.modelId} not found in registry`);
			}

			// Level 2: first target of the route (no decision yet, show the default)
			const first = firstTargets.get(currentRouteId);
			if (first) {
				const cw = findCtxInRegistry(first.provider, first.modelId);
				if (cw) return cw;
				log(`resolveCtxWindow: first target ${first.provider}/${first.modelId} not found in registry`);
			}
		}

		// Level 3: current (virtual) model's own contextWindow
		return latestCtx?.model?.contextWindow;
	}

	// ── Bridge API ───────────────────────────────────────────

	const bridge: RouterBridgeAPI = {
		getRoutedModel(): RoutedModel | undefined {
			return getRoutedModel();
		},

		getActualContextWindow(): number | undefined {
			return resolveCtxWindow();
		},

		getActualPercent(): number | undefined {
			const ctxWin = resolveCtxWindow();
			if (!ctxWin || !latestCtx) return undefined;

			const usage = latestCtx.getContextUsage?.();
			if (!usage) return undefined;

			log(`getActualPercent: ctxWin=${ctxWin}, tokens=${usage.tokens}, usage.cw=${usage.contextWindow}, usage.percent=${usage.percent}`);

			// Path A: exact token count (most accurate)
			if (typeof usage.tokens === "number" && usage.tokens > 0) {
				const pct = Math.min(100, Math.round((usage.tokens / ctxWin) * 100));
				log(`getActualPercent: tokens path => ${pct}%`);
				return pct;
			}

			// Path B: derive from percent × contextWindow
			if (usage.contextWindow && usage.percent != null) {
				const derived = (usage.percent / 100) * usage.contextWindow;
				const pct = Math.min(100, Math.round((derived / ctxWin) * 100));
				log(`getActualPercent: fallback path => ${pct}%`);
				return pct;
			}

			return undefined;
		},

		getContextWindowLabel(): string | undefined {
			const ctxWin = resolveCtxWindow();
			const label = ctxWin ? humanReadable(ctxWin) : undefined;
			log(`getContextWindowLabel() => ${label}`);
			return label;
		},

		// Per-provider hang-guard timeout. Default 0 (disabled).
		// When >0, tryTarget will abort the stream after this many ms
		// of silence and fall through to the next target.
		getTargetTimeoutMs(provider: string): number {
			// opencode providers are known to silently hang on 429/overload.
			// 15s is enough to get a normal response; if nothing arrives by
			// then, treat it as retryable and move on.
			if (provider === "opencode-go-1" || provider === "opencode-go-2") {
				return 15_000;
			}
			return 0;
		},
	};

	(globalThis as any).__piRouterBridge = bridge;

	// ── Event listeners ──────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		currentRouteId = ctx.model?.provider === "auto-router" ? ctx.model.id : undefined;
		firstTargets = loadFirstTargets();
		targetsLoaded = true;
		log(`session_start: model=${ctx.model?.provider}/${ctx.model?.id}, routeId=${currentRouteId}, routes=${firstTargets.size}`);
	});

	pi.on("model_select", async (event, ctx) => {
		latestCtx = ctx;
		currentRouteId = event.model?.provider === "auto-router" ? event.model.id : undefined;
		if (!targetsLoaded) {
			firstTargets = loadFirstTargets();
			targetsLoaded = true;
		}

		const usage = ctx.getContextUsage?.();
		const first = currentRouteId ? firstTargets.get(currentRouteId) : undefined;
		log(
			`model_select: model=${event.model?.provider}/${event.model?.id}, ` +
			`prev=${event.previousModel?.provider}/${event.previousModel?.id}, ` +
			`source=${event.source}, ` +
			`routeId=${currentRouteId}, ` +
			`firstTarget=${first?.provider}/${first?.modelId}, ` +
			`ctx.cw=${ctx.model?.contextWindow}, ` +
			`usage.tokens=${usage?.tokens}, usage.pct=${usage?.percent}`
		);
	});
}

// ── Standalone helpers ────────────────────────────────────────

function humanReadable(n: number): string {
	if (n >= 1_000_000)
		return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

// ── Retryable error hook (multi-provider) ──────────────────
// Extend auto-router's isRetryableError via global hook.
// Returns boolean for a decision, undefined to delegate to auto-router's built-in.
//
// When a provider returns HTTP 429 (or equivalent rate-limit), this hook
// must return true so the auto-router will fall through to the next target
// instead of treating the error as terminal.

(function registerRetryableErrorHook() {
	// Tier 1: exact/specific patterns (likely error codes or API-specific messages)
	const SPECIFIC_PATTERNS = [
		"rate_limit_error",            // zhipu error type (underscore, not in built-in "rate limit")
		"rate_limit_exceeded",         // common API error code variant
		"request_rate_limit",          // another common variant
		"too_many_requests",           // snake_case variant
	];

	// Tier 2: Chinese patterns for rate-limiting, quota, and capacity errors
	// These patterns cover providers (zhipu, deepseek, moonshot, etc.) that
	// return Chinese-only error messages without "429" or "rate limit" in them.
	const CHINESE_PATTERNS = [
		// Rate / frequency limiting
		"\u9891\u7387\u8fc7\u9ad8",       // "频率过高" (frequency too high)
		"\u9891\u7387\u9650\u5236",       // "频率限制" (rate limit)
		"\u8d85\u51fa\u9891\u7387",       // "超出频率" (exceeded rate/frequency)
		"\u8bf7\u6c42\u9891\u7387",       // "请求频率" (request frequency)
		"\u9650\u6d41",                   // "限流" (rate limiting)
		"\u8bbf\u95ee\u9891\u7e41",       // "访问频繁" (access too frequent)
		"\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41", // "请求过于频繁" (too frequent requests)
		"\u8bf7\u6c42\u8fc7\u5feb",       // "请求过快" (request too fast)
		"\u8c03\u7528\u6b21\u6570\u5df2\u8fbe", // "调用次数已达" (call count reached)
		"\u5df2\u8fbe\u4e0a\u9650",       // "已达上限" (reached upper limit)

		// Quota / usage limits
		"\u5df2\u8fbe\u5230",             // "已达到" (reached)
		"\u4f7f\u7528\u4e0a\u9650",       // "使用上限" (usage limit)
		"\u9650\u989d\u5c06\u5728",       // "限额将在" (quota will [reset at])
		"\u8d85\u51fa\u9650\u5236",       // "超出限制" (exceeded limit)
		"\u914d\u989d\u4e0d\u8db3",       // "配额不足" (insufficient quota)
		"\u989d\u5ea6\u4e0d\u8db3",       // "额度不足" (insufficient balance/quota)
		"\u4f59\u989d\u4e0d\u8db3",       // "余额不足" (insufficient balance)

		// Retry / backoff hints (often accompanied by 429)
		"\u7a0d\u540e\u518d\u8bd5",       // "稍后再试" (try again later)
		"\u7a0d\u540e\u91cd\u8bd5",       // "稍后重试" (try again later, variant)
		"\u8bf7\u7a0d\u540e\u91cd\u8bd5", // "请稍后重试" (please try again later)
		"\u8bf7\u7a0d\u5019\u518d\u8bd5", // "请稍候再试" (please wait and try again)

		// HTTP status embedded in Chinese messages
		"\u8d85\u65f6",                   // "超时" (timeout)
		"\u670d\u52a1\u4e0d\u53ef\u7528", // "服务不可用" (service unavailable)
		"\u7f51\u5173\u9519\u8bef",       // "网关错误" (gateway error)
	];

	const ALL_PATTERNS = [...SPECIFIC_PATTERNS, ...CHINESE_PATTERNS];

	(globalThis as any).__piAutoRouter_isRetryableError = (message: any): boolean | undefined => {
		// Check for object with HTTP status (e.g. { status: 429 } or { statusCode: 429 })
		if (message && typeof message === "object") {
			const status = (message as any).status ?? (message as any).statusCode;
			if (status === 429 || status === 503 || status === 502 || status === 504) {
				return true;
			}
		}

		const text = String(message ?? "");
		if (!text) return undefined;

		// Fast-path: check if the auto-router built-in patterns would match anyway
		// This avoids redundant work for common cases like "429" or "rate limit".
		const lower = text.toLowerCase();
		if (
			lower.includes("429") ||
			lower.includes("rate limit") ||
			lower.includes("too many requests") ||
			lower.includes("throttled")
		) {
			return true; // short-circuit, no need to delegate
		}

		if (ALL_PATTERNS.some((p) => text.includes(p))) return true;
		return undefined; // delegate to auto-router built-in
	};
})();

// ── Per-target fast-fail hook ───────────────────────────────
// Called by tryTarget when an error event arrives, BEFORE the normal
// isRetryableError check. Receives (provider, rawError, target).
// Return "skip" to force immediate retryable failure → fallthrough.

(function registerFastFailHook() {
	(globalThis as any).__piAutoRouter_onTargetError = (
		provider: string,
		error: any,
		_target: any,
	): "skip" | undefined => {
		// Only for opencode providers: they return HTTP 429 as a structured
		// error object but the message text may not contain "429" literally.
		if (provider !== "opencode-go-1" && provider !== "opencode-go-2") {
			return undefined;
		}

		// Inspect the raw error object for status code.
		if (error && typeof error === "object") {
			const status = (error as any).status ?? (error as any).statusCode;
			if (status === 429) return "skip";
		}

		// Fallback: check string message for rate-limit indicators.
		const message = String(
			(error as any)?.errorMessage ??
			(error as any)?.message ??
			error ??
			""
		).toLowerCase();

		if (
			message.includes("429") ||
			message.includes("rate limit") ||
			message.includes("too many requests") ||
			message.includes("throttled") ||
			message.includes("overloaded") ||
			message.includes("capacity") ||
			message.includes("quota")
		) {
			return "skip";
		}

		return undefined;
	};
})();
