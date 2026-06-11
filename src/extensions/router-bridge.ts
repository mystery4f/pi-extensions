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
 *   3. Expose `globalThis.__piRouterBridge` with simple accessor methods.
 *   4. pi-bar's config.toml can use these in custom eval expressions.
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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Lazy reference to @earendil-works/pi-ai — resolved at runtime in the bun environment.
// We use dynamic require() (supported by bun) to avoid top-level import issues
// with peer dependencies that may not be installed during typecheck.
let _piAi: any = undefined;
function getPiAi(): any {
	if (!_piAi) {
		try { _piAi = require("@earendil-works/pi-ai"); } catch { _piAi = null; }
	}
	return _piAi;
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

// ── Helpers ────────────────────────────────────────────────────

function humanReadable(n: number): string {
	if (n >= 1_000_000)
		return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

/**
 * Resolve contextWindow from the model registry.
 * Searches both built-in providers (via getModel) and custom providers
 * (via ctx.modelRegistry).
 */
function resolveContextWindow(
	provider: string,
	modelId: string,
	modelRegistry?: any,
): number | undefined {
	// Method 1: pi-ai built-in providers
	try {
		const piAi = getPiAi();
		if (piAi?.getModel) {
			const model = piAi.getModel(provider, modelId) as { contextWindow?: number } | undefined;
			if (model?.contextWindow) return model.contextWindow;
		}
	} catch {
		// getModel may throw for unknown providers
	}

	// Method 2: modelRegistry from ExtensionContext
	if (
		modelRegistry &&
		typeof modelRegistry.getAvailable === "function"
	) {
		try {
			const available = modelRegistry.getAvailable() as Array<{
				provider: string;
				id: string;
				contextWindow?: number;
			}>;
			const found = available.find(
				(m) => m.provider === provider && m.id === modelId,
			);
			if (found?.contextWindow) return found.contextWindow;
		} catch {
			// ignore
		}
	}

	return undefined;
}

// ── Extension ──────────────────────────────────────────────────

function dbg(...args: any[]) {
	process.stderr.write(`[router-bridge] ${args.join(" ")}\n`);
}

let _callSeq = 0;

function seq(): number {
	return ++_callSeq;
}

export default function routerBridgeExtension(pi: ExtensionAPI) {
	dbg("extension loaded");

	let currentRouteId: string | undefined;
	let latestCtx: ExtensionContext | undefined;

	/** Read the latest routed model directly from auto-router (no cache) */
	function getLatestRoutedModel(): RoutedModel | undefined {
		if (!currentRouteId) {
			dbg(`#${seq()} getLatestRoutedModel: no currentRouteId`);
			return undefined;
		}
		try {
			const router = (globalThis as Record<string, unknown>)
				.__piCacheOptimizerRouter as {
				getRoutedModel?: (id: string) => RoutedModel | undefined;
			} | undefined;
			const result = router?.getRoutedModel?.(currentRouteId);
			dbg(`#${seq()} getLatestRoutedModel(routeId=${currentRouteId}) => ${JSON.stringify(result)}`);
			return result;
		} catch (e) {
			dbg(`#${seq()} getLatestRoutedModel error: ${e}`);
			return undefined;
		}
	}

	/** Resolve the context window for the currently routed model */
	function resolveActualContextWindow(): number | undefined {
		// If auto-router is active, try the routed model first
		if (currentRouteId) {
			const routed = getLatestRoutedModel();
			if (routed) {
				const cw = resolveContextWindow(
					routed.provider,
					routed.modelId,
					latestCtx?.modelRegistry,
				);
				if (cw) {
					dbg(`#${seq()} resolveActualContextWindow: routed cw=${cw} (${routed.provider}/${routed.modelId})`);
					return cw;
				}
				dbg(`#${seq()} resolveActualContextWindow: routed model found but no contextWindow (${routed.provider}/${routed.modelId})`);
			}
		}

		// Fallback: use the current model's own contextWindow
		const fallback = latestCtx?.model?.contextWindow;
		dbg(`#${seq()} resolveActualContextWindow: fallback cw=${fallback} (model=${latestCtx?.model?.provider}/${latestCtx?.model?.id})`);
		return fallback;
	}

	// ── Bridge API (exposed via globalThis) ────────────────────

	const bridge: RouterBridgeAPI = {
		getRoutedModel(): RoutedModel | undefined {
			return getLatestRoutedModel();
		},

		getActualContextWindow(): number | undefined {
			const cw = resolveActualContextWindow();
			dbg(`#${seq()} getActualContextWindow() => ${cw}`);
			return cw;
		},

		getActualPercent(): number | undefined {
			const s = seq();
			const actualCtxWin = resolveActualContextWindow();
			if (!actualCtxWin || !latestCtx) {
				dbg(`#${s} getActualPercent: no actualCtxWin or latestCtx`);
				return undefined;
			}

			const usage = latestCtx.getContextUsage?.();
			if (!usage) {
				dbg(`#${s} getActualPercent: no usage`);
				return undefined;
			}

			dbg(`#${s} getActualPercent: actualCtxWin=${actualCtxWin}, usage.tokens=${usage.tokens}, usage.contextWindow=${usage.contextWindow}, usage.percent=${usage.percent}`);

			// Prefer the raw token count for accuracy.
			// ContextUsage.tokens is the estimated used tokens (may be null after compaction).
			const usedTokens = usage.tokens;
			if (typeof usedTokens === "number" && usedTokens > 0) {
				const pct = Math.min(100, Math.round((usedTokens / actualCtxWin) * 100));
				dbg(`#${s} getActualPercent: tokens path => ${pct}%`);
				return pct;
			}

			// Fallback: derive token count from percent × contextWindow
			const virtualCtxWin = usage.contextWindow;
			if (virtualCtxWin && usage.percent != null) {
				const derivedUsed = (usage.percent / 100) * virtualCtxWin;
				const pct = Math.min(
					100,
					Math.round((derivedUsed / actualCtxWin) * 100),
				);
				dbg(`#${s} getActualPercent: fallback path => ${pct}% (derivedUsed=${derivedUsed})`);
				return pct;
			}

			dbg(`#${s} getActualPercent: no data`);
			return undefined;
		},

		getContextWindowLabel(): string | undefined {
			const ctxWin = resolveActualContextWindow();
			const label = ctxWin ? humanReadable(ctxWin) : undefined;
			dbg(`#${seq()} getContextWindowLabel() => ${label}`);
			return label;
		},
	};

	// Expose on globalThis
	(globalThis as Record<string, unknown>).__piRouterBridge = bridge;

	// ── Event listeners ────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		currentRouteId = undefined;
		dbg(`session_start: model=${ctx.model?.provider}/${ctx.model?.id}`);
	});

	pi.on("model_select", async (event, ctx) => {
		latestCtx = ctx;
		const model = ctx.model;
		const prev = event.previousModel;
		let newRouteId: string | undefined;

		if (model?.provider === "auto-router") {
			newRouteId = model.id;
		} else {
			newRouteId = undefined;
		}

		currentRouteId = newRouteId;

		const usage = ctx.getContextUsage?.();
		dbg(
			`model_select: model=${model?.provider}/${model?.id}, ` +
			`prev=${prev?.provider}/${prev?.id}, ` +
			`source=${event.source}, ` +
			`currentRouteId=${currentRouteId}, ` +
			`ctx.model.cw=${ctx.model?.contextWindow}, ` +
			`usage.tokens=${usage?.tokens}, usage.cw=${usage?.contextWindow}, usage.pct=${usage?.percent}`
		);
	});
}
