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

// ── Zhipu retryable error hook ───────────────────────────────
// Extend auto-router's isRetryableError via global hook.
// Returns boolean for a decision, undefined to delegate to auto-router's built-in.

(function registerRetryableErrorHook() {
	const EXTRA_PATTERNS = [
		"rate_limit_error",  // zhipu error type (underscore, not in built-in "rate limit")
		"\u5df2\u8fbe\u5230",           // "已达到"  (reached, for usage/rate limit)
		"\u4f7f\u7528\u4e0a\u9650",     // "使用上限" (usage limit)
		"\u9650\u989d\u5c06\u5728",     // "限额将在" (quota will [reset at])
	];

	(globalThis as any).__piAutoRouter_isRetryableError = (message: any): boolean | undefined => {
		const text = String(message ?? "");
		if (!text) return undefined;
		if (EXTRA_PATTERNS.some((p) => text.includes(p))) return true;
		return undefined; // delegate to auto-router built-in
	};
})();
