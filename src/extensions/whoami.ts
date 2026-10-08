/**
 * Whoami Extension — self-identity tool for the LLM.
 *
 * Provides the `whoami` tool: lets the model learn who it is and what it can
 * do without guessing — provider, model, input modalities (vision), reasoning,
 * thinking level, context window, and current context usage. Optionally lists
 * all auth-configured models with their modalities (`includeCatalog`).
 *
 * Motivation: capability-aware self-routing. Example — before touching an
 * image, the model checks `vision` to decide between reading the file
 * directly (vision-capable model) and delegating the task to the
 * `image-recognizer` subagent (text-only model).
 *
 * Data sources (authoritative first):
 *   1. `ctx.model` / `ctx.modelRegistry` — the session's active model object
 *      (id, name, api, input modalities, reasoning, contextWindow, maxTokens)
 *   2. `ctx.thinkingLevel` / `ctx.getContextUsage()` — session runtime state
 *   3. `PI_PROVIDER` / `PI_MODEL` env vars — cross-checked; on mismatch the
 *      active model wins and the discrepancy is reported
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";


type CatalogEntry = {
	provider: string;
	model: string;
	input: string[];
	vision: boolean;
};

type WhoamiResult = {
	provider: string;
	providerName?: string;
	model: string;
	modelName: string;
	api: string;
	input: string[];
	vision: boolean;
	reasoning: boolean;
	thinkingLevel?: string;
	contextWindow: number;
	maxTokens: number;
	contextTokens: number | null;
	contextPercent: number | null;
	cwd: string;
	mode: string;
	envProvider?: string;
	envModel?: string;
	envMismatch: boolean;
	catalog?: CatalogEntry[];
};

const whoamiTool = defineTool({
	name: "whoami",
	label: "Whoami",
	description:
		"Report your own identity and capabilities: provider, model, input " +
		"modalities (vision), reasoning, thinking level, context window and " +
		"current context usage. Call it whenever a decision depends on what " +
		"you are capable of — e.g. before reading an image file (vision vs " +
		"delegating to an OCR/vision subagent), or when unsure about your " +
		"remaining context budget. With includeCatalog=true also lists every " +
		"auth-configured model and its modalities.",
	parameters: Type.Object({
		includeCatalog: Type.Optional(
			Type.Boolean({
				description:
					"Also list all auth-configured models with their input modalities (default: false)",
			}),
		),
	}),
	promptSnippet:
		"whoami: report your own identity and capabilities (provider, model, vision, reasoning, context usage)",
	promptGuidelines: [
		"Before reading an image file, call `whoami` and follow its vision guidance: vision=false → delegate image/OCR/chart work to the image-recognizer subagent; vision=true → you may read image files directly.",
	],

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const model = ctx.model;
		if (!model) {
			throw new Error("whoami: no active model in this session");
		}

		const vision = model.input.includes("image");
		const providerName = ctx.modelRegistry.getProvider(model.provider)?.name;
		const usage = ctx.getContextUsage();
		const envProvider = process.env.PI_PROVIDER;
		const envModel = process.env.PI_MODEL;
		const envMismatch =
			(envProvider !== undefined && envProvider !== model.provider) ||
			(envModel !== undefined && envModel !== model.id);

		const result: WhoamiResult = {
			provider: model.provider,
			providerName: providerName || undefined,
			model: model.id,
			modelName: model.name,
			api: model.api,
			input: [...model.input],
			vision,
			reasoning: model.reasoning,
			thinkingLevel: ctx.thinkingLevel,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			contextTokens: usage?.tokens ?? null,
			contextPercent: usage?.percent ?? null,
			cwd: ctx.cwd,
			mode: ctx.mode,
			envProvider,
			envModel,
			envMismatch,
		};

		const lines: string[] = [
			`provider: ${model.provider}${providerName ? ` (${providerName})` : ""}`,
			`model: ${model.id} ("${model.name}"), api=${model.api}`,
			`input modalities: [${model.input.join(", ")}] → vision: ${vision ? "YES" : "NO"}`,
		];
		lines.push(
			vision
				? "  → You can see images: you may read image files directly. Delegating batch/heavy OCR work to a vision subagent is still allowed."
				: "  → You are text-only: do NOT read image files. Delegate image/OCR/chart tasks to the image-recognizer subagent.",
		);
		lines.push(
			`reasoning: ${model.reasoning ? "yes" : "no"}` +
				` | thinking level: ${ctx.thinkingLevel ?? "n/a"}`,
		);
		lines.push(
			`context window: ${model.contextWindow.toLocaleString("en-US")} tokens | max output: ${model.maxTokens.toLocaleString("en-US")}`,
		);
		if (usage) {
			const tokens = usage.tokens === null ? "unknown" : usage.tokens.toLocaleString("en-US");
			const percent = usage.percent === null ? "?" : usage.percent.toFixed(1);
			lines.push(`context usage: ${tokens} tokens (${percent}%)`);
		}
		lines.push(`cwd: ${ctx.cwd} | mode: ${ctx.mode}`);
		if (envMismatch) {
			lines.push(
				`warning: env (PI_PROVIDER=${envProvider ?? "-"}, PI_MODEL=${envModel ?? "-"}) ` +
					`differs from the active model ${model.provider}/${model.id} — the active model above is authoritative.`,
			);
		}

		if (params.includeCatalog) {
			const catalog: CatalogEntry[] = ctx.modelRegistry
				.getAvailable()
				.map((m) => ({
					provider: m.provider,
					model: m.id,
					input: [...m.input],
					vision: m.input.includes("image"),
				}));
			if (catalog.length > 0) {
				result.catalog = catalog;
				lines.push("", "auth-configured models:");
				for (const m of catalog) {
					lines.push(
						`- ${m.provider}/${m.model}: [${m.input.join(", ")}]${m.vision ? " (vision)" : ""}`,
					);
				}
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: result,
		};
	},
});

export default function whoamiExtension(pi: ExtensionAPI) {
	pi.registerTool(whoamiTool);
}
