/**
 * Tool Toggle — minimal interactive enable/disable manager for Pi tools.
 *
 * Provides a single `/tools` command that opens a TUI checkbox list of every
 * available tool ("/" enters a substring search). Toggling tools off blocks
 * them for the rest of the session (they disappear from the model's tool list
 * and calls are rejected), and the disabled names can be persisted.
 *
 * Scopes (highest priority first) — both persist DISABLED tool names only:
 *   1. session  — custom session entry {"disabledTools":[...]}
 *   2. global   — ~/.pi/agent/tool-toggle.json {"disabledTools":[...]}
 *   3. runtime  — the tools Pi activated at startup (baseline)
 * A legacy global file in the old {"enabledTools":[...]} whitelist format is
 * migrated once on session start.
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
 * configs — just the list, the checkboxes, a substring search, and the scopes
 * above.
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

type ToolsState = { disabledTools?: string[]; enabledTools?: string[] };

type ToolRow = {
	name: string;
	source: string;
	description: string;
	plugin?: string;
};

/** Short label for where a tool comes from (builtin / SDK / extension). */
function toolSourceLabel(tool: { name: string; sourceInfo?: { source?: string } }): string {
	const source = tool.sourceInfo?.source;
	if (source === "core") return "builtin";
	if (source === "coding-agent") return "sdk";
	if (source === "mcp") return "mcp";
	return source ?? "extension";
}

/**
 * Best-effort plugin/package name for a tool: npm package directory, git
 * package owner/repo, or the top-level extension directory name.
 */
function pluginLabel(
	sourceInfo?: { path?: string; origin?: string; baseDir?: string },
): string | undefined {
	if (!sourceInfo?.path) return undefined;
	if (sourceInfo.origin !== "package") {
		// Top-level extension file: use its directory name.
		const dir = sourceInfo.baseDir ?? path.dirname(sourceInfo.path);
		const base = path.basename(dir);
		return base && ![".", "/", "\\"].includes(base) ? base : undefined;
	}
	const segments = sourceInfo.path.split(/[\\/]/);
	const nm = segments.lastIndexOf("node_modules");
	if (nm >= 0 && segments[nm + 1]) {
		const pkg = segments[nm + 1];
		return pkg.startsWith("@") ? `${pkg}/${segments[nm + 2]}` : pkg;
	}
	const git = segments.findIndex(
		(seg) => seg === "git-github.com" || seg === "github.com",
	);
	if (git >= 0) {
		// git-github.com/<hash>/<owner>/<repo> or git/github.com/<owner>/<repo>
		const rest = segments
			.slice(git + 1)
			.filter((seg) => seg !== "." && !/^[0-9a-f]{6,}$/.test(seg));
		return rest.length >= 2 ? rest.slice(0, 2).join("/") : undefined;
	}
	return undefined;
}

/** Read the global file. Legacy whitelist (`enabledTools`) files are ignored. */
function loadGlobalState(): { disabled?: Set<string>; legacyEnabled?: Set<string> } {
	try {
		const parsed = JSON.parse(fs.readFileSync(GLOBAL_FILE, "utf8")) as ToolsState;
		if (parsed.disabledTools) return { disabled: new Set(parsed.disabledTools) };
		if (parsed.enabledTools) return { legacyEnabled: new Set(parsed.enabledTools) };
		return {};
	} catch {
		return {};
	}
}

function saveGlobalDisabled(disabled: Set<string>): void {
	const payload: ToolsState = { disabledTools: [...disabled].sort() };
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
 * Keys: up/down move, space toggles, a toggles the shown rows, "/" enters
 * search mode (type to filter by tool name, description, or plugin/package
 * name; backspace erases, esc leaves search), ctrl+s saves in place (the
 * picker stays open), esc closes without saving.
 */
class ToolTogglePicker {
	readonly width = 64;
	private cursor = 0;
	private scrollOffset = 0;
	private checked: Set<string>;
	private searchMode = false;
	private query = "";
	private savedMessage: string | null = null;

	constructor(
		private readonly theme: Theme,
		private readonly done: (result: Set<string> | undefined) => void,
		private readonly rows: ToolRow[],
		checkedNames: string[],
		private readonly title: string,
		private readonly onSave?: (checked: Set<string>) => void,
	) {
		this.checked = new Set(checkedNames);
	}

	/** Rows after applying the search query (case-insensitive substring). */
	private visibleRows(): ToolRow[] {
		if (!this.query) return this.rows;
		const q = this.query.toLowerCase();
		return this.rows.filter(
			(row) =>
				row.name.toLowerCase().includes(q) ||
				row.description.toLowerCase().includes(q) ||
				(row.plugin !== undefined && row.plugin.toLowerCase().includes(q)),
		);
	}

	handleInput(data: string): void {
		this.savedMessage = null;
		if (matchesKey(data, "escape")) {
			if (this.searchMode) {
				this.searchMode = false;
				this.query = "";
			} else {
				this.done(undefined);
				return;
			}
		} else if (matchesKey(data, "ctrl+s")) {
			if (this.onSave) {
				this.onSave(new Set(this.checked));
				this.savedMessage = `Saved ✓ (${this.checked.size} enabled)`;
			}
		} else if (matchesKey(data, "up")) {
			if (this.cursor > 0) this.cursor--;
		} else if (matchesKey(data, "down")) {
			if (this.cursor < this.visibleRows().length - 1) this.cursor++;
		} else if (matchesKey(data, "space")) {
			this.toggleCurrent();
		} else if (this.searchMode && matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
		} else if (!this.searchMode && data === "/") {
			this.searchMode = true;
		} else if (this.searchMode && data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
		} else if (matchesKey(data, "a")) {
			const shown = this.visibleRows();
			const allChecked = shown.every((row) => this.checked.has(row.name));
			for (const row of shown) {
				if (allChecked) this.checked.delete(row.name);
				else this.checked.add(row.name);
			}
		} else {
			return;
		}
		// Filtering may have changed behind the cursor: keep the highlighted
		// row when it is still visible, otherwise clamp into range.
		const rows = this.visibleRows();
		const before = rows[this.cursor]?.name;
		if (this.cursor < 0) this.cursor = 0;
		if (this.cursor >= rows.length) this.cursor = rows.length - 1;
		const kept = rows.findIndex((row) => row.name === before);
		if (kept >= 0) this.cursor = kept;
		this.clampScroll();
	}

	private toggleCurrent(): void {
		const name = this.visibleRows()[this.cursor]?.name;
		if (!name) return;
		if (this.checked.has(name)) this.checked.delete(name);
		else this.checked.add(name);
	}

	private clampScroll(): void {
		const last = this.visibleRows().length - 1;
		if (this.cursor > last) this.cursor = last;
		if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
		if (this.cursor >= this.scrollOffset + MAX_VISIBLE_ROWS) {
			this.scrollOffset = this.cursor - MAX_VISIBLE_ROWS + 1;
		}
	}

	render(width: number): string[] {
		const rows = this.visibleRows();
		const visible = rows.slice(this.scrollOffset, this.scrollOffset + MAX_VISIBLE_ROWS);
		const lines: string[] = [];
		const enabledCount = this.checked.size;

		lines.push("");
		lines.push(this.theme.fg("accent", this.theme.bold(` ${this.title}`)));
		let status = this.theme.fg("dim", ` ${enabledCount}/${this.rows.length} enabled`);
		if (this.savedMessage) {
			status += this.theme.fg("success", `  ${this.savedMessage}`);
		} else if (this.query) {
			status += this.theme.fg("dim", `  (${rows.length}/${this.rows.length} match)`);
		} else if (this.rows.length > MAX_VISIBLE_ROWS) {
			status += this.theme.fg(
				"dim",
				`  (showing ${this.scrollOffset + 1}-${this.scrollOffset + visible.length})`,
			);
		}
		lines.push(status);
		if (this.searchMode) {
			lines.push(this.theme.fg("accent", ` / ${this.query}█  (esc exits search)`));
		}
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
			const source = this.theme.fg("dim", ` (${row.plugin ?? row.source})`);
			lines.push(truncateToWidth(`${cursorMark} ${checkbox} ${name}${source}`, width - 2));
		}

		lines.push("");
		lines.push(
			this.theme.fg(
				"dim",
				" up/down move · space toggle · a toggle shown · / search · ctrl+s save · esc close",
			),
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
	let sessionDisabled: Set<string> | undefined;
	let globalDisabled: Set<string> | undefined;

	// Set when the tool selection changes; consumed by the cache_warming
	// decision handler to stop one stale warmer cycle.
	let warmStale = false;

	const effectiveDisabled = (): Set<string> | undefined =>
		sessionDisabled ?? globalDisabled;

	/**
	 * Apply the effective disabled set to the live tool list.
	 * Clearing only restores names Pi activated (baseline) plus whatever is
	 * currently active, so tools other extensions deliberately deactivated stay off.
	 */
	const enforce = (ctx: ExtensionContext): void => {
		if (!tuiActive || ctx.mode !== "tui") return;
		const disabled = effectiveDisabled();
		const active = pi.getActiveTools();
		if (!disabled) {
			const merged = [...new Set([...(runtimeBaseline ?? []), ...active])];
			if (merged.length !== active.length) pi.setActiveTools(merged);
			return;
		}
		const filtered = active.filter((name) => !disabled.has(name));
		if (filtered.length !== active.length) pi.setActiveTools(filtered);
	};

	pi.on("session_start", async (_event, ctx) => {
		tuiActive = ctx.mode === "tui";
		if (!tuiActive) return;
		runtimeBaseline ??= [...pi.getActiveTools()];
		const globalState = loadGlobalState();
		if (globalState.disabled) {
			globalDisabled = globalState.disabled;
		}
		sessionDisabled = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as ToolsState | undefined;
				sessionDisabled = new Set(data?.disabledTools ?? []);
			}
		}
		enforce(ctx);
		// Any warmer now holds a pre-session-start request; stop it once.
		warmStale = true;
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!tuiActive) return;
		sessionDisabled = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as ToolsState | undefined;
				sessionDisabled = new Set(data?.disabledTools ?? []);
			}
		}
		enforce(ctx);
	});

	pi.on("model_select", async (_event, ctx) => enforce(ctx));
	pi.on("before_agent_start", async (_event, ctx) => enforce(ctx));

	// One-shot stop: after a selection change the idle warmer still holds the
	// pre-change request. "stop" ends warming until the next real message,
	// which recaptures fresh context with the new tool list.
	pi.on("cache_warming_decision", () => {
		if (!tuiActive || !warmStale) return;
		warmStale = false;
		return { action: "stop" };
	});

	// Defensive rejection: anything that slipped past the active-list trim.
	pi.on("tool_call", (event, ctx) => {
		if (!tuiActive || ctx.mode !== "tui") return;
		const disabled = effectiveDisabled();
		if (disabled && disabled.has(event.toolName)) {
			return {
				block: true,
				reason: `Tool "${event.toolName}" is disabled by the /tools selection.`,
			};
		}
	});

	// Late-registered tools: request another toolsRemoved delta at request time.
	pi.on("context_with_system", (event, ctx) => {
		if (!tuiActive || ctx.mode !== "tui") return;
		const disabled = effectiveDisabled();
		if (!disabled) return;
		const excluded = new Set<string>();
		for (const message of event.messages) {
			if (message.role !== "system") continue;
			for (const tool of message.toolsRemoved ?? []) excluded.delete(tool.name);
			for (const tool of message.toolsAdded ?? []) {
				if (disabled.has(tool.name)) excluded.add(tool.name);
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

	pi.on("session_shutdown", async () => {
		tuiActive = false;
		runtimeBaseline = undefined;
		sessionDisabled = undefined;
		globalDisabled = undefined;
	});


	/** Persist + enforce a picker selection; the picker flashes the feedback. */
	const applySelection = (
		ctx: ExtensionCommandContext,
		scope: "session" | "global",
		rows: ToolRow[],
		checked: Set<string>,
	): void => {
		const disabledAfter = new Set(
			rows.map((row) => row.name).filter((name) => !checked.has(name)),
		);
		if (scope === "global") {
			globalDisabled = disabledAfter;
			saveGlobalDisabled(disabledAfter);
		} else {
			sessionDisabled = disabledAfter;
			pi.appendEntry(CUSTOM_TYPE, {
				disabledTools: [...disabledAfter].sort(),
			} satisfies ToolsState);
		}
		enforce(ctx);
		warmStale = true;
	};
	pi.registerCommand("tools", {
		description: "Interactively enable/disable tools (/tools, /tools global, /tools clear [global])",
		getArgumentCompletions: (argumentPrefix: string) => {
			const p = argumentPrefix.trim().toLowerCase();
			const items = [
				{
					value: "global",
					label: "global",
					description: "Edit the global disabled list (new sessions)",
				},
				{
					value: "clear",
					label: "clear",
					description: "Clear the session selection",
				},
				{
					value: "clear global",
					label: "clear global",
					description: "Clear the global selection (delete the config file)",
				},
			];
			const filtered = items.filter((item) => item.value.startsWith(p));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim().toLowerCase();
			const isGlobalScope = trimmed.includes("global");
			const isClear = trimmed.startsWith("clear");

			if (isClear) {
				if (isGlobalScope) {
					globalDisabled = undefined;
					deleteGlobalFile();
					ctx.ui.notify("Global tool selection cleared.", "info");
				} else {
					sessionDisabled = undefined;
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

			const rows: ToolRow[] = pi
				.getAllTools()
				.map((tool) => ({
					name: tool.name,
					source: toolSourceLabel(tool),
					description: tool.description ?? "",
					plugin: pluginLabel(tool.sourceInfo),
				}))
				.sort((a, b) => a.name.localeCompare(b.name));
			const disabled = effectiveDisabled();
			const checkedNames = disabled
				? rows.map((row) => row.name).filter((name) => !disabled.has(name))
				: [...pi.getActiveTools()];

			const scopeLabel = isGlobalScope
				? "Tools — GLOBAL selection (new sessions)"
				: "Tools — session selection";

			await ctx.ui.custom<Set<string> | undefined>(
				(tui, theme, keybindings, done) =>
					new ToolTogglePicker(
						theme,
						done,
						rows,
						checkedNames,
						scopeLabel,
						(checked) =>
							applySelection(ctx, isGlobalScope ? "global" : "session", rows, checked),
					),
				{ overlay: true },
			);
			},
	});
}
