/**
 * Tool usage accounting for the `/tools` picker.
 *
 * Layout (see docs/adr/0002-tool-manager-data-dir.md):
 *   ~/.pi/agent/tool-manager/tool-manager.json — picker config (disabled tools)
 *   ~/.pi/agent/tool-manager/data/usage-<device>.jsonl — per-device usage records
 *
 * One JSONL line is an aggregated delta, not a single call:
 *   {"v":1,"ts":"<iso>","device":"<device>","tool":"bash","count":12,"errors":1}
 * Reading merges every `usage-*.jsonl` in the data directory by summing
 * `count`/`errors` per exact tool name, so several machines (or a renamed
 * machine, which simply yields another file) contribute to one view.
 *
 * Only executed calls count: a call blocked by the /tools selection never ran,
 * and counting it would pollute the frequency sort.
 *
 * @author mystery4f
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

/** Directory owning both config and usage data. */
export const TOOL_MANAGER_DIR = path.join(PI_AGENT_DIR, "tool-manager");
/** Per-device usage files (`usage-<device>.jsonl`). */
export const DATA_DIR = path.join(TOOL_MANAGER_DIR, "data");
/** Picker config file inside {@link TOOL_MANAGER_DIR}. */
export const CONFIG_FILE = path.join(TOOL_MANAGER_DIR, "tool-manager.json");
/** Pre-0.2 location of the picker config, migrated once then removed. */
export const LEGACY_CONFIG_FILE = path.join(PI_AGENT_DIR, "tool-manager.json");

/** Current usage-record schema version. */
export const USAGE_VERSION = 1;

export type UsageEntry = {
	count: number;
	errors: number;
	/** Latest `ts` seen for this tool across every device file. */
	lastUsed?: string;
};

export type UsageMap = Map<string, UsageEntry>;

/** One parsed JSONL line; every field is optional because files may be edited. */
export type UsageLine = {
	v?: number;
	ts?: string;
	device?: string;
	tool?: string;
	count?: number;
	errors?: number;
};

/**
 * Filename-safe device name: `PI_DEVICE_NAME` when set (WSL/container hosts can
 * collide), otherwise the hostname lowercased with unsafe characters folded to
 * `-`.
 */
export function deviceName(raw: string | undefined = process.env.PI_DEVICE_NAME): string {
	const candidate = raw?.trim() || os.hostname();
	const safe = candidate
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return safe || "unknown";
}

/** Absolute path of one device's usage file. */
export function usageFile(device = deviceName(), dir = DATA_DIR): string {
	return path.join(dir, `usage-${device}.jsonl`);
}

/** Every existing `usage-*.jsonl` file, sorted for deterministic merges. */
export function listUsageFiles(dir = DATA_DIR): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter((name) => name.startsWith("usage-") && name.endsWith(".jsonl"))
			.map((name) => path.join(dir, name))
			.sort();
	} catch {
		return [];
	}
}

/** Parse JSONL text, dropping blank and malformed lines. */
export function parseUsageLines(text: string): UsageLine[] {
	const out: UsageLine[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				out.push(parsed as UsageLine);
			}
		} catch {
			// A truncated tail line from a killed process is expected: skip it.
		}
	}
	return out;
}

function toCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Fold one parsed line into the merged map. */
function foldLine(usage: UsageMap, line: UsageLine): void {
	const tool = typeof line.tool === "string" ? line.tool : "";
	if (!tool) return;
	const count = toCount(line.count);
	const errors = Math.min(toCount(line.errors), count || toCount(line.errors));
	const entry = usage.get(tool) ?? { count: 0, errors: 0 };
	entry.count += count;
	entry.errors += errors;
	if (typeof line.ts === "string" && (!entry.lastUsed || line.ts > entry.lastUsed)) {
		entry.lastUsed = line.ts;
	}
	usage.set(tool, entry);
}

/** Merge the given files by summing per tool name (exact, case-sensitive). */
export function mergeUsageFiles(files: string[]): UsageMap {
	const usage: UsageMap = new Map();
	for (const file of files) {
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of parseUsageLines(text)) foldLine(usage, line);
	}
	return usage;
}

/** Merged view over every device file in the data directory. */
export function readMergedUsage(dir = DATA_DIR): UsageMap {
	return mergeUsageFiles(listUsageFiles(dir));
}

/**
 * Move the pre-0.2 config into the tool-manager directory.
 * Returns true when a migration happened. Never overwrites an existing file.
 */
export function migrateLegacyConfig(
	target = CONFIG_FILE,
	legacy = LEGACY_CONFIG_FILE,
): boolean {
	try {
		if (fs.existsSync(target) || !fs.existsSync(legacy)) return false;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(legacy, target);
		fs.unlinkSync(legacy);
		return true;
	} catch {
		return false;
	}
}

export type UsageRecorder = {
	/** Count one executed call. Blocked/never-run calls must not be recorded. */
	record(tool: string, isError: boolean): void;
	/** Append the accumulated deltas; keeps them queued if the write fails. */
	flush(): void;
	/** Tool names waiting to be written (0 when nothing is pending). */
	pendingCount(): number;
};

export type RecorderOptions = {
	device?: string;
	dir?: string;
	/** Injectable clock so tests get deterministic `ts` values. */
	clock?: () => Date;
};

/**
 * In-memory counter that appends one aggregated line per changed tool.
 * Failed writes keep the batch pending so the next flush retries it.
 */
export function createUsageRecorder(options: RecorderOptions = {}): UsageRecorder {
	const dir = options.dir ?? DATA_DIR;
	const device = options.device ?? deviceName();
	const clock = options.clock ?? (() => new Date());
	let pending = new Map<string, { count: number; errors: number }>();

	return {
		record(tool, isError) {
			if (!tool) return;
			const agg = pending.get(tool) ?? { count: 0, errors: 0 };
			agg.count += 1;
			if (isError) agg.errors += 1;
			pending.set(tool, agg);
		},
		flush() {
			if (pending.size === 0) return;
			const ts = clock().toISOString();
			const batch = pending;
			const lines = [...batch.entries()].map(([tool, agg]) =>
				JSON.stringify({
					v: USAGE_VERSION,
					ts,
					device,
					tool,
					count: agg.count,
					errors: agg.errors,
				}),
			);
			try {
				fs.mkdirSync(dir, { recursive: true });
				fs.appendFileSync(usageFile(device, dir), lines.join("\n") + "\n", "utf8");
				pending = new Map();
			} catch {
				// keep `pending` (and merge nothing new) for the next attempt
			}
		},
		pendingCount: () => pending.size,
	};
}

/** Delete usage files: this device only, or every device. Returns the count. */
export function clearUsage(device = deviceName(), dir = DATA_DIR, all = false): number {
	const targets = all ? listUsageFiles(dir) : [usageFile(device, dir)];
	let removed = 0;
	for (const file of targets) {
		try {
			fs.unlinkSync(file);
			removed += 1;
		} catch {
			// absent already — nothing to remove
		}
	}
	return removed;
}

/** Terminal display width: CJK and fullwidth characters occupy two columns. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		const wide =
			(cp >= 0x1100 && cp <= 0x115f) ||
			(cp >= 0x2e80 && cp <= 0x303e) ||
			(cp >= 0x3041 && cp <= 0x33ff) ||
			(cp >= 0x3400 && cp <= 0x4dbf) ||
			(cp >= 0x4e00 && cp <= 0x9fff) ||
			(cp >= 0xa000 && cp <= 0xa4cf) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe30 && cp <= 0xfe6f) ||
			(cp >= 0xff00 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

function padRight(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function padLeft(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}

/** `YYYY-MM-DD` of an ISO timestamp, or `-` when unusable. */
function shortDate(ts: string | undefined): string {
	if (!ts) return "-";
	const date = ts.slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "-";
}

/**
 * Plain-text table of the merged view, most-used first. Returned as lines so
 * callers can notify or print it without building strings inline.
 */
export function formatUsageTable(usage: UsageMap, limit = 30): string[] {
	const rows = [...usage.entries()]
		.map(([tool, entry]) => ({ tool, ...entry }))
		.sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
	const shown = rows.slice(0, limit);
	const nameWidth = Math.max(8, ...shown.map((row) => displayWidth(row.tool)));
	const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
	const totalErrors = rows.reduce((sum, row) => sum + row.errors, 0);

	const lines: string[] = [];
	lines.push(`工具使用统计 — 全设备合并（${rows.length} 个工具）`);
	lines.push(
		`${padRight("工具", nameWidth)}  ${padLeft("次数", 6)}  ${padLeft("失败", 6)}  最后使用`,
	);
	lines.push("─".repeat(nameWidth + 26));
	for (const row of shown) {
		lines.push(
			`${padRight(row.tool, nameWidth)}  ${padLeft(String(row.count), 6)}  ${padLeft(String(row.errors), 6)}  ${shortDate(row.lastUsed)}`,
		);
	}
	if (rows.length > shown.length) {
		lines.push(`… 另有 ${rows.length - shown.length} 个工具未显示`);
	}
	lines.push("─".repeat(nameWidth + 26));
	lines.push(
		`${padRight("合计", nameWidth)}  ${padLeft(String(totalCount), 6)}  ${padLeft(String(totalErrors), 6)}`,
	);
	return lines;
}
