/**
 * Tool Toggle — minimal interactive enable/disable manager for Pi tools.
 *
 * Provides a single `/tools` command that opens a TUI checkbox list of every
 * available tool. Toggling tools off blocks them for the rest of the session
 * (they disappear from the model's tool list and calls are rejected), and the
 * selection can be persisted globally.
 *
 * Scopes (highest priority first):
 *   1. session  — stored as a custom session entry, survives branch switching
 *   2. global   — persisted in ~/.pi/agent/tool-toggle.json
 *   3. runtime  — the tools Pi activated at startup (baseline)
 *
 * Commands:
 *   /tools              edit the session selection
 *   /tools global       edit the global selection (applies to new sessions)
 *   /tools clear        drop the session selection (inherit global/runtime)
 *   /tools clear global drop the global selection
 *
 * Enforcement mirrors @firstpick/pi-extension-tools:
 *   - pi.setActiveTools() trims the live tool list
 *   - a context_with_system handler appends a toolsRemoved system delta so the
 *     request payload also drops tools registered by later extensions
 *   - a tool_call handler rejects blocked calls defensively
 * After any selection change, a one-shot cache_warming_decision handler stops
 * Pi's idle cache warmer so the stale pre-change request is not re-sent.
 *
 * Deliberately minimal: no fuzzy search, no sort keywords, no per-model
 * configs — just the list, the checkboxes, and the scopes above.
 *
 * @author mystery4f
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "tool-toggle-config";
const GLOBAL_FILE = path.join(os.homedir(), ".pi", "agent", "tool-toggle.json");
const MAX_VISIBLE_ROWS = 15;

type ToolsState = { enabledTools?: string[] };

type ToolRow = {
	name: string;
	source: string;
	description: string;
};

/** Short label for where a tool comes from (builtin / SDK / extension). */
function toolSourceLabel(tool: { name: string; sourceInfo?: { source?: string } }): string {
	const source = tool.sourceInfo?.source;
	if (source === "core") return "builtin";
	if (source === "coding-agent") return "sdk";
	if (source === "mcp") return "mcp";
	return source ?? "extension";
}


function loadGlobalSelection(): Set<string> | undefined {
	try {
		const raw = fs.readFileSync(GLOBAL_FILE, "utf8");
		const parsed = JSON.parse(raw) as ToolsState;
		return new Set(parsed.enabledTools ?? []);
	} catch {
		return undefined;
	}
}

function saveGlobalSelection(selection: Set<string>): void {
	const payload: ToolsState = { enabledTools: [...selection].sort() };
	fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true });
	fs.writeFileSync(GLOBAL_FILE, JSON.stringify(payload, null, "\t") + "\n", "utf8");
}

function deleteGlobalFile(): void {
	try {
		fs.unlinkSync(GLOBAL_FILE);
	} catch {
		// already absent — fine
	}
}

/**
 * Scrollable checkbox list of all tools.
 *
 * Keys: up/down move, space toggles, a toggles all, enter applies, esc cancels.
 */
class ToolTogglePicker {
	readonly width = 64;
	private cursor = 0;
	private scrollOffset = 0;
	private checked: Set<string>;

	constructor(
		private readonly theme: Theme,
		private readonly done: (result: Set<string> | undefined) => void,
		private readonly rows: ToolRow[],
		checkedNames: string[],
		private readonly title: string,
	) {
		this.checked = new Set(checkedNames);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "return")) {
			this.done(new Set(this.checked));
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.cursor > 0) this.cursor--;
		} else if (matchesKey(data, "down")) {
			if (this.cursor < this.rows.length - 1) this.cursor++;
		} else if (matchesKey(data, "space")) {
			this.toggleCurrent();
		} else if (matchesKey(data, "a")) {
			if (this.checked.size === this.rows.length) this.checked.clear();
			else for (const row of this.rows) this.checked.add(row.name);
		} else {
			return;
		}
		this.clampScroll();
	}

	private toggleCurrent(): void {
		const name = this.rows[this.cursor]?.name;
		if (!name) return;
		if (this.checked.has(name)) this.checked.delete(name);
		else this.checked.add(name);
	}

	private clampScroll(): void {
		if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
		if (this.cursor >= this.scrollOffset + MAX_VISIBLE_ROWS) {
			this.scrollOffset = this.cursor - MAX_VISIBLE_ROWS + 1;
		}
	}

	render(width: number): string[] {
		const visible = this.rows.slice(this.scrollOffset, this.scrollOffset + MAX_VISIBLE_ROWS);
		const lines: string[] = [];
		const enabledCount = this.checked.size;

		lines.push("");
		lines.push(this.theme.fg("accent", this.theme.bold(` ${this.title}`)));
		lines.push(
			this.theme.fg("dim", ` ${enabledCount}/${this.rows.length} enabled`) +
			(this.rows.length > MAX_VISIBLE_ROWS
				? this.theme.fg("dim", `  (showing ${this.scrollOffset + 1}-${this.scrollOffset + visible.length})`)
				: ""),
		);
		lines.push("");

		for (let i = 0; i < visible.length; i++) {
			const row = visible[i];
			const index = this.scrollOffset + i;
			const checkbox = this.checked.has(row.name) ? "[x]" : "[ ]";
			const cursorMark = index === this.cursor ? ">" : " ";
			const name = this.theme.fg(
				this.checked.has(row.name) ? "success" : "dim",
				row.name,
			);
			const source = this.theme.fg("dim", ` (${row.source})`);
			lines.push(truncateToWidth(`${cursorMark} ${checkbox} ${name}${source}`, width - 2));
		}

		lines.push("");
		lines.push(
			this.theme.fg("dim", " up/down move · space toggle · a all · enter apply · esc cancel"),
		);
		lines.push("");
		return lines;
	}
	invalidate(): void {
		// No cached render state — nothing to invalidate.
	}
}

export default function toolToggle(pi: ExtensionAPI) {
	// Enforcement only runs in interactive TUI sessions; RPC/print stay untouched.
	let tuiActive = false;
	let runtimeBaseline: string[] | undefined;
	let sessionSelection: Set<string> | undefined;
	let globalSelection: Set<string> | undefined;


	// Set when the tool selection changes; consumed by the cache_warming
	// decision handler to stop one stale warmer cycle.
	let warmStale = false;
	const effectiveSelection = (): Set<string> | undefined =>
		sessionSelection ?? globalSelection;

	/**
	 * Apply the effective selection to the live tool list.
	 * Clearing only restores names Pi activated (baseline) plus whatever is
	 * currently active, so tools other extensions deliberately deactivated stay off.
	 */
	const enforce = (ctx: ExtensionContext): void => {
		if (!tuiActive || ctx.mode !== "tui") return;
		const selection = effectiveSelection();
		const active = pi.getActiveTools();
		if (!selection) {
			const merged = [...new Set([...(runtimeBaseline ?? []), ...active])];
			if (merged.length !== active.length) pi.setActiveTools(merged);
			return;
		}
		const filtered = active.filter((name) => selection.has(name));
		if (filtered.length !== active.length) pi.setActiveTools(filtered);
	};

	pi.on("session_start", async (_event, ctx) => {
		const activeBefore = pi.getActiveTools();
		tuiActive = ctx.mode === "tui";
		if (!tuiActive) return;
		runtimeBaseline ??= [...pi.getActiveTools()];
		globalSelection = loadGlobalSelection();
		sessionSelection = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as ToolsState | undefined;
				sessionSelection = new Set(data?.enabledTools ?? []);
			}
		}
		enforce(ctx);
		// Any warmer now holds a pre-session-start request; stop it once.
		warmStale = true;
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!tuiActive) return;
		sessionSelection = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as ToolsState | undefined;
				sessionSelection = new Set(data?.enabledTools ?? []);
			}
		}
		enforce(ctx);
	});

	pi.on("model_select", async (_event, ctx) => enforce(ctx));
	pi.on("before_agent_start", async (_event, ctx) => enforce(ctx));

	// Defensive rejection: anything that slipped past the active-list trim.
	pi.on("tool_call", (event, ctx) => {
		if (!tuiActive || ctx.mode !== "tui") return;
		const selection = effectiveSelection();
		if (selection && !selection.has(event.toolName)) {
			return {
				block: true,
				reason: `Tool "${event.toolName}" is disabled by the /tools selection.`,
			};
		}
	});

	// Late-registered tools: request another toolsRemoved delta at request time.
	pi.on("context_with_system", (event, ctx) => {
		if (!tuiActive || ctx.mode !== "tui") return;
		const selection = effectiveSelection();
		if (!selection) return;
		const excluded = new Set<string>();
		for (const message of event.messages) {
			if (message.role !== "system") continue;
			for (const tool of message.toolsRemoved ?? []) excluded.delete(tool.name);
			for (const tool of message.toolsAdded ?? []) {
				if (!selection.has(tool.name)) excluded.add(tool.name);
			}
		}
		if (excluded.size === 0) return;
		return {
			messages: [
				...event.messages,
				{
					role: "system" as const,
					content: "",
					toolsRemoved: [...excluded].map((name) => ({ name })),
					timestamp: Date.now(),
				},
			],
		};
	});


	// One-shot stop: after a selection change the idle warmer still holds the
	// pre-change request. "stop" ends warming until the next real message,
	// which recaptures fresh context with the new tool list.
	pi.on("cache_warming_decision", () => {
		if (!tuiActive || !warmStale) return;
		warmStale = false;
		return { action: "stop" };
	});
	pi.on("session_shutdown", async () => {
		tuiActive = false;
		runtimeBaseline = undefined;
		sessionSelection = undefined;
		globalSelection = undefined;
	});

	pi.registerCommand("tools", {
		description: "Interactively enable/disable tools (/tools, /tools global, /tools clear [global])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim().toLowerCase();
			const isGlobalScope = trimmed.includes("global");
			const isClear = trimmed.startsWith("clear");

			if (isClear) {
				if (isGlobalScope) {
					globalSelection = undefined;
					deleteGlobalFile();
					ctx.ui.notify("Global tool selection cleared.", "info");
				} else {
					sessionSelection = undefined;
					ctx.ui.notify("Session tool selection cleared.", "info");
				}
				enforce(ctx);
				warmStale = true;
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires an interactive TUI session.", "warning");
				return;
			}

			const scopeSelection = isGlobalScope ? globalSelection : sessionSelection;
			const baselineNames =
				scopeSelection !== undefined ? [...scopeSelection] : [...pi.getActiveTools()];
			const rows: ToolRow[] = pi
				.getAllTools()
				.map((tool) => ({
					name: tool.name,
					source: toolSourceLabel(tool),
					description: tool.description ?? "",
				}))
				.sort((a, b) => a.name.localeCompare(b.name));

			const scopeLabel = isGlobalScope
				? "Tools — GLOBAL selection (new sessions)"
				: "Tools — session selection";

			const result = await ctx.ui.custom<Set<string> | undefined>(
				(tui, theme, keybindings, done) =>
					new ToolTogglePicker(theme, done, rows, baselineNames, scopeLabel),
				{ overlay: true },
			);
			if (!result) return; // cancelled

			if (isGlobalScope) {
				globalSelection = result;
				saveGlobalSelection(result);
			} else {
				sessionSelection = result;
				pi.appendEntry(CUSTOM_TYPE, { enabledTools: [...result].sort() } satisfies ToolsState);
			}
			enforce(ctx);
			warmStale = true;
			ctx.ui.notify(
				`${result.size}/${rows.length} tools enabled (${isGlobalScope ? "global" : "session"}).`,
				"info",
			);
		},
	});
}
