/**
 * Auto Add Directory Extension
 *
 * 当用户提及特定关键词时，提醒 LLM 将对应目录加入会话。
 *
 * 机制（单一通道，sendMessage nextTurn 投递，样式对齐 @zosmaai/pi-llm-wiki notices）:
 *   1. session_start：无条件规则（keywords 为空）直接进入待提醒队列
 *   2. input：关键词命中新目录，或待提醒队列非空
 *      → sendMessage 发送一条提醒（display:true，nextTurn），要求 LLM 先调用 add_directory
 *   3. 不注入系统提示词，不预读 AGENTS.md/CLAUDE.md
 *      （add_directory 由 pi 原生加载目录上下文，无需保底副本）
 *
 * 分层：
 *   Layer 1 配置 — 规则解析/存储（${VAR} 占位符、basePath、全局+项目合并）
 *   Layer 2 发现 — 关键词匹配 + 待提醒队列
 *   Layer 3 事件 — session_start / input 接线
 *   Layer 4 命令 — /auto-add-dir 交互式管理
 *
 * ── 配置方式 ──
 *
 * 方式一：/auto-add-dir 命令（推荐，交互式管理）
 *   /auto-add-dir            → 主菜单（添加 / 列出编辑 / 重载）
 *   /auto-add-dir add        → 直接添加
 *   /auto-add-dir list       → 列出并编辑
 *   /auto-add-dir reload     → 重新加载配置
 *
 * 方式二：手动编辑配置文件
 *   全局: ~/.pi/agent/settings.json → "autoAddDir" 字段
 *   项目: .pi/settings.json → "autoAddDir" 字段（与全局合并，同 dir 时项目优先）
 *
 * 环境变量: ~/.pi/agent/env.json
 * 无条件规则: keywords 省略或设为空数组 [] 时，session_start 即自动触发
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

// ── 日志 ───────────────────────────────────────────────────────
const LOG_FILE = path.join(
	process.env.TEMP || process.env.TMP || "/tmp",
	"auto-add-dir.log",
);
function log(msg: string) {
	const ts = new Date().toISOString();
	fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

function getExtDir(): string {
	if (typeof (__dirname as any) === "string") return __dirname as string;
	if (typeof (import.meta as any).dirname === "string")
		return (import.meta as any).dirname;
	try {
		return path
			.dirname(new URL(import.meta.url).pathname)
			.replace(/^\/([A-Z]:)/, "$1");
	} catch {
		return process.cwd();
	}
}
const EXT_DIR = getExtDir();

const AGENT_DIR = path.join(
	process.env.USERPROFILE || process.env.HOME || "~",
	".pi/agent",
);
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");

// ═══════════════════════════════════════════════════════════════
// Layer 1 配置 — 类型 / 环境变量 / 读取 / 写入
// ═══════════════════════════════════════════════════════════════

// ── 类型 ──

interface Rule {
	keywords?: string[];
	dir: string;
	description: string;
}

interface Config {
	basePath?: string;
	rules: Rule[];
}

type RuleOrigin = "global" | "project";

interface ResolvedRule {
	keywords: string[];
	dir: string;
	dirSource: string;
	description: string;
	origin: RuleOrigin;
}

// ── 环境变量解析 ──

const ENV_JSON_PATH = path.join(AGENT_DIR, "env.json");

function loadEnvJson(): Record<string, string> {
	try {
		if (!fs.existsSync(ENV_JSON_PATH)) return {};
		return JSON.parse(fs.readFileSync(ENV_JSON_PATH, "utf-8").trim());
	} catch (e) {
		log(`loadEnvJson: FAILED ${e}`);
		return {};
	}
}

function resolveVar(
	name: string,
	envJson: Record<string, string>,
): string | undefined {
	return envJson[name] ?? process.env[name];
}

function resolveDir(
	rawDir: string,
	envJson: Record<string, string>,
	basePath?: string,
): { dir: string; source: string } | null {
	const varPattern = /\$\{([^}]+)\}/g;
	const placeholders: Array<{ full: string; name: string }> = [];
	let m: RegExpExecArray | null;
	while ((m = varPattern.exec(rawDir)) !== null) {
		placeholders.push({ full: m[0], name: m[1] });
	}

	let dir = rawDir;
	for (const { full, name } of placeholders) {
		const value = resolveVar(name, envJson);
		if (value === undefined) {
			log(`resolveDir: UNRESOLVED \${${name}} in "${rawDir}"`);
			return null;
		}
		dir = dir.replace(full, value);
	}

	dir = dir.replace(/\//g, path.sep);

	if (path.isAbsolute(dir)) return { dir, source: rawDir };

	if (basePath) {
		const resolved = path.join(basePath, dir);
		log(`resolveDir: "${rawDir}" + "${basePath}" → "${resolved}"`);
		return { dir: resolved, source: rawDir };
	}

	log(`resolveDir: relative "${rawDir}" but no basePath`);
	return null;
}

// ── Config 读取 ──

interface ResolvedConfig {
	rules: ResolvedRule[];
}

function parseRulesFromSettings(
	settingsPath: string,
	envJson: Record<string, string>,
	globalBasePath?: string,
	origin?: RuleOrigin,
): ResolvedRule[] {
	try {
		if (!fs.existsSync(settingsPath)) {
			log(`loadConfig: ${settingsPath} not found`);
			return [];
		}

		const settings = JSON.parse(
			fs.readFileSync(settingsPath, "utf-8"),
		) as Record<string, any>;

		const cfg = settings.autoAddDir as Config | undefined;
		if (!cfg || !cfg.rules || cfg.rules.length === 0) {
			return [];
		}

		const effectiveBasePath = cfg.basePath
			? resolveDir(cfg.basePath, envJson)?.dir
			: globalBasePath;

		const rules: ResolvedRule[] = [];
		for (const rule of cfg.rules) {
			const result = resolveDir(rule.dir, envJson, effectiveBasePath);
			if (result) {
				rules.push({
					keywords: rule.keywords ?? [],
					dir: result.dir,
					dirSource: result.source,
					description: rule.description,
					origin: origin ?? "global",
				});
			} else {
				log(`loadConfig: SKIPPED "${rule.dir}" from ${settingsPath}`);
			}
		}

		log(`loadConfig: ${rules.length} rule(s) from ${settingsPath}`);
		return rules;
	} catch (e) {
		log(`loadConfig: FAILED ${settingsPath} — ${e}`);
		return [];
	}
}

function loadConfig(cwd?: string): ResolvedConfig {
	const envJson = loadEnvJson();

	const globalRules = parseRulesFromSettings(SETTINGS_PATH, envJson, undefined, "global");

	let globalBasePath: string | undefined;
	try {
		if (fs.existsSync(SETTINGS_PATH)) {
			const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, any>;
			const cfg = settings.autoAddDir as Config | undefined;
			if (cfg?.basePath) {
				globalBasePath = resolveDir(cfg.basePath, envJson)?.dir;
			}
		}
	} catch {}

	let projectRules: ResolvedRule[] = [];
	if (cwd) {
		const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
		projectRules = parseRulesFromSettings(projectSettingsPath, envJson, globalBasePath, "project");
	}

	const rulesMap = new Map<string, ResolvedRule>();
	for (const r of globalRules) rulesMap.set(r.dir, r);
	for (const r of projectRules) rulesMap.set(r.dir, r);

	const rules = [...rulesMap.values()];
	log(`loadConfig: total ${rules.length} rule(s) (global=${globalRules.length}, project=${projectRules.length})`);
	return { rules };
}

// ── Config 写入 ──

function saveRuleToSettings(settingsPath: string, rule: Rule): boolean {
	let settings: Record<string, any> = {};

	if (fs.existsSync(settingsPath)) {
		try {
			settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		} catch (e) {
			log(`saveRule: FAILED to parse existing ${settingsPath} — ${e}`);
			return false;
		}
	}

	if (!settings.autoAddDir) settings.autoAddDir = {};
	if (!Array.isArray(settings.autoAddDir.rules)) settings.autoAddDir.rules = [];

	const idx = settings.autoAddDir.rules.findIndex(
		(r: any) => r.dir === rule.dir,
	);
	if (idx >= 0) {
		settings.autoAddDir.rules[idx] = rule;
		log(`saveRule: updated existing rule for "${rule.dir}"`);
	} else {
		settings.autoAddDir.rules.push(rule);
		log(`saveRule: added new rule for "${rule.dir}"`);
	}

	const dir = path.dirname(settingsPath);
	if (!fs.existsSync(dir)) {
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch (e) {
			log(`saveRule: FAILED to create dir "${dir}" — ${e}`);
			return false;
		}
	}

	try {
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
		log(`saveRule: wrote to ${settingsPath}`);
		return true;
	} catch (e) {
		log(`saveRule: FAILED to write ${settingsPath} — ${e}`);
		return false;
	}
}

function removeRuleFromSettings(settingsPath: string, dirSource: string): boolean {
	if (!fs.existsSync(settingsPath)) return false;

	let settings: Record<string, any>;
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	} catch {
		return false;
	}

	const rules = settings.autoAddDir?.rules;
	if (!Array.isArray(rules)) return false;

	const before = rules.length;
	settings.autoAddDir.rules = rules.filter(
		(r: any) => r.dir !== dirSource,
	);

	if (settings.autoAddDir.rules.length === before) return false;

	try {
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
		log(`removeRule: removed "${dirSource}" from ${settingsPath}`);
		return true;
	} catch (e) {
		log(`removeRule: FAILED to write ${settingsPath} — ${e}`);
		return false;
	}
}

// ═══════════════════════════════════════════════════════════════
// Layer 2 发现 — 关键词匹配 + 待提醒队列
// ═══════════════════════════════════════════════════════════════

function matchRule(text: string, rule: ResolvedRule): boolean {
	if (rule.keywords.length === 0) return true;
	const lower = text.toLowerCase();
	return rule.keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function buildReminder(dirs: ResolvedRule[]): string {
	const list = dirs
		.map((r) => `\`${r.dir}\` — ${r.description}`)
		.join("; ");
	return (
		`**auto-add-dir reminder:** Discovered ${dirs.length} new director${dirs.length > 1 ? "ies" : "y"}` +
		` (${list}). Before answering, you MUST call \`add_directory\` for each of them — ` +
		"this loads skills, search capabilities, and context files that you need. " +
		"Do not skip this step."
	);
}

// ═══════════════════════════════════════════════════════════════
// Layer 3 事件 — session_start / input 接线
// ═══════════════════════════════════════════════════════════════

export default function autoAddDirExtension(pi: ExtensionAPI) {
	log(`=== extension loading === EXT_DIR=${EXT_DIR}`);
	let config = loadConfig();
	/** 已发现目录（dir → rule），本 session 内每目录只提醒一次 */
	const discoveredDirs = new Map<string, ResolvedRule>();
	/** 已发现但提醒尚未随用户消息投递的目录 */
	const pendingReminder = new Set<string>();

	/** 登记一个已发现目录；返回 false 表示已登记过或目录不存在 */
	function discoverRule(rule: ResolvedRule): boolean {
		if (discoveredDirs.has(rule.dir) || !fs.existsSync(rule.dir)) return false;
		discoveredDirs.set(rule.dir, rule);
		pendingReminder.add(rule.dir);
		log(`discover: "${rule.description}" → ${rule.dir}`);
		return true;
	}

	/** 无条件规则（keywords 为空）session_start 即发现 */
	function discoverUnconditional() {
		for (const rule of config.rules) {
			if (rule.keywords.length === 0) discoverRule(rule);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		discoveredDirs.clear();
		pendingReminder.clear();
		config = loadConfig(ctx.cwd);
		discoverUnconditional();

		const uncond = config.rules.filter((r) => r.keywords.length === 0).length;
		ctx.ui.notify(
			`[auto-add-dir] ${config.rules.length} rule(s) (${uncond} unconditional, ${config.rules.length - uncond} keyword)`,
			"info",
		);
	});

	pi.on("input", async (event, _ctx) => {
		if (event.source === "extension") return { action: "continue" };

		log(`input: "${event.text.slice(0, 80)}"`);

		for (const rule of config.rules) {
			if (matchRule(event.text, rule)) discoverRule(rule);
		}

		if (pendingReminder.size === 0) return { action: "continue" };

		const dirs = [...pendingReminder]
			.map((dir) => discoveredDirs.get(dir))
			.filter((r): r is ResolvedRule => !!r);
		pendingReminder.clear();
		log(`input: reminder for ${dirs.length} dir(s) via sendMessage(nextTurn)`);
		pi.sendMessage(
			{
				customType: "auto-add-dir-reminder",
				content: buildReminder(dirs),
				display: true,
			},
			{ deliverAs: "nextTurn" },
		);
		return { action: "continue" };
	});

	// ═══════════════════════════════════════════════════════════
	// Layer 4 命令 — /auto-add-dir 交互式管理
	//
	// 用法：
	//   /auto-add-dir          → 主菜单
	//   /auto-add-dir add      → 直接添加
	//   /auto-add-dir list     → 列出并编辑
	//   /auto-add-dir reload   → 重载
	//
	// 设计原则：最小化交互步骤，编辑/添加无需 confirm，直接保存。
	// ═══════════════════════════════════════════════════════════

	pi.registerCommand("auto-add-dir", {
		description: "管理 auto-add-dir 规则（交互式添加/编辑/删除）",
		getArgumentCompletions: (prefix: string) => {
			const subs = [
				{ label: "add", desc: "添加新规则" },
				{ label: "list", desc: "列出并编辑规则" },
				{ label: "reload", desc: "重新加载配置" },
			];
			const matches = subs.filter((s) => s.label.startsWith(prefix));
			return matches.length > 0
				? matches.map((s) => ({ value: s.label, label: s.label, description: s.desc }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const subCmd = args.trim().split(/\s+/)[0]?.toLowerCase() || "";

			if (subCmd === "reload") { cmdReload(ctx); return; }
			if (subCmd === "add") { await cmdAdd(ctx); return; }
			if (subCmd === "list" || subCmd === "ls") { await cmdList(ctx); return; }

			// 无参数 → 主菜单
			const action = await ctx.ui.select("auto-add-dir 管理", [
				"➕ 添加规则",
				"📋 列出/编辑规则",
				"🔄 重新加载",
			]);
			if (!action) return;
			if (action.startsWith("➕")) await cmdAdd(ctx);
			else if (action.startsWith("📋")) await cmdList(ctx);
			else cmdReload(ctx);
		},
	});

	// ── 添加规则（无 confirm，input 完直接保存） ──

	async function cmdAdd(ctx: ExtensionCommandContext) {
		const dirInput = await ctx.ui.input("目录路径", "D:\\code\\my-project 或 ${ENV_VAR}/subdir");
		if (!dirInput?.trim()) { ctx.ui.notify("[auto-add-dir] 已取消", "info"); return; }
		const dir = dirInput.trim();

		const descInput = await ctx.ui.input("规则描述", "用途说明，如「Obsidian 笔记库」");
		if (!descInput?.trim()) { ctx.ui.notify("[auto-add-dir] 描述不能为空", "warning"); return; }
		const description = descInput.trim();

		const kwInput = await ctx.ui.input("关键词（逗号分隔，留空=无条件匹配）", "如 obsidian,vault,笔记");
		const keywords = kwInput?.trim()
			? kwInput.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
			: [];

		const scope = await ctx.ui.select("保存位置", ["🌐 全局", "📁 当前项目"]);
		if (!scope) { ctx.ui.notify("[auto-add-dir] 已取消", "info"); return; }
		const isProject = scope.startsWith("📁");
		const settingsPath = isProject
			? path.join(ctx.cwd, ".pi", "settings.json")
			: SETTINGS_PATH;

		const rule: Rule = { dir, description };
		if (keywords.length > 0) rule.keywords = keywords;

		if (!saveRuleToSettings(settingsPath, rule)) {
			ctx.ui.notify("[auto-add-dir] ❌ 写入失败", "error");
			return;
		}

		config = loadConfig(ctx.cwd);
		ctx.ui.notify(
			`[auto-add-dir] ✅ 已添加（${isProject ? "📁项目" : "🌐全局"}，共 ${config.rules.length} 条）\n` +
			`   ${dir} — ${description}`,
			"info",
		);
	}

	// ── 列出 + 编辑（select 规则 → 操作菜单，循环可改多个字段） ──

	async function cmdList(ctx: ExtensionCommandContext) {
		if (config.rules.length === 0) {
			ctx.ui.notify("[auto-add-dir] 当前没有任何规则", "info");
			return;
		}

		const options = config.rules.map((r, i) => {
			const exists = fs.existsSync(r.dir) ? "✅" : "❌";
			const originIcon = r.origin === "project" ? "📁" : "🌐";
			const kw = r.keywords.length ? r.keywords.join(",") : "无条件";
			return `[${i + 1}] ${originIcon} ${exists} ${r.description} — ${kw}`;
		});
		options.push("← 返回");

		const selected = await ctx.ui.select(
			`auto-add-dir（${config.rules.length} 条规则）— 选择规则查看/编辑`,
			options,
		);
		if (!selected || selected.startsWith("←")) return;

		const m = selected.match(/^\[(\d+)\]/);
		const idx = m ? parseInt(m[1], 10) - 1 : -1;
		if (idx < 0 || idx >= config.rules.length) return;

		await editRule(ctx, idx);
	}

	// ── 编辑单条规则（循环菜单：选字段 → input → 直接保存 → 回到菜单） ──

	async function editRule(ctx: ExtensionCommandContext, idx: number) {
		let ruleIdx = idx;

		while (true) {
			const rule = config.rules[ruleIdx];
			if (!rule) return;

			const originIcon = rule.origin === "project" ? "📁项目" : "🌐全局";
			const exists = fs.existsSync(rule.dir) ? "✅" : "❌";
			const kwDisplay = rule.keywords.length ? rule.keywords.join(", ") : "(无条件)";

			const action = await ctx.ui.select(
				`[${ruleIdx + 1}] ${rule.description} ${exists} ${originIcon}\n` +
				`  dir: ${rule.dirSource}\n  keywords: ${kwDisplay}`,
				[
					`✏️ 描述: ${rule.description}`,
					`🏷️ 关键词: ${kwDisplay}`,
					`📂 路径: ${rule.dirSource}`,
					"🗑️ 删除此规则",
					"← 返回",
				],
			);
			if (!action || action.startsWith("←")) return;

			// 删除
			if (action.startsWith("🗑️")) {
				const confirmed = await ctx.ui.confirm("确认删除", `${rule.description}\n${rule.dirSource}`);
				if (!confirmed) continue;
				const sp = rule.origin === "project"
					? path.join(ctx.cwd, ".pi", "settings.json") : SETTINGS_PATH;
				removeRuleFromSettings(sp, rule.dirSource);
				discoveredDirs.delete(rule.dir);
				pendingReminder.delete(rule.dir);
				config = loadConfig(ctx.cwd);
				ctx.ui.notify(`[auto-add-dir] ✅ 已删除（剩余 ${config.rules.length} 条）`, "info");
				return;
			}

			// 编辑字段
			let field: "description" | "keywords" | "dir";
			let hint: string;

			if (action.startsWith("✏️")) {
				field = "description";
				hint = "当前: " + rule.description;
			} else if (action.startsWith("🏷️")) {
				field = "keywords";
				hint = rule.keywords.length ? "当前: " + rule.keywords.join(", ") : "当前: (无条件)";
			} else {
				field = "dir";
				hint = "当前: " + rule.dirSource;
			}

			const inputVal = await ctx.ui.input(
				`输入新${field === "description" ? "描述" : field === "keywords" ? "关键词（逗号分隔）" : "目录路径"}`,
				hint,
			);
			// 空输入 → 保留原值，回到菜单
			if (inputVal === undefined || inputVal.trim() === "") continue;

			// 构建更新后的规则
			const newDir = field === "dir" ? inputVal.trim() : rule.dirSource;
			const newDesc = field === "description" ? inputVal.trim() : rule.description;
			const newKeywords = field === "keywords"
				? inputVal.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
				: rule.keywords;

			const newRule: Rule = { dir: newDir, description: newDesc };
			if (newKeywords.length > 0) newRule.keywords = newKeywords;

			const sp = rule.origin === "project"
				? path.join(ctx.cwd, ".pi", "settings.json") : SETTINGS_PATH;
			if (field === "dir" && inputVal.trim() !== rule.dirSource) {
				removeRuleFromSettings(sp, rule.dirSource);
			}
			saveRuleToSettings(sp, newRule);

			// 热更新 + 刷新 rule 引用
			config = loadConfig(ctx.cwd);
			const newIdx = config.rules.findIndex((r) => r.dirSource === newDir);
			if (newIdx >= 0) ruleIdx = newIdx;
			ctx.ui.notify("[auto-add-dir] ✅ 已更新", "info");
			// continue → 回到操作菜单，可继续改其他字段
		}
	}

	// ── 重新加载 ──

	function cmdReload(ctx: ExtensionCommandContext) {
		config = loadConfig(ctx.cwd);
		discoveredDirs.clear();
		pendingReminder.clear();
		discoverUnconditional();
		const uncond = config.rules.filter((r) => r.keywords.length === 0).length;
		ctx.ui.notify(
			`[auto-add-dir] 🔄 已重载（${config.rules.length} 条规则，${uncond} 条无条件）`,
			"info",
		);
	}
}
