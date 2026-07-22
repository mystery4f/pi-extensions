/**
 * Extra Context Files Extension
 *
 * Loads additional context files into the system prompt, configured via
 * settings.json at both global and project levels.
 *
 * ── 配置方式 ──
 *
 * 方式一：/extra-files 命令（推荐，交互式管理）
 *   /extra-files            → 主菜单（添加 / 列出编辑 / includes / 重载 / 查看）
 *   /extra-files add        → 添加文件（路径 + 标签 + 全局/项目）
 *   /extra-files list       → 列出并编辑/删除
 *   /extra-files includes   → 管理项目 includes 标签
 *   /extra-files reload     → 重新加载配置
 *   /extra-files show       → 查看当前已加载文件
 *
 * 方式二：手动编辑配置文件
 *
 *   Global settings (~/.pi/agent/settings.json):
 *
 *   {
 *     "extraContext": {
 *       "files": [
 *         { "path": "AGENTS-Java.md", "tags": ["Java"] },
 *         { "path": "AGENTS-frontend.md", "tags": ["frontend"] },
 *         { "path": "AGENTS-general.md" }
 *       ],
 *       "includes": ["Java"]
 *     }
 *   }
 *
 *   Project settings (.pi/settings.json):
 *
 *   {
 *     "extraContext": {
 *       "files": [...],
 *       "includes": ["Java"]
 *     }
 *   }
 *
 *   - "files": array of file entries (string path or { path, tags? })
 *   - "includes": string array — declares which tags are needed
 *   - "tags": string array — only loaded when includes contains a matching tag
 *   - No tags = always loaded (unconditional)
 *   - Global paths resolve relative to ~/.pi/agent; project paths relative to cwd
 *
 *   Absolute paths and ~ are supported.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

// ── 路径常量 ─────────────────────────────────────────────────────

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");

// ── 类型 ───────────────────────────────────────────────────────

interface ExtraFile {
	displayPath: string;
	content: string;
}

type FileEntry = string | { path: string; tags?: string[] };

interface ExtraContextConfig {
	files?: FileEntry[];
	includes?: string[];
}

type EntryOrigin = "global" | "project";

interface ConfiguredEntry {
	filePath: string;
	tags: string[];
	origin: EntryOrigin;
	/** Whether it is actually loaded under the current project includes. */
	loaded: boolean;
}

// ── 读取 ───────────────────────────────────────────────────────

function readJSON(filePath: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function getExtraContext(raw: Record<string, unknown> | null): ExtraContextConfig {
	if (!raw || typeof raw.extraContext !== "object" || !raw.extraContext) return {};
	return raw.extraContext as ExtraContextConfig;
}

function resolveFilePath(filePath: string, baseDir: string): string {
	if (filePath.startsWith("~")) {
		return path.join(os.homedir(), filePath.slice(1));
	}
	return path.resolve(baseDir, filePath);
}

function normalizeFileEntry(entry: FileEntry): { filePath: string; tags: string[] } {
	if (typeof entry === "string") {
		return { filePath: entry, tags: [] };
	}
	return { filePath: entry.path, tags: entry.tags ?? [] };
}

/** String ↔ object symmetric serialization: empty tags collapses to a bare string. */
function serializeFileEntry(filePath: string, tags: string[]): FileEntry {
	if (tags.length === 0) return filePath;
	return { path: filePath, tags };
}

function findEntryIndex(files: FileEntry[], filePath: string): number {
	return files.findIndex((e) => normalizeFileEntry(e).filePath === filePath);
}

/**
 * Check if a file's tags match the project's includes.
 * Files with no tags are always loaded.
 */
function matches(tags: string[], includes: Set<string>): boolean {
	if (tags.length === 0) return true;
	return tags.some((tag) => includes.has(tag));
}

/**
 * Read extraContextFiles from a settings.json file.
 * Optionally filters by the project's extraContextIncludes.
 */
function loadFromSettings(
	settingsPath: string,
	baseDir: string,
	seen: Set<string>,
	includes?: Set<string>,
): ExtraFile[] {
	const results: ExtraFile[] = [];
	const raw = readJSON(settingsPath);
	const ctx = getExtraContext(raw);
	if (!Array.isArray(ctx.files)) return results;

	for (const entry of ctx.files as FileEntry[]) {
		const { filePath, tags } = normalizeFileEntry(entry);

		// Filter by includes (only for global settings)
		if (includes !== undefined && !matches(tags, includes)) continue;

		const resolved = resolveFilePath(filePath, baseDir);
		if (seen.has(resolved)) continue;

		try {
			const content = fs.readFileSync(resolved, "utf-8");
			seen.add(resolved);
			results.push({ displayPath: filePath, content });
		} catch {
			// skip unreadable files
		}
	}

	return results;
}

/**
 * Collect extra context files from both global and project settings.
 */
function collectExtraFiles(cwd: string): ExtraFile[] {
	const results: ExtraFile[] = [];
	const seen = new Set<string>();

	// Read project includes first (needed to filter global files)
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	const projectRaw = readJSON(projectSettingsPath);
	const projectCtx = getExtraContext(projectRaw);
	const includes = new Set<string>(
		Array.isArray(projectCtx.includes) ? projectCtx.includes : [],
	);

	// 1. Global settings: ~/.pi/agent/settings.json (resolve relative to ~/.pi/agent)
	const globalBase = AGENT_DIR;
	for (const f of loadFromSettings(SETTINGS_PATH, globalBase, seen, includes)) {
		results.push(f);
	}

	// 2. Project settings: .pi/settings.json (resolve relative to cwd, no tag filtering)
	for (const f of loadFromSettings(projectSettingsPath, cwd, seen)) {
		results.push(f);
	}

	return results;
}

/** All configured entries across global + project, with loaded state under current includes. */
function collectConfiguredEntries(cwd: string): ConfiguredEntry[] {
	const result: ConfiguredEntry[] = [];

	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	const projectCtx = getExtraContext(readJSON(projectSettingsPath));
	const includes = new Set<string>(
		Array.isArray(projectCtx.includes) ? projectCtx.includes : [],
	);

	const globalCtx = getExtraContext(readJSON(SETTINGS_PATH));
	if (Array.isArray(globalCtx.files)) {
		for (const entry of globalCtx.files as FileEntry[]) {
			const { filePath, tags } = normalizeFileEntry(entry);
			result.push({ filePath, tags, origin: "global", loaded: matches(tags, includes) });
		}
	}
	if (Array.isArray(projectCtx.files)) {
		for (const entry of projectCtx.files as FileEntry[]) {
			const { filePath, tags } = normalizeFileEntry(entry);
			result.push({ filePath, tags, origin: "project", loaded: true });
		}
	}

	return result;
}

// ── 写入 ───────────────────────────────────────────────────────

function readSettingsForWrite(settingsPath: string): Record<string, any> | null {
	if (!fs.existsSync(settingsPath)) return {};
	try {
		return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	} catch {
		return null; // parse failure — refuse to clobber
	}
}

function writeSettings(settingsPath: string, settings: Record<string, any>): boolean {
	const dir = path.dirname(settingsPath);
	if (!fs.existsSync(dir)) {
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch {
			return false;
		}
	}
	try {
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
		return true;
	} catch {
		return false;
	}
}

function ensureExtraContext(settings: Record<string, any>): ExtraContextConfig {
	if (!settings.extraContext || typeof settings.extraContext !== "object") {
		settings.extraContext = {};
	}
	if (!Array.isArray(settings.extraContext.files)) {
		settings.extraContext.files = [];
	}
	return settings.extraContext as ExtraContextConfig;
}

function saveFileToSettings(settingsPath: string, entry: FileEntry): boolean {
	const settings = readSettingsForWrite(settingsPath);
	if (settings === null) return false;
	const ctx = ensureExtraContext(settings);
	const { filePath, tags } = normalizeFileEntry(entry);
	const idx = findEntryIndex(ctx.files as FileEntry[], filePath);
	const serialized = serializeFileEntry(filePath, tags);
	if (idx >= 0) {
		(ctx.files as FileEntry[])[idx] = serialized;
	} else {
		(ctx.files as FileEntry[]).push(serialized);
	}
	return writeSettings(settingsPath, settings);
}

function removeFileFromSettings(settingsPath: string, filePath: string): boolean {
	const settings = readSettingsForWrite(settingsPath);
	if (settings === null) return false;
	const ctx = ensureExtraContext(settings);
	const before = (ctx.files as FileEntry[]).length;
	ctx.files = (ctx.files as FileEntry[]).filter(
		(e) => normalizeFileEntry(e).filePath !== filePath,
	);
	if ((ctx.files as FileEntry[]).length === before) return false;
	return writeSettings(settingsPath, settings);
}

function setIncludesInSettings(settingsPath: string, includes: string[]): boolean {
	const settings = readSettingsForWrite(settingsPath);
	if (settings === null) return false;
	ensureExtraContext(settings);
	settings.extraContext.includes = includes;
	return writeSettings(settingsPath, settings);
}

function settingsPathFor(ctx: ExtensionCommandContext, origin: EntryOrigin): string {
	return origin === "project"
		? path.join(ctx.cwd, ".pi", "settings.json")
		: SETTINGS_PATH;
}

// ── 主扩展 ─────────────────────────────────────────────────────

export default function extraAgentsFilesExtension(pi: ExtensionAPI) {
	let extraFiles: ExtraFile[] = [];

	pi.on("session_start", async (_event, ctx) => {
		extraFiles = collectExtraFiles(ctx.cwd);
	});

	pi.on("before_agent_start", async (event) => {
		if (extraFiles.length === 0) return;

		const sections = extraFiles
			.map((f) => `# ${f.displayPath}\n\n${f.content}`)
			.join("\n");

		return {
			systemPrompt: event.systemPrompt + `\n${sections}`,
		};
	});

	// ── /extra-files 交互式命令 ─────────────────────────────
	//
	// 用法：
	//   /extra-files            → 主菜单
	//   /extra-files add        → 添加文件
	//   /extra-files list       → 列出/编辑/删除
	//   /extra-files includes   → 管理项目 includes 标签
	//   /extra-files reload     → 重载配置
	//   /extra-files show       → 查看当前已加载

	pi.registerCommand("extra-files", {
		description: "管理 extra context files（添加/编辑/删除/includes/重载）",
		getArgumentCompletions: (prefix: string) => {
			const subs = [
				{ label: "add", desc: "添加文件" },
				{ label: "list", desc: "列出/编辑" },
				{ label: "includes", desc: "管理标签" },
				{ label: "reload", desc: "重载" },
				{ label: "show", desc: "查看已加载" },
			];
			const matched = subs.filter((s) => s.label.startsWith(prefix));
			return matched.length > 0
				? matched.map((s) => ({ value: s.label, label: s.label, description: s.desc }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || "";

			if (sub === "reload") { cmdReload(ctx); return; }
			if (sub === "add") { await cmdAdd(ctx); return; }
			if (sub === "list" || sub === "ls") { await cmdList(ctx); return; }
			if (sub === "includes" || sub === "inc") { await cmdIncludes(ctx); return; }
			if (sub === "show") { cmdShow(ctx); return; }

			// 无参数 → 主菜单
			const action = await ctx.ui.select("extra-files 管理", [
				"➕ 添加文件",
				"📋 列出/编辑",
				"🏷️ 管理 includes 标签",
				"🔄 重新加载",
				"👁️ 查看已加载",
			]);
			if (!action) return;
			if (action.startsWith("➕")) await cmdAdd(ctx);
			else if (action.startsWith("📋")) await cmdList(ctx);
			else if (action.startsWith("🏷️")) await cmdIncludes(ctx);
			else if (action.startsWith("🔄")) cmdReload(ctx);
			else cmdShow(ctx);
		},
	});

	function reload(cwd: string) {
		extraFiles = collectExtraFiles(cwd);
	}

	// ── 添加文件 ──

	async function cmdAdd(ctx: ExtensionCommandContext) {
		const pathInput = await ctx.ui.input(
			"文件路径",
			"如 AGENTS-Java.md（全局相对 ~/.pi/agent，项目相对项目根）",
		);
		if (!pathInput?.trim()) { ctx.ui.notify("[extra-files] 已取消", "info"); return; }
		const filePath = pathInput.trim();

		const tagInput = await ctx.ui.input(
			"标签（逗号分隔，留空=无条件加载）",
			"如 Java,backend",
		);
		const tags = tagInput?.trim()
			? tagInput.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
			: [];

		const scope = await ctx.ui.select("保存位置", ["🌐 全局 (~/.pi/agent)", "📁 当前项目"]);
		if (!scope) { ctx.ui.notify("[extra-files] 已取消", "info"); return; }
		const origin: EntryOrigin = scope.startsWith("📁") ? "project" : "global";
		const settingsPath = settingsPathFor(ctx, origin);

		if (!saveFileToSettings(settingsPath, serializeFileEntry(filePath, tags))) {
			ctx.ui.notify("[extra-files] ❌ 写入失败（配置文件解析失败？）", "error");
			return;
		}

		const base = origin === "project" ? ctx.cwd : AGENT_DIR;
		const exists = fs.existsSync(resolveFilePath(filePath, base));
		reload(ctx.cwd);

		ctx.ui.notify(
			`[extra-files] ✅ 已添加（${origin === "project" ? "📁项目" : "🌐全局"}${exists ? "" : " ⚠️文件不存在"}）\n` +
			`   ${filePath}${tags.length ? ` [${tags.join(",")}]` : ""} — 当前加载 ${extraFiles.length} 个文件`,
			exists ? "info" : "warning",
		);
	}

	// ── 列出 + 编辑/删除 ──

	async function cmdList(ctx: ExtensionCommandContext) {
		const entries = collectConfiguredEntries(ctx.cwd);
		if (entries.length === 0) {
			ctx.ui.notify("[extra-files] 当前没有配置任何文件，用 /extra-files add 添加", "info");
			return;
		}

		const options = entries.map((e, i) => {
			const origin = e.origin === "project" ? "📁" : "🌐";
			const status = e.loaded ? "✅" : "⏸️";
			const tag = e.tags.length ? `[${e.tags.join(",")}]` : "(无条件)";
			return `[${i + 1}] ${origin} ${status} ${e.filePath} ${tag}`;
		});
		options.push("← 返回");

		const selected = await ctx.ui.select(
			`extra-files（${entries.length} 项，✅已加载 / ⏸️被 includes 过滤）— 选择编辑`,
			options,
		);
		if (!selected || selected.startsWith("←")) return;

		const m = selected.match(/^\[(\d+)\]/);
		const idx = m ? parseInt(m[1], 10) - 1 : -1;
		if (idx < 0 || idx >= entries.length) return;

		await editEntry(ctx, entries[idx]);
	}

	async function editEntry(ctx: ExtensionCommandContext, initial: ConfiguredEntry) {
		let cur = initial;

		while (true) {
			const base = cur.origin === "project" ? ctx.cwd : AGENT_DIR;
			const exists = fs.existsSync(resolveFilePath(cur.filePath, base));
			const tagD = cur.tags.length ? cur.tags.join(", ") : "(无条件)";
			const origin = cur.origin === "project" ? "📁项目" : "🌐全局";

			const action = await ctx.ui.select(
				`${cur.filePath} ${exists ? "✅" : "❌不存在"} ${origin}\n  tags: ${tagD}`,
				[
					`✏️ 路径: ${cur.filePath}`,
					`🏷️ 标签: ${tagD}`,
					"🗑️ 删除此文件",
					"← 返回",
				],
			);
			if (!action || action.startsWith("←")) return;

			// 删除
			if (action.startsWith("🗑️")) {
				const confirmed = await ctx.ui.confirm("确认删除", `${cur.filePath}\n(${origin})`);
				if (!confirmed) continue;
				removeFileFromSettings(settingsPathFor(ctx, cur.origin), cur.filePath);
				reload(ctx.cwd);
				ctx.ui.notify(`[extra-files] ✅ 已删除（当前加载 ${extraFiles.length} 个）`, "info");
				return;
			}

			// 编辑字段
			const field: "path" | "tags" = action.startsWith("✏️") ? "path" : "tags";
			const hint = field === "path"
				? "当前: " + cur.filePath
				: cur.tags.length ? "当前: " + cur.tags.join(", ") : "当前: (无条件)";
			const inputVal = await ctx.ui.input(
				field === "path" ? "输入新文件路径" : "输入新标签（逗号分隔，留空=无条件）",
				hint,
			);
			// 空输入 → 保留原值，回到菜单
			if (inputVal === undefined || inputVal.trim() === "") continue;

			const newTags = field === "tags"
				? inputVal.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
				: cur.tags;
			const newPath = field === "path" ? inputVal.trim() : cur.filePath;

			const sp = settingsPathFor(ctx, cur.origin);
			// 改路径时先删旧条目，避免残留
			if (field === "path" && newPath !== cur.filePath) {
				removeFileFromSettings(sp, cur.filePath);
			}
			saveFileToSettings(sp, serializeFileEntry(newPath, newTags));

			reload(ctx.cwd);
			cur = { ...cur, filePath: newPath, tags: newTags };
			ctx.ui.notify("[extra-files] ✅ 已更新", "info");
		}
	}

	// ── 管理 includes 标签（项目级） ──

	async function cmdIncludes(ctx: ExtensionCommandContext) {
		const projectSettingsPath = settingsPathFor(ctx, "project");
		const projectCtx = getExtraContext(readJSON(projectSettingsPath));
		const currentIncludes = Array.isArray(projectCtx.includes) ? projectCtx.includes : [];

		// 扫描全局配置里所有可用标签
		const globalCtx = getExtraContext(readJSON(SETTINGS_PATH));
		const allTags = new Set<string>();
		if (Array.isArray(globalCtx.files)) {
			for (const entry of globalCtx.files as FileEntry[]) {
				for (const t of normalizeFileEntry(entry).tags) allTags.add(t);
			}
		}

		const availStr = allTags.size ? [...allTags].join(", ") : "(全局未配置任何带标签的文件)";
		const curStr = currentIncludes.length ? currentIncludes.join(", ") : "(空 — 仅无条件文件加载)";

		const action = await ctx.ui.select(
			`项目 includes 标签（控制全局带标签文件的加载）\n  当前: ${curStr}\n  可用标签: ${availStr}`,
			[
				"✏️ 设置 includes（输入）",
				...allTags.size ? ["➕ 全选所有可用标签"] : [],
				"🧹 清空 includes（仅加载无条件文件）",
				"← 返回",
			],
		);
		if (!action || action.startsWith("←")) return;

		let newIncludes: string[];

		if (action.startsWith("➕")) {
			newIncludes = [...allTags];
		} else if (action.startsWith("🧹")) {
			newIncludes = [];
		} else {
			const input = await ctx.ui.input(
				"输入 includes 标签（逗号分隔）",
				`当前: ${curStr}\n可用: ${availStr}`,
			);
			if (!input?.trim()) { ctx.ui.notify("[extra-files] 已取消", "info"); return; }
			newIncludes = input.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
		}

		setIncludesInSettings(projectSettingsPath, newIncludes);
		reload(ctx.cwd);
		ctx.ui.notify(
			`[extra-files] ✅ includes = [${newIncludes.join(", ")}]（当前加载 ${extraFiles.length} 个文件）`,
			"info",
		);
	}

	// ── 重载 ──

	function cmdReload(ctx: ExtensionCommandContext) {
		reload(ctx.cwd);
		ctx.ui.notify(`[extra-files] 🔄 已重载（${extraFiles.length} 个文件）`, "info");
	}

	// ── 查看已加载 ──

	function cmdShow(ctx: ExtensionCommandContext) {
		if (extraFiles.length === 0) {
			ctx.ui.notify("[extra-files] 当前未加载任何文件", "info");
			return;
		}
		ctx.ui.notify(
			`[extra-files] 已加载 ${extraFiles.length} 个:\n${extraFiles.map((f) => `  • ${f.displayPath}`).join("\n")}`,
			"info",
		);
	}
}