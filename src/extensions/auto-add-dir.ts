/**
 * Auto Add Directory Extension
 *
 * 当用户提及特定关键词时，自动将对应目录加入会话。
 *
 * 工作原理：
 *   1. input 事件：匹配关键词 → 记录匹配的目录
 *      - 第一轮匹配：只记录，不 transform（靠 system prompt 注入）
 *      - 中间轮次匹配：记录 + transform 用户消息追加提醒（LLM 遵循率更高）
 *   2. before_agent_start 事件：
 *      a) 在 system prompt 中注入「强制调用 add_directory」指令
 *      b) 同时注入 CLAUDE.md / AGENTS.md 内容作为保底（即使 LLM 不调工具也能用）
 *
 * 缓存策略：
 *   同一 session 中同一目录只触发一次（discoveredDirs 去重）
 *
 * ── 配置方式 ──
 *
 * 方式一：slash 命令（推荐，无需手改配置文件）
 *   /auto-add-dir               → 弹出交互菜单（添加 / 列出 / 删除 / 重载）
 *   /auto-add-dir add           → 直接进入添加流程
 *   /auto-add-dir list          → 列出所有规则
 *   /auto-add-dir remove        → 选择规则删除
 *   /auto-add-dir reload        → 重新加载配置
 *
 *   添加规则时支持交互式填写：
 *     目录路径（支持 ${ENV_VAR}、相对路径）
 *     描述
 *     关键词（逗号分隔，留空=无条件匹配）
 *     保存位置（全局 / 当前项目）
 *
 * 方式二：手动编辑配置文件
 *   全局: ~/.pi/agent/settings.json → "autoAddDir" 字段
 *   项目: .pi/settings.json → "autoAddDir" 字段（与全局合并，同 dir 时项目优先）
 *
 * 环境变量: ~/.pi/agent/env.json
 * 无条件规则: keywords 省略或设为空数组 [] 时，在 session_start 即自动触发
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

// ── 类型 ───────────────────────────────────────────────────────

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
	/** 规则来源：全局配置 or 项目配置 */
	origin: RuleOrigin;
}

interface DirContext {
	rule: ResolvedRule;
	contextFiles: { filename: string; content: string }[];
}

// ── 环境变量解析 ────────────────────────────────────────────────

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

// ── Config 加载（读取） ────────────────────────────────────────

interface ResolvedConfig {
	rules: ResolvedRule[];
}

/**
 * 解析单个 settings.json 文件中的 autoAddDir 规则
 */
function parseRulesFromSettings(
	settingsPath: string,
	envJson: Record<string, string>,
	globalBasePath?: string,
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

		// 项目级 basePath 优先，fallback 到全局 basePath
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

	// 1. 全局配置
	const globalRules = parseRulesFromSettings(SETTINGS_PATH, envJson);

	// 提取全局 basePath（供项目级 fallback）
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

	// 2. 项目级配置（与全局合并，同 dir 时项目优先）
	let projectRules: ResolvedRule[] = [];
	if (cwd) {
		const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
		projectRules = parseRulesFromSettings(projectSettingsPath, envJson, globalBasePath);
	}

	// 3. 合并：以 dir 为 key，项目覆盖全局
	const rulesMap = new Map<string, ResolvedRule>();
	for (const r of globalRules) rulesMap.set(r.dir, { ...r, origin: "global" });
	for (const r of projectRules) rulesMap.set(r.dir, { ...r, origin: "project" });

	const rules = [...rulesMap.values()];
	log(`loadConfig: total ${rules.length} rule(s) (global=${globalRules.length}, project=${projectRules.length})`);
	return { rules };
}

// ── Config 写入（通过 /auto-add-dir 命令） ─────────────────────────

/**
 * 将一条规则写入 settings.json（保留其他字段）。
 * - 同 dir 的规则会被更新，否则追加。
 * - 确保目标目录存在（如 .pi/）。
 * - 返回 true 表示写入成功。
 */
function saveRuleToSettings(settingsPath: string, rule: Rule): boolean {
	let settings: Record<string, any> = {};

	// 读取现有配置（保留其他字段）
	if (fs.existsSync(settingsPath)) {
		try {
			settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		} catch (e) {
			log(`saveRule: FAILED to parse existing ${settingsPath} — ${e}`);
			return false;
		}
	}

	// 确保 autoAddDir 结构存在
	if (!settings.autoAddDir) settings.autoAddDir = {};
	if (!Array.isArray(settings.autoAddDir.rules)) settings.autoAddDir.rules = [];

	// 检查是否已存在相同 dir 的规则 → 更新；否则追加
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

	// 确保目录存在
	const dir = path.dirname(settingsPath);
	if (!fs.existsSync(dir)) {
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch (e) {
			log(`saveRule: FAILED to create dir "${dir}" — ${e}`);
			return false;
		}
	}

	// 写回（2 空格缩进，与 pi 标准 settings.json 格式一致）
	try {
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
		log(`saveRule: wrote to ${settingsPath}`);
		return true;
	} catch (e) {
		log(`saveRule: FAILED to write ${settingsPath} — ${e}`);
		return false;
	}
}

/**
 * 从 settings.json 中删除指定 dir 的规则。
 * - 同时从全局和项目配置中尝试删除。
 * - 返回 true 表示至少一处删除成功。
 */
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

// ── 辅助函数 ───────────────────────────────────────────────────

function readAllContextFiles(
	dir: string,
): { filename: string; content: string }[] {
	const files: { filename: string; content: string }[] = [];
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const fp = path.join(dir, name);
		if (fs.existsSync(fp)) {
			try {
				const content = fs.readFileSync(fp, "utf-8").trim();
				if (content) files.push({ filename: name, content });
			} catch {}
		}
	}
	return files;
}

function matchRule(text: string, rule: ResolvedRule): boolean {
	// 空 keywords = 无条件匹配
	if (rule.keywords.length === 0) return true;
	const lower = text.toLowerCase();
	return rule.keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * 检查路径是否包含未解析的环境变量（${...}）。
 */
function hasUnresolvedEnvVar(dir: string): boolean {
	return /\$\{[^}]+\}/.test(dir);
}

// ── 主扩展 ─────────────────────────────────────────────────────

export default function autoAddDirExtension(pi: ExtensionAPI) {
	log(`=== extension loading === EXT_DIR=${EXT_DIR}`);
	let config = loadConfig();
	const discoveredDirs = new Map<string, DirContext>();

	// 是否已经在之前的轮次中注入过 system prompt
	// 用于区分"第一轮匹配"和"中间轮次匹配"
	let hasInjectedBefore = false;

	// ── 事件监听 ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		discoveredDirs.clear();
		hasInjectedBefore = false;
		config = loadConfig(ctx.cwd);

		// 无条件规则（keywords 为空）：session 启动时立即发现
		const unconditionalRules = config.rules.filter(r => r.keywords.length === 0);
		for (const rule of unconditionalRules) {
			if (!discoveredDirs.has(rule.dir) && fs.existsSync(rule.dir)) {
				const contextFiles = readAllContextFiles(rule.dir);
				discoveredDirs.set(rule.dir, { rule, contextFiles });
				log(`session_start: unconditional "${rule.description}" → ${rule.dir}`);
			}
		}

		const kwCount = config.rules.length - unconditionalRules.length;
		ctx.ui.notify(
			`[auto-add-dir] ${config.rules.length} rule(s) (${unconditionalRules.length} unconditional, ${kwCount} keyword)`,
			"info",
		);
	});

	// input: 检测关键词 + 记录目录
	// 中间轮次匹配到新目录时，transform 用户消息追加提醒（LLM 遵循率更高）
	pi.on("input", async (event, _ctx) => {
		if (event.source === "extension") return { action: "continue" };

		log(`input: "${event.text.slice(0, 80)}"`);

		const newDirsThisTurn: DirContext[] = [];

		for (const rule of config.rules) {
			if (matchRule(event.text, rule) && !discoveredDirs.has(rule.dir)) {
				log(`input: matched "${rule.description}" → ${rule.dir}`);
				if (fs.existsSync(rule.dir)) {
					const contextFiles = readAllContextFiles(rule.dir);
					const dirCtx: DirContext = { rule, contextFiles };
					discoveredDirs.set(rule.dir, dirCtx);
					newDirsThisTurn.push(dirCtx);
					log(
						`input: loaded [${contextFiles.map((f) => f.filename).join(",")}]`,
					);
				} else {
					log(`input: dir not found ${rule.dir}`);
				}
			}
		}

		// 中间轮次才匹配到新目录 → transform 用户消息追加提醒
		// 第一轮不需要，因为 before_agent_start 的 system prompt 注入已经足够
		if (newDirsThisTurn.length > 0 && hasInjectedBefore) {
			let reminder =
				"\n\n---\n" +
				"⚠️ **[auto-add-dir 检测到新目录]** 请在回答前先调用 `add_directory`：\n";
			for (const { rule } of newDirsThisTurn) {
				reminder +=
					`- \`add_directory\` with path \`${rule.dir}\` — ${rule.description}\n`;
			}
			log(`input: appending user message reminder (${newDirsThisTurn.length} new dir(s))`);
			return { action: "continue", text: event.text + reminder };
		}

		return { action: "continue" };
	});

	// before_agent_start: 在 system prompt 中注入强制指令 + 保底上下文
	pi.on("before_agent_start", async (event) => {
		if (discoveredDirs.size === 0) return;

		// 标记已注入过，后续 input 匹配时需要追加用户消息提醒
		hasInjectedBefore = true;

		log(
			`before_agent_start: injecting ${discoveredDirs.size} dir(s)`,
		);

		let sp = event.systemPrompt;

		// ── 第一段：强制调用 add_directory 的指令（放在 system prompt 最前面最显眼） ──
		sp =
			`\n## MANDATORY: Call add_directory First\n` +
			`Before answering the user's question, you MUST call the \`add_directory\` tool for each of these directories. ` +
			`This loads skills, search capabilities, and context files that you need.\n\n` +
			`Directories to add:\n`;

		for (const [, { rule }] of discoveredDirs) {
			sp += `- \`add_directory\` with path \`${rule.dir}\` — ${rule.description}\n`;
		}

		sp += `\nDo NOT skip this step. Call add_directory NOW, then proceed.\n\n`;

		// ── 第二段：保底 — CLAUDE.md / AGENTS.md 内容直接注入 ──
		// 即使 LLM 不调 add_directory，这些内容也已在 system prompt 中可用
		sp += `---\n## Auto-Loaded Directory Context (Backup)\n`;
		sp +=
			"The following context files were pre-loaded. " +
			"Use `search_external_files` to find files, `read`/`edit`/`write` with absolute paths.\n\n";

		for (const [, { rule, contextFiles }] of discoveredDirs) {
			sp += `### ${rule.description}\nDirectory: \`${rule.dir}\`\n\n`;
			if (contextFiles.length > 0) {
				for (const cf of contextFiles) {
					sp += `#### ${cf.filename}\n\`\`\`markdown\n${cf.content}\n\`\`\`\n\n`;
				}
			} else {
				sp += `_(No AGENTS.md or CLAUDE.md found)_\n\n`;
			}
		}

		log(`before_agent_start: injection length=${sp.length}`);

		return { systemPrompt: event.systemPrompt + sp };
	});

	// ── /auto-add-dir slash 命令 ──────────────────────────────
	//
	// 用法：
	//   /auto-add-dir            → 交互式菜单
	//   /auto-add-dir add        → 直接进入添加流程
	//   /auto-add-dir list       → 列出所有规则
	//   /auto-add-dir remove     → 选择规则删除
	//   /auto-add-dir reload     → 重新加载配置
	//   /auto-add-dir help       → 显示帮助

	pi.registerCommand("auto-add-dir", {
		description: "管理 auto-add-dir 规则（交互式添加/列出/删除/重载）",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = [
				{ label: "add", desc: "添加新规则（交互式）" },
				{ label: "list", desc: "列出所有规则" },
				{ label: "remove", desc: "删除规则（交互式选择）" },
				{ label: "reload", desc: "重新加载配置" },
				{ label: "help", desc: "显示帮助" },
			];
			const matches = subcommands.filter((s) =>
				s.label.startsWith(prefix),
			);
			return matches.length > 0
				? matches.map((s) => ({ value: s.label, label: s.label, description: s.desc }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const subCmd = args.trim().split(/\s+/)[0]?.toLowerCase() || "";

			switch (subCmd) {
				case "":
				case "help":
				case "menu":
					await showMenu(ctx);
					break;
				case "add":
					await cmdAdd(ctx);
					break;
				case "list":
				case "ls":
					await cmdList(ctx);
					break;
				case "remove":
				case "rm":
				case "delete":
					await cmdRemove(ctx);
					break;
				case "reload":
					cmdReload(ctx);
					break;
				default:
					ctx.ui.notify(
						`[auto-add-dir] 未知子命令「${subCmd}」。可用: add, list, remove, reload, help`,
						"warning",
					);
			}
		},
	});

	// ── 命令处理函数 ───────────────────────────────────────────

	/**
	 * 显示交互式主菜单
	 */
	async function showMenu(ctx: ExtensionCommandContext) {
		const action = await ctx.ui.select("auto-add-dir 管理", [
			"➕ 添加规则",
			"📋 列出规则",
			"🗑️ 删除规则",
			"🔄 重新加载配置",
		]);

		if (!action) return; // 用户取消

		if (action.startsWith("➕")) await cmdAdd(ctx);
		else if (action.startsWith("📋")) await cmdList(ctx);
		else if (action.startsWith("🗑️")) await cmdRemove(ctx);
		else if (action.startsWith("🔄")) cmdReload(ctx);
	}

	/**
	 * 交互式添加规则
	 */
	async function cmdAdd(ctx: ExtensionCommandContext) {
		// 1. 输入目录路径
		const dirInput = await ctx.ui.input(
			"目录路径",
			"D:\\code\\my-project 或 ${MY_VAR}/subdir",
		);
		if (dirInput === undefined || dirInput.trim() === "") {
			ctx.ui.notify("[auto-add-dir] 已取消", "info");
			return;
		}
		const dir = dirInput.trim();

		// 路径存在性检查（环境变量路径跳过）
		if (!hasUnresolvedEnvVar(dir) && !fs.existsSync(dir)) {
			const proceed = await ctx.ui.confirm(
				"路径不存在",
				`「${dir}」不存在或无法访问。是否仍要添加？`,
			);
			if (!proceed) {
				ctx.ui.notify("[auto-add-dir] 已取消", "info");
				return;
			}
		}

		// 2. 输入描述
		const description = await ctx.ui.input(
			"规则描述",
			"如「我的前端项目」「Obsidian 笔记库」",
		);
		if (description === undefined || description.trim() === "") {
			ctx.ui.notify("[auto-add-dir] 描述不能为空，已取消", "warning");
			return;
		}

		// 3. 输入关键词
		const kwInput = await ctx.ui.input(
			"触发关键词（逗号分隔，留空=无条件匹配）",
			"如 frontend,vue,react（留空则每次都匹配）",
		);
		const keywords =
			kwInput && kwInput.trim()
				? kwInput
						.split(/[,，]/)
						.map((s) => s.trim())
						.filter(Boolean)
				: [];

		// 4. 选择保存位置
		const scopeOptions = [
			"🌐 全局（所有项目生效）",
			"📁 当前项目（仅在此目录生效）",
		];
		const scope = await ctx.ui.select("保存位置", scopeOptions);
		if (!scope) {
			ctx.ui.notify("[auto-add-dir] 已取消", "info");
			return;
		}

		const isProject = scope.startsWith("📁");
		const settingsPath = isProject
			? path.join(ctx.cwd, ".pi", "settings.json")
			: SETTINGS_PATH;

		// 5. 确认
		const kwDisplay = keywords.length
			? keywords.join(", ")
			: "(无，每次匹配)";
		const scopeDisplay = isProject ? "当前项目" : "全局";
		const confirmed = await ctx.ui.confirm(
			"确认添加规则",
			`目录: ${dir}\n描述: ${description}\n关键词: ${kwDisplay}\n位置: ${scopeDisplay}\n配置: ${settingsPath}`,
		);
		if (!confirmed) {
			ctx.ui.notify("[auto-add-dir] 已取消", "info");
			return;
		}

		// 6. 写入 settings.json
		const rule: Rule = { dir, description };
		if (keywords.length > 0) rule.keywords = keywords;

		const ok = saveRuleToSettings(settingsPath, rule);
		if (!ok) {
			ctx.ui.notify("[auto-add-dir] ❌ 写入配置失败，请检查日志", "error");
			return;
		}

		// 7. 热更新当前 session 的配置
		config = loadConfig(ctx.cwd);

		// 预览：新规则是否在当前 cwd 下能解析到真实路径
		const newRule = config.rules.find((r) => r.dirSource === dir);
		const resolvedInfo = newRule
			? `→ ${newRule.dir}`
			: "(环境变量可能未设置，将在设置后生效)";

		ctx.ui.notify(
			`[auto-add-dir] ✅ 规则已添加并立即生效\n` +
				`   共 ${config.rules.length} 条规则\n` +
				`   ${dir} ${resolvedInfo}`,
			"info",
		);
	}

	/**
	 * 列出所有规则，选择后可编辑
	 */
	async function cmdList(ctx: ExtensionCommandContext) {
		if (config.rules.length === 0) {
			ctx.ui.notify("[auto-add-dir] 当前没有任何规则", "info");
			return;
		}

		// 构建规则列表（select 让用户选择）
		const options = config.rules.map((r, i) => {
			const exists = fs.existsSync(r.dir) ? "✅" : "❌";
			const originIcon = r.origin === "project" ? "📁" : "🌐";
			const kw = r.keywords.length ? r.keywords.join(",") : "无条件";
			return `[${i + 1}] ${originIcon} ${exists} ${r.description} — ${kw}`;
		});
		options.push("← 返回");

		const selected = await ctx.ui.select(
			`auto-add-dir（${config.rules.length} 条规则）— 选择要编辑的规则`,
			options,
		);
		if (!selected || selected.startsWith("←")) return;

		// 提取序号
		const m = selected.match(/^\[(\d+)\]/);
		const idx = m ? parseInt(m[1], 10) - 1 : -1;
		if (idx < 0 || idx >= config.rules.length) return;

		await editRule(ctx, idx);
	}

	/**
	 * 编辑单条规则（循环菜单，可连续修改多个字段）
	 */
	async function editRule(ctx: ExtensionCommandContext, idx: number) {
		let rule = config.rules[idx];
		let loop = true;

		while (loop) {
			const kwDisplay = rule.keywords.length
				? rule.keywords.join(", ")
				: "(无条件)";
			const exists = fs.existsSync(rule.dir) ? "✅" : "❌";
			const originLabel = rule.origin === "project" ? "📁项目" : "🌐全局";

			const action = await ctx.ui.select(
				`编辑规则 [${idx + 1}] — ${rule.description} ${exists} ${originLabel}\n` +
				`  dir: ${rule.dirSource}\n  keywords: ${kwDisplay}`,
				[
					"✏️ 描述",
					"🏷️ 关键词",
					"📂 目录路径",
					"🗑️ 删除此规则",
					"← 返回",
				],
			);
			if (!action || action.startsWith("←")) return;

			if (action === "🗑️ 删除此规则") {
				const originFull = rule.origin === "project" ? "📁 项目配置" : "🌐 全局配置";
				const confirmed = await ctx.ui.confirm(
					"确认删除",
					`${rule.description}\n${rule.dirSource}\n来源: ${originFull}`,
				);
				if (!confirmed) continue; // 回到编辑菜单

				const settingsPath = rule.origin === "project"
					? path.join(ctx.cwd, ".pi", "settings.json")
					: SETTINGS_PATH;
				const ok = removeRuleFromSettings(settingsPath, rule.dirSource);
				if (ok) {
					config = loadConfig(ctx.cwd);
					discoveredDirs.delete(rule.dir);
					ctx.ui.notify(
						`[auto-add-dir] ✅ 已从${originFull}删除\n   剩余 ${config.rules.length} 条规则`,
						"info",
					);
				} else {
					ctx.ui.notify("[auto-add-dir] ❌ 删除失败", "error");
				}
				return;
			}

			// ── 编辑字段 ──
			let field: "description" | "keywords" | "dir";
			let currentVal: string;
			let hint: string;

			if (action === "✏️ 描述") {
				field = "description";
				currentVal = rule.description;
				hint = "当前: " + rule.description;
			} else if (action === "🏷️ 关键词") {
				field = "keywords";
				currentVal = rule.keywords.join(", ");
				hint = rule.keywords.length
					? "当前: " + rule.keywords.join(", ")
					: "当前: (无条件，留空继续)";
			} else {
				field = "dir";
				currentVal = rule.dirSource;
				hint = "当前: " + rule.dirSource;
			}

			const input = await ctx.ui.input(
				`输入新${field === "description" ? "描述" : field === "keywords" ? "关键词（逗号分隔）" : "目录路径"}`,
				hint,
			);

			// 取消或空输入 → 保留原值
			if (input === undefined || input.trim() === "") continue;

			// 构建更新后的规则
			const newRule: Rule = {
				dir: field === "dir" ? input.trim() : rule.dirSource,
				description: field === "description" ? input.trim() : rule.description,
			};
			const newKeywords = field === "keywords"
				? input.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
				: rule.keywords;
			if (newKeywords.length > 0) newRule.keywords = newKeywords;

			// 确认
			const confirmed = await ctx.ui.confirm(
				"确认修改",
				`${hint}\n↓\n${field === "description" ? input.trim() : field === "keywords" ? (newKeywords.join(", ") || "(无条件)") : input.trim()}`,
			);
			if (!confirmed) continue;

			// 保存到配置文件
			const settingsPath = rule.origin === "project"
				? path.join(ctx.cwd, ".pi", "settings.json")
				: SETTINGS_PATH;

			// 如果 dir 变了，需要先删除旧规则
			if (field === "dir" && input.trim() !== rule.dirSource) {
				removeRuleFromSettings(settingsPath, rule.dirSource);
			}

			const ok = saveRuleToSettings(settingsPath, newRule);
			if (!ok) {
				ctx.ui.notify("[auto-add-dir] ❌ 写入失败", "error");
				continue;
			}

			// 热更新
			config = loadConfig(ctx.cwd);
			// 刷新当前编辑的 rule 引用
			const updatedIdx = config.rules.findIndex(
				(r) => r.dirSource === newRule.dir,
			);
			if (updatedIdx >= 0) {
				rule = config.rules[updatedIdx];
				idx = updatedIdx;
			}
			ctx.ui.notify(`[auto-add-dir] ✅ 已更新`, "info");
		}
	}

	/**
	 * 交互式删除规则
	 */
	async function cmdRemove(ctx: ExtensionCommandContext) {
		if (config.rules.length === 0) {
			ctx.ui.notify("[auto-add-dir] 当前没有任何规则", "info");
			return;
		}

		// 构建选项列表（标注来源）
		const options = config.rules.map(
			(r, i) =>
				`[${i + 1}] ${r.origin === "project" ? "📁" : "🌐"} ${r.description} — ${r.dirSource}`,
		);

		const selected = await ctx.ui.select("选择要删除的规则", options);
		if (!selected) {
			ctx.ui.notify("[auto-add-dir] 已取消", "info");
			return;
		}

		// 提取序号
		const match = selected.match(/^\[(\d+)\]/);
		const idx = match ? parseInt(match[1], 10) - 1 : -1;
		if (idx < 0 || idx >= config.rules.length) {
			ctx.ui.notify("[auto-add-dir] 无效选择", "warning");
			return;
		}

		const rule = config.rules[idx];
		const originLabel = rule.origin === "project" ? "📁 项目配置" : "🌐 全局配置";
		const confirmed = await ctx.ui.confirm(
			"确认删除",
			`${rule.description}\n${rule.dirSource}\n来源: ${originLabel}`,
		);
		if (!confirmed) {
			ctx.ui.notify("[auto-add-dir] 已取消", "info");
			return;
		}

		// 根据来源从对应配置中精确删除
		const settingsPath = rule.origin === "project"
			? path.join(ctx.cwd, ".pi", "settings.json")
			: SETTINGS_PATH;

		const ok = removeRuleFromSettings(settingsPath, rule.dirSource);

		if (ok) {
			// 热更新
			config = loadConfig(ctx.cwd);
			// 清除已发现目录中对应的条目
			discoveredDirs.delete(rule.dir);
			ctx.ui.notify(
				`[auto-add-dir] ✅ 已从${originLabel}删除\n   剩余 ${config.rules.length} 条规则`,
				"info",
			);
		} else {
			ctx.ui.notify("[auto-add-dir] ❌ 删除失败，规则可能不在配置文件中", "error");
		}
	}

	/**
	 * 重新加载配置
	 */
	function cmdReload(ctx: ExtensionCommandContext) {
		config = loadConfig(ctx.cwd);
		discoveredDirs.clear();
		hasInjectedBefore = false;

		// 重新检查无条件规则
		const unconditionalRules = config.rules.filter(
			(r) => r.keywords.length === 0,
		);
		for (const rule of unconditionalRules) {
			if (!discoveredDirs.has(rule.dir) && fs.existsSync(rule.dir)) {
				const contextFiles = readAllContextFiles(rule.dir);
				discoveredDirs.set(rule.dir, { rule, contextFiles });
			}
		}

		ctx.ui.notify(
			`[auto-add-dir] 🔄 已重新加载（${config.rules.length} 条规则，${unconditionalRules.length} 条无条件）`,
			"info",
		);
	}
}
