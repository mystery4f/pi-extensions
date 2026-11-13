/**
 * Tool Toggle — minimal interactive enable/disable manager for Pi tools.
 *
 * Provides a single `/tools` command that opens a TUI checkbox list of every
 * available tool ("/" searches by tool name, "p" by plugin name, and the query
 * accepts pasted text; "d" / alt+d shows a scrollable description + parameters).
 * Toggling tools off blocks
 * them for the rest of the session (they disappear from the model's tool list
 * and calls are rejected), and the disabled names can be persisted.
 *
 * Scopes (highest priority first) — both persist DISABLED tool names only:
 *   1. session  — custom session entry {"disabledTools":[...]}
 *   2. global   — ~/.pi/agent/tool-manager/tool-manager.json {"disabledTools":[...]}
 *   3. runtime  — the tools Pi activated at startup (baseline)
 * A legacy global file in the old {"enabledTools":[...]} whitelist format is
 * migrated once on session start.
 *
 * Commands:
 *   /tools              edit the selection; press "s" to switch scope
 *                       (session ↔ global, global applies to new sessions)
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
 * Usage accounting (docs/adr/0001-per-device-usage-jsonl.md): every executed
 * call is counted, aggregated in memory, and appended to
 * ~/.pi/agent/tool-manager/data/usage-<device>.jsonl at each turn end. The
 * picker merges every device file and can sort by frequency ("o").
 *
 * Deliberately minimal: no fuzzy search, no per-model configs — just the list,
 * the checkboxes, two search targets (tool name / plugin name), a detail panel,
 * the scopes above, and a usage column whose sort key cycles with "o".
 *
 * @author mystery4f
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	CONFIG_FILE,
	DATA_DIR,
	clearUsage,
	createUsageRecorder,
	deviceName,
	formatUsageTable,
	migrateLegacyConfig,
	readMergedUsage,
} from "./tool-manager-usage.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "tool-manager-config";
const MAX_VISIBLE_ROWS = 15;
/**
 * Fixed number of content rows in the detail panel viewport. Longer content is
 * reached with the scroll keys instead of being truncated away.
 */
const DETAIL_HEIGHT = 14;
/** Bracketed-paste markers wrapped around pasted text by the terminal layer. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** One keymap line: the key label and what it does. */
type HelpEntry = readonly [keys: string, action: string];
/** A named group of bindings; groups are what the keymap panel lays out. */
type HelpSection = { readonly title: string; readonly entries: readonly HelpEntry[] };

/**
 * Every binding, grouped the way the panel reads rather than by key order.
 * The footer only has room for four of them, so the rest live here.
 */
const KEYMAP: readonly HelpSection[] = [
	{
		title: "navigate",
		entries: [
			["↑ / ↓", "previous / next row (scrolls detail when open)"],
			["alt+↑ / alt+↓", "row, while the detail panel is open"],
			["ctrl+home", "first row (detail: top)"],
			["ctrl+end", "last row (detail: end)"],
			["PgUp / PgDn", "one screen (detail: one screen)"],
		],
	},
	{
		title: "select",
		entries: [
			["space", "toggle the highlighted tool"],
			["a", "toggle every row currently shown"],
		],
	},
	{
		title: "find",
		entries: [
			["/", "search by tool name"],
			["p", "search by plugin name"],
			["tab", "swap the search target while searching"],
		],
	},
	{
		title: "view",
		entries: [
			["d / alt+d", "detail panel (alt+d works in search too)"],
			["f", "filter: all -> enabled -> disabled"],
			["s", "scope: session -> global"],
			["o", "sort: name -> count desc -> count asc"],
		],
	},
	{
		title: "apply",
		entries: [
			["ctrl+s", "save the current scope"],
			["alt+q", "like esc: leave search / keymap, else quit"],
			["?", "close this keymap"],
			["esc", "leave search / keymap, otherwise close"],
		],
	},
];

/** Rows the key column occupies, so every action starts at the same column. */
const HELPER_KEY_WIDTH = 11;
/** Gap between the two help columns. */
const HELP_COLUMN_GAP = 3;
/** Below this inner width the groups stack in a single column. */
const HELP_TWO_COLUMN_WIDTH = 76;

type ToolsState = { disabledTools?: string[]; enabledTools?: string[] };

type ToolRow = {
	name: string;
	source: string;
	description: string;
	plugin?: string;
	/** Raw JSON Schema for the tool's parameters, used by the detail panel. */
	parameters?: unknown;
	exposure?: string;
	/** Merged executed-call count across every device file. */
	usage?: number;
	/** Failed calls inside {@link usage}. */
	usageErrors?: number;
	/** Latest use timestamp (ISO) across devices. */
	lastUsed?: string;
};

/** One parameter row rendered by the detail panel. */
type ParamRow = {
	name: string;
	type: string;
	required: boolean;
	description: string;
};

type JsonSchema = {
	type?: string | string[];
	description?: string;
	enum?: unknown[];
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	required?: string[];
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	$ref?: string;
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

/** Compact type label for one JSON Schema node (unions, arrays, enums, $ref). */
function schemaTypeLabel(schema: JsonSchema | undefined): string {
	if (!schema) return "any";
	if (typeof schema.$ref === "string") return schema.$ref.split("/").pop() ?? "object";
	if (schema.anyOf) return schema.anyOf.map(schemaTypeLabel).join(" | ");
	if (schema.oneOf) return schema.oneOf.map(schemaTypeLabel).join(" | ");
	if (schema.enum) return `enum(${schema.enum.map(String).join("|")})`;
	if (Array.isArray(schema.type)) return schema.type.join(" | ");
	if (schema.type === "array") return `${schemaTypeLabel(schema.items)}[]`;
	if (schema.type) return schema.type;
	if (schema.properties) return "object";
	return "any";
}

/** Flatten a tool's top-level parameter schema into detail-panel rows. */
function describeParameters(parameters: unknown): ParamRow[] {
	const root = parameters as JsonSchema | undefined;
	const properties = root?.properties;
	if (!properties) return [];
	const required = new Set(root?.required ?? []);
	return Object.entries(properties).map(([name, schema]) => ({
		name,
		type: schemaTypeLabel(schema),
		required: required.has(name),
		description: schema?.description ?? "",
	}));
}

/** Read the global file. Legacy whitelist (`enabledTools`) files are ignored. */
function loadGlobalState(): { disabled?: Set<string>; legacyEnabled?: Set<string> } {
	try {
		const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as ToolsState;
		if (parsed.disabledTools) return { disabled: new Set(parsed.disabledTools) };
		if (parsed.enabledTools) return { legacyEnabled: new Set(parsed.enabledTools) };
		return {};
	} catch {
		return {};
	}
}

function saveGlobalDisabled(disabled: Set<string>): void {
	const payload: ToolsState = { disabledTools: [...disabled].sort() };
	fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, "\t") + "\n", "utf8");
}

function deleteGlobalFile(): void {
	try {
		fs.unlinkSync(CONFIG_FILE);
	} catch {
		// already absent — fine
	}
}

/**
 * Scrollable checkbox list of all tools.
 *
 * Keys: up/down move, space toggles, a toggles the shown rows, "/" enters
 * tool-name search, "p" enters plugin-name search (tab swaps the target while
 * searching; backspace erases, esc leaves search), alt+d toggles the detail
 * panel (full description + parameter list of the highlighted row), f cycles
 * the view filter (all → enabled → disabled), s switches the scope
 * (session ↔ global).
 * Each scope keeps its OWN working copy of the checkbox state, so toggles
 * made in one scope are not carried into the other; switching also re-clamps
 * the cursor because the enabled/disabled view filter now keys off the
 * other scope's copy. ctrl+s saves the current scope's copy in place (the
 * picker stays open), esc closes without saving.
 */
export class ToolManagerPicker {
	// Width cap, not a fixed size: the overlay clamps this to the terminal
	// width, so narrow terminals shrink the panel (footer truncates) while
	// wide ones get the full key-hint line (~108 cols).
	readonly width = 112;
	private cursor = 0;
	private scrollOffset = 0;
	private readonly checkedByScope: { session: Set<string>; global: Set<string> };
	private searchMode = false;
	/** Which field the query filters on: tool name or plugin name. */
	private searchTarget: "tool" | "plugin" = "tool";
	private detailOpen = false;
	/** Vertical scroll offset inside the detail panel; reset when the row changes. */
	private detailScroll = 0;
	/** Content rows of the last rendered detail panel, used to clamp scrolling. */
	private detailLineCount = 0;
	/** Bracketed-paste accumulator: pi may deliver one paste in several chunks. */
	private pasteBuffer: string | null = null;
	/** Keymap panel opened by "?"; the footer only has room for the core keys. */
	private helpOpen = false;
	private query = "";
	private savedMessage: string | null = null;
	private filter: "all" | "enabled" | "disabled" = "all";
	private scope: "session" | "global" = "session";
	/** Sort key cycled by "o": name → count desc → count asc. */
	private sort: "name" | "count-desc" | "count-asc" = "name";
	constructor(
		private readonly theme: Theme,
		private readonly done: (result: Set<string> | undefined) => void,
		private readonly rows: ToolRow[],
		initialChecked: (scope: "session" | "global") => Set<string>,
		private readonly onSave?: (scope: "session" | "global", checked: Set<string>) => void,
	) {
		this.checkedByScope = {
			session: initialChecked("session"),
			global: initialChecked("global"),
		};
	}

	/** Live checkbox set for the scope currently being edited. */
	private get checked(): Set<string> {
		return this.checkedByScope[this.scope];
	}

	/** Rows after applying the view filter and the current search target. */
	/** Rows after the view filter, the search target and the sort key. */
	private visibleRows(): ToolRow[] {
		let rows = this.rows;
		if (this.filter === "enabled") rows = rows.filter((row) => this.checked.has(row.name));
		else if (this.filter === "disabled") rows = rows.filter((row) => !this.checked.has(row.name));
		if (this.query) {
			const q = this.query.toLowerCase();
			rows =
				this.searchTarget === "plugin"
					? rows.filter((row) => (row.plugin ?? row.source).toLowerCase().includes(q))
					: rows.filter((row) => row.name.toLowerCase().includes(q));
		}
		if (this.sort === "name") return rows;
		const direction = this.sort === "count-desc" ? -1 : 1;
		return [...rows].sort(
			(a, b) => direction * ((a.usage ?? 0) - (b.usage ?? 0)) || a.name.localeCompare(b.name),
		);
	}

	handleInput(data: string): void {
		if (this.consumePaste(data)) return;
		const cursorBefore = this.cursor;
		this.savedMessage = null;
		if (matchesKey(data, "escape")) {
			if (this.helpOpen) {
				this.helpOpen = false;
			} else if (this.searchMode) {
				this.searchMode = false;
				this.searchTarget = "tool";
				this.query = "";
			} else {
				this.done(undefined);
				return;
			}
		} else if (matchesKey(data, "alt+q")) {
			// Alt+q layers like esc: leave search or close the keymap first, and
			// only quit from the top level. It is the only quit spelling: ctrl+q
			// is swallowed by IXON on Unix terminals, and bare q/Q depends on the
			// shift state.
			if (this.helpOpen) {
				this.helpOpen = false;
			} else if (this.searchMode) {
				this.searchMode = false;
				this.searchTarget = "tool";
				this.query = "";
			} else {
				this.done(undefined);
				return;
			}
		} else if (matchesKey(data, "ctrl+s")) {
			if (this.onSave) {
				this.onSave(this.scope, new Set(this.checked));
				this.savedMessage = `保存成功 ✓ (${this.checked.size} enabled)`;
			}
		} else if (matchesKey(data, "alt+up")) {
			// Arrows scroll the open detail panel, so the row cursor moves on
			// alt+arrows while it is open (plain arrows when it is closed).
			if (this.cursor > 0) this.cursor--;
		} else if (matchesKey(data, "alt+down")) {
			if (this.cursor < this.visibleRows().length - 1) this.cursor++;
		} else if (matchesKey(data, "up")) {
			if (this.detailOpen) this.scrollDetail(-1);
			else if (this.cursor > 0) this.cursor--;
		} else if (matchesKey(data, "down")) {
			if (this.detailOpen) this.scrollDetail(1);
			else if (this.cursor < this.visibleRows().length - 1) this.cursor++;
		} else if (matchesKey(data, "ctrl+home")) {
			if (this.detailOpen) this.detailScroll = 0;
			else this.cursor = 0;
		} else if (matchesKey(data, "ctrl+end")) {
			if (this.detailOpen) this.scrollDetail(Number.MAX_SAFE_INTEGER);
			else this.cursor = Math.max(0, this.visibleRows().length - 1);
		} else if (matchesKey(data, "pageUp")) {
			if (this.detailOpen) this.scrollDetail(-DETAIL_HEIGHT);
			else this.cursor = Math.max(0, this.cursor - MAX_VISIBLE_ROWS);
		} else if (matchesKey(data, "pageDown")) {
			if (this.detailOpen) this.scrollDetail(DETAIL_HEIGHT);
			else this.cursor = Math.min(this.visibleRows().length - 1, this.cursor + MAX_VISIBLE_ROWS);
		} else if (matchesKey(data, "space")) {
			this.toggleCurrent();
		} else if (this.searchMode && matchesKey(data, "tab")) {
			this.searchTarget = this.searchTarget === "tool" ? "plugin" : "tool";
		} else if (this.searchMode && matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
		} else if (!this.searchMode && data === "/") {
			this.searchMode = true;
			this.searchTarget = "tool";
			this.query = "";
		} else if (!this.searchMode && data === "p") {
			this.searchMode = true;
			this.searchTarget = "plugin";
			this.query = "";
		} else if (matchesKey(data, "alt+d") || (!this.searchMode && data === "d")) {
			// Plain "d" opens the panel from the list; alt+d is the spelling that
			// also works while searching, where "d" must stay query text.
			// Detail and keymap share the space under the list: opening one closes
			// the other, otherwise the overlay outgrows a normal terminal.
			this.detailOpen = !this.detailOpen;
			this.detailScroll = 0;
			if (this.detailOpen) this.helpOpen = false;
		} else if (!this.searchMode && data === "f") {
			this.filter =
				this.filter === "all" ? "enabled" : this.filter === "enabled" ? "disabled" : "all";
		} else if (!this.searchMode && data === "o") {
			this.sort =
				this.sort === "name"
					? "count-desc"
					: this.sort === "count-desc"
						? "count-asc"
						: "name";
		} else if (!this.searchMode && data === "?") {
			this.helpOpen = !this.helpOpen;
			if (this.helpOpen) this.detailOpen = false;
		} else if (!this.searchMode && matchesKey(data, "s")) {
			this.scope = this.scope === "session" ? "global" : "session";
			this.savedMessage = `已切换到 ${this.scope} ✓`;
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
		if (rows.length === 0) this.cursor = 0;
		else if (this.cursor >= rows.length) this.cursor = rows.length - 1;
		const kept = rows.findIndex((row) => row.name === before);
		if (kept >= 0) this.cursor = kept;
		this.clampScroll();
		// The detail panel belongs to one row: a new row starts at its top.
		if (this.cursor !== cursorBefore) this.detailScroll = 0;
	}

	/**
	 * Bracketed paste arrives as ESC[200~ … ESC[201~ and may be split over
	 * several chunks. The picker has a single-line query field, so the payload
	 * is flattened to one line and appended to the query — searching for a
	 * pasted name is the only useful thing a paste can do here. Returns true
	 * when the input was paste content and normal key handling must be skipped.
	 */
	private consumePaste(data: string): boolean {
		if (this.pasteBuffer === null && !data.includes(PASTE_START)) return false;
		this.pasteBuffer = (this.pasteBuffer ?? "") + data.split(PASTE_START).join("");
		const end = this.pasteBuffer.indexOf(PASTE_END);
		if (end < 0) return true;
		const payload = this.pasteBuffer.slice(0, end);
		const rest = this.pasteBuffer.slice(end + PASTE_END.length);
		this.pasteBuffer = null;
		const text = payload.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
		if (text) {
			if (!this.searchMode) {
				this.searchMode = true;
				this.searchTarget = "tool";
				this.query = "";
			}
			this.query += text;
			this.savedMessage = null;
			this.cursor = 0;
			this.scrollOffset = 0;
			this.detailScroll = 0;
		}
		// Anything typed after the closing marker is handled normally.
		if (rest) this.handleInput(rest);
		return true;
	}

	/** Move the detail viewport by delta rows, clamped to the rendered content. */
	private scrollDetail(delta: number): void {
		const max = Math.max(0, this.detailLineCount - DETAIL_HEIGHT);
		this.detailScroll = Math.min(max, Math.max(0, this.detailScroll + delta));
	}

	private toggleCurrent(): void {
		const name = this.visibleRows()[this.cursor]?.name;
		if (!name) return;
		if (this.checked.has(name)) this.checked.delete(name);
		else this.checked.add(name);
	}

	private clampScroll(): void {
		const last = this.visibleRows().length - 1;
		if (this.cursor > last) this.cursor = Math.max(0, last);
		if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
		if (this.scrollOffset < 0) this.scrollOffset = 0;
		if (this.cursor >= this.scrollOffset + MAX_VISIBLE_ROWS) {
			this.scrollOffset = this.cursor - MAX_VISIBLE_ROWS + 1;
		}
	}

	/**
	 * Detail block for the highlighted row: full description plus the flattened
	 * parameter list (name, type, required flag, description). Callers clamp it
	 * to DETAIL_HEIGHT so the overlay keeps a constant height while the cursor
	 * moves between rows of different length.
	 */
	private detailLines(row: ToolRow | undefined, width: number): string[] {
		const out: string[] = [];
		out.push(
			this.theme.fg("dim", " " + "─".repeat(Math.max(1, width - 3))),
		);
		if (!row) {
			out.push(this.theme.fg("dim", " (no tool selected)"));
			return out;
		}
		const origin = row.plugin ?? row.source;
		out.push(
			truncateToWidth(
				` ${this.theme.fg("accent", this.theme.bold(row.name))}` +
					this.theme.fg("dim", `  ${origin}${row.exposure ? ` · ${row.exposure}` : ""}`),
				width - 2,
			),
		);
		if (row.usage) {
			out.push(
				truncateToWidth(
					this.theme.fg(
						"dim",
						` used:${row.usage}×${row.usageErrors ? ` · failed:${row.usageErrors}` : ""}` +
							`${row.lastUsed ? ` · last:${row.lastUsed.slice(0, 10)}` : ""}`,
					),
					width - 2,
				),
			);
		}
		const inner = Math.max(20, width - 10);
		const description = row.description?.trim() || "(no description)";
		const descLines = wrapTextWithAnsi(description, inner);
		for (const [index, line] of descLines.entries()) {
			out.push(this.theme.fg("dim", ` ${index === 0 ? "desc:" : "     "} ${line}`));
		}
		const params = describeParameters(row.parameters);
		if (params.length === 0) {
			out.push(this.theme.fg("dim", " params: (none)"));
			return out;
		}
		out.push(this.theme.fg("dim", ` params (${params.length}) — * required:`));
		for (const param of params) {
			const head = `${param.name}${param.required ? "*" : ""}  ${param.type}`;
			out.push(truncateToWidth(`  ${this.theme.fg("accent", head)}`, width - 2));
			if (param.description) {
				for (const line of wrapTextWithAnsi(param.description, inner).slice(0, 2)) {
					out.push(this.theme.fg("dim", `      ${line}`));
				}
			}
		}
		return out;
	}

	/**
	 * detailLines windowed to exactly DETAIL_HEIGHT content rows plus one fixed
	 * hint row: taller content scrolls instead of being lost, and the height stays
	 * constant so the overlay does not resize as the cursor or scroll changes.
	 */
	private detailBlock(row: ToolRow | undefined, width: number): string[] {
		const detail = this.detailLines(row, width);
		this.detailLineCount = detail.length;
		const overflow = detail.length > DETAIL_HEIGHT;
		const maxScroll = Math.max(0, detail.length - DETAIL_HEIGHT);
		this.detailScroll = Math.min(maxScroll, Math.max(0, this.detailScroll));
		const start = overflow ? this.detailScroll : 0;
		const block = detail.slice(start, start + DETAIL_HEIGHT);
		while (block.length < DETAIL_HEIGHT) block.push("");
		const hint =
			overflow && this.detailOpen
				? ` lines ${start + 1}-${start + block.length}/${detail.length} · ↑↓ / PgUp / PgDn scroll`
				: " alt+d closes";
		block.push(this.theme.fg("dim", truncateToWidth(hint, width - 2)));
		return block;
	}

	/**
	 * Keymap panel: bindings grouped into sections, with the action column
	 * aligned. Wide terminals get two columns, otherwise the five groups would
	 * outgrow the overlay; the height only depends on the width, so resizing
	 * does not make the panel jump between keystrokes.
	 */
	private helpBlock(width: number): string[] {
		const inner = Math.max(24, width - 2);
		const format = (section: HelpSection): string[] => {
			const lines = [this.theme.bold(` ${section.title}`)];
			for (const [keys, action] of section.entries) {
				lines.push(
					truncateToWidth(
						`   ${this.theme.fg("accent", keys.padEnd(HELPER_KEY_WIDTH))} ${this.theme.fg("dim", action)}`,
						inner,
					),
				);
			}
			return lines;
		};
		const twoColumns = inner >= HELP_TWO_COLUMN_WIDTH;
		const columns = twoColumns ? [KEYMAP.slice(0, 3), KEYMAP.slice(3)] : [KEYMAP];
		const rendered = columns.map((sections) => sections.flatMap(format));
		const columnWidth = twoColumns
			? Math.floor((inner - HELP_COLUMN_GAP) / 2)
			: inner;
		const height = Math.max(...rendered.map((lines) => lines.length));
		const block = [
			this.theme.fg("dim", truncateToWidth(" keys · ? or esc closes", width - 2)),
		];
		for (let row = 0; row < height; row++) {
			const cells = rendered.map((lines) =>
				truncateToWidth(lines[row] ?? "", columnWidth, "…", true),
			);
			block.push(truncateToWidth(cells.join(" ".repeat(HELP_COLUMN_GAP)), width - 2));
		}
		return block;
	}

	render(width: number): string[] {
		const rows = this.visibleRows();
		const visible = rows.slice(this.scrollOffset, this.scrollOffset + MAX_VISIBLE_ROWS);
		const lines: string[] = [];
		const enabledCount = this.checked.size;

		lines.push("");
		const scopeLabel =
			this.scope === "global"
				? "Tools — GLOBAL selection (new sessions)"
				: "Tools — session selection";
		lines.push(this.theme.fg("accent", this.theme.bold(` ${scopeLabel}`)));
		let status = this.theme.fg("dim", ` ${enabledCount}/${this.rows.length} enabled`);
		const viewLabel = this.filter === "all" ? "all" : this.filter === "enabled" ? "enabled" : "disabled";
		status += this.theme.fg(this.filter === "all" ? "dim" : "accent", `  view:${viewLabel}`);
		if (this.savedMessage) {
			status += this.theme.fg("success", `  ${this.savedMessage}`);
		} else if (this.query) {
			status += this.theme.fg(
				"dim",
				`  search:${this.searchTarget} (${rows.length}/${this.rows.length} match)`,
			);
		} else if (visible.length > 0 && this.rows.length > MAX_VISIBLE_ROWS) {
			status += this.theme.fg(
				"dim",
				`  (showing ${this.scrollOffset + 1}-${this.scrollOffset + visible.length})`,
			);
		}
		lines.push(status);
		if (this.searchMode) {
			lines.push(
				this.theme.fg(
					"accent",
					` /[${this.searchTarget}] ${this.query}█  (tab switches target · esc exits)`,
				),
			);
		} else {
			// Reserve the search line slot so the overlay height never changes.
			lines.push("");
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
			const usageLabel = row.usage
				? this.theme.fg(
						row.usageErrors ? "warning" : "dim",
						` (${row.usage}${row.usageErrors ? `/${row.usageErrors}✗` : ""})`,
					)
				: "";
			lines.push(
				truncateToWidth(`${cursorMark} ${checkbox} ${name}${source}${usageLabel}`, width - 2),
			);
		}
		// Pad the row area to a fixed height so filtering/searching never
		// collapses the overlay (constant height = stable TUI experience).
		for (let i = visible.length; i < MAX_VISIBLE_ROWS; i++) {
			lines.push("");
		}

		if (this.detailOpen) {
			lines.push(...this.detailBlock(rows[this.cursor], width));
		}

		if (this.helpOpen) {
			lines.push(...this.helpBlock(width));
		}

		lines.push("");
		lines.push(
			this.theme.fg(
				"dim",
				truncateToWidth(
					" ↑↓ move · space toggle · d detail · ^s save · esc / alt+q close · ? help",
					width - 2,
				),
			),
		);
		lines.push("");
		return lines;
	}
	invalidate(): void {
		// No cached render state — nothing to invalidate.
	}
}

export default function toolManager(pi: ExtensionAPI) {
	// Enforcement only runs in interactive TUI sessions; RPC/print stay untouched.
	let tuiActive = false;
	let runtimeBaseline: string[] | undefined;
	let sessionDisabled: Set<string> | undefined;
	let globalDisabled: Set<string> | undefined;

	// Set when the tool selection changes; consumed by the cache_warming
	// decision handler to stop one stale warmer cycle.
	let warmStale = false;

	// Usage accounting runs in every mode. A call blocked by the selection never
	// executes, so it carries no durationMs and is skipped here on purpose.
	const usageRecorder = createUsageRecorder();
	pi.on("tool_execution_end", (event) => {
		if (typeof event.durationMs !== "number") return;
		usageRecorder.record(event.toolName, event.isError === true);
	});
	pi.on("turn_end", () => usageRecorder.flush());

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
		// Pre-0.2 config sat next to this extension's data; move it once.
		migrateLegacyConfig();
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
		usageRecorder.flush();
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
	/** `/tools usage` — merged table; `/tools usage clear [all]` — delete files. */
	const handleUsage = (ctx: ExtensionCommandContext, rest: string): void => {
		if (rest === "clear" || rest === "clear all") {
			const all = rest === "clear all";
			const removed = clearUsage(deviceName(), DATA_DIR, all);
			ctx.ui.notify(
				removed > 0
					? `已删除 ${removed} 个用量文件（${all ? "全部设备" : "本设备"}）`
					: "没有可删除的用量文件",
				"info",
			);
			return;
		}
		if (rest) {
			ctx.ui.notify(`未知参数 "${rest}"。用法：/tools usage [clear [all]]`, "warning");
			return;
		}
		ctx.ui.notify(formatUsageTable(readMergedUsage()).join("\n"), "info");
	};

	pi.registerCommand("tools", {
		description:
			"Interactively enable/disable tools (/tools, /tools clear [global], /tools usage)",
		getArgumentCompletions: (argumentPrefix: string) => {
			const p = argumentPrefix.trim().toLowerCase();
			const items = [
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
				{
					value: "usage",
					label: "usage",
					description: "Show merged tool usage across devices",
				},
				{
					value: "usage clear",
					label: "usage clear",
					description: "Delete this device's usage file",
				},
				{
					value: "usage clear all",
					label: "usage clear all",
					description: "Delete every device's usage file",
				},
			];
			const filtered = items.filter((item) => item.value.startsWith(p));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "usage" || trimmed.startsWith("usage ")) {
				handleUsage(ctx, trimmed.slice("usage".length).trim());
				return;
			}
			const isClearGlobal = trimmed === "clear global";
			const isClear = trimmed === "clear" || isClearGlobal;
			if (trimmed && !isClear) {
				ctx.ui.notify(`Unknown argument "${trimmed}". Usage: /tools [clear [global] | usage [clear [all]]]`, "warning");
				return;
			}

			if (isClear) {
				if (isClearGlobal) {
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
					parameters: tool.parameters,
					exposure: tool.exposure,
				}))
				.sort((a, b) => a.name.localeCompare(b.name));
			// Usage is a merged view over every device file, read once per open.
			const usage = readMergedUsage();
			for (const row of rows) {
				const entry = usage.get(row.name);
				if (!entry) continue;
				row.usage = entry.count;
				row.usageErrors = entry.errors;
				row.lastUsed = entry.lastUsed;
			}
			// Per-scope initial checkbox state. The global view falls back to the
			// runtime baseline (not the live active list, which session
			// enforcement has already trimmed) so session state never leaks
			// into what the global file would hold.
			const initialChecked = (scope: "session" | "global"): Set<string> => {
				const disabled = scope === "global" ? globalDisabled : effectiveDisabled();
				return disabled
					? new Set(rows.map((row) => row.name).filter((name) => !disabled.has(name)))
					: new Set([...(runtimeBaseline ?? []), ...pi.getActiveTools()]);
			};


			await ctx.ui.custom<Set<string> | undefined>(
				(tui, theme, keybindings, done) =>
					new ToolManagerPicker(
						theme,
						done,
						rows,
						initialChecked,
						(scope, checked) =>
							applySelection(ctx, scope, rows, checked),
					),
				{ overlay: true },
			);
			},
	});
}
