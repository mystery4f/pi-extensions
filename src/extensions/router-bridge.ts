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

export default function routerBridgeExtension(pi: ExtensionAPI) {
	let currentRouteId: string | undefined;
	let latestCtx: ExtensionContext | undefined;

	/** Read the latest routed model directly from auto-router (no cache) */
	function getLatestRoutedModel(): RoutedModel | undefined {
		if (!currentRouteId) return undefined;
		try {
			const router = (globalThis as Record<string, unknown>)
				.__piCacheOptimizerRouter as {
				getRoutedModel?: (id: string) => RoutedModel | undefined;
			} | undefined;
			return router?.getRoutedModel?.(currentRouteId);
		} catch {
			return undefined;
		}
	}

	/** Resolve the context window for the currently routed model */
	function resolveActualContextWindow(): number | undefined {
		const model = getLatestRoutedModel();
		if (!model) return undefined;
		return resolveContextWindow(
			model.provider,
			model.modelId,
			(latestCtx as any)?.modelRegistry,
		);
	}

	// ── Bridge API (exposed via globalThis) ────────────────────

	const bridge: RouterBridgeAPI = {
		getRoutedModel(): RoutedModel | undefined {
			return getLatestRoutedModel();
		},

		getActualContextWindow(): number | undefined {
			return resolveActualContextWindow();
		},

		getActualPercent(): number | undefined {
			const actualCtxWin = resolveActualContextWindow();
			if (!actualCtxWin || !latestCtx) return undefined;

			const usage = latestCtx.getContextUsage?.();
			if (!usage) return undefined;

			// Prefer the raw token count for accuracy.
			// ContextUsage.tokens is the estimated used tokens (may be null after compaction).
			const usedTokens = usage.tokens;
			if (typeof usedTokens === "number" && usedTokens > 0) {
				return Math.min(100, Math.round((usedTokens / actualCtxWin) * 100));
			}

			// Fallback: derive token count from percent × contextWindow
			const virtualCtxWin = usage.contextWindow;
			if (virtualCtxWin && usage.percent != null) {
				const derivedUsed = (usage.percent / 100) * virtualCtxWin;
				return Math.min(
					100,
					Math.round((derivedUsed / actualCtxWin) * 100),
				);
			}

			return undefined;
		},

		getContextWindowLabel(): string | undefined {
			const ctxWin = resolveActualContextWindow();
			return ctxWin ? humanReadable(ctxWin) : undefined;
		},
	};

	// Expose on globalThis
	(globalThis as Record<string, unknown>).__piRouterBridge = bridge;

	// ── Event listeners ────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		currentRouteId = undefined;
	});

	pi.on("model_select", async (_event, ctx) => {
		latestCtx = ctx;
		const model = ctx.model;

		if (model?.provider === "auto-router") {
			currentRouteId = model.id;
		} else {
			currentRouteId = undefined;
		}
	});
}
