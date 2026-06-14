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
 * 方式一：自然语言（推荐，最自然）
 *   直接告诉 AI：
 *     "帮我加个 auto-add-dir 规则，关键词 obsidian，目录 D:\notes"
 *     "改下规则 1 的描述"
 *     "删掉 walmart 那条规则"
 *     "看看现在有哪些规则"
 *   AI 会自动调用 manage_auto_add_dir 工具完成操作，立即生效。
 *
 * 方式二：slash 命令（轻量只读）
 *   /auto-add-dir            → 显示规则列表
 *   /auto-add-dir reload     → 重新加载配置
 *
 * 方式三：手动编辑配置文件
 *   全局: ~/.pi/agent/settings.json → "autoAddDir" 字段
 *   项目: .pi/settings.json → "autoAddDir" 字段（与全局合并，同 dir 时项目优先）
 *
 * 环境变量: ~/.pi/agent/env.json
 * 无条件规则: keywords 省略或设为空数组 [] 时，在 session_start 即自动触发
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
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

	const globalRules = parseRulesFromSettings(SETTINGS_PATH, envJson);

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
		projectRules = parseRulesFromSettings(projectSettingsPath, envJson, globalBasePath);
	}

	const rulesMap = new Map<string, ResolvedRule>();
	for (const r of globalRules) rulesMap.set(r.dir, { ...r, origin: "global" });
	for (const r of projectRules) rulesMap.set(r.dir, { ...r, origin: "project" });

	const rules = [...rulesMap.values()];
	log(`loadConfig: total ${rules.length} rule(s) (global=${globalRules.length}, project=${projectRules.length})`);
	return { rules };
}

// ── Config 写入 ────────────────────────────────────────────────

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
	if (rule.keywords.length === 0) return true;
	const lower = text.toLowerCase();
	return rule.keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

// ── 主扩展 ─────────────────────────────────────────────────────

export default function autoAddDirExtension(pi: ExtensionAPI) {
	log(`=== extension loading === EXT_DIR=${EXT_DIR}`);
	let config = loadConfig();
	const discoveredDirs = new Map<string, DirContext>();
	let hasInjectedBefore = false;

	// ── 事件监听 ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		discoveredDirs.clear();
		hasInjectedBefore = false;
		config = loadConfig(ctx.cwd);

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
					log(`input: loaded [${contextFiles.map((f) => f.filename).join(",")}]`);
				} else {
					log(`input: dir not found ${rule.dir}`);
				}
			}
		}

		if (newDirsThisTurn.length > 0 && hasInjectedBefore) {
			let reminder =
				"\n\n---\n" +
				"⚠️ **[auto-add-dir 检测到新目录]** 请在回答前先调用 `add_directory`：\n";
			for (const { rule } of newDirsThisTurn) {
				reminder += `- \`add_directory\` with path \`${rule.dir}\` — ${rule.description}\n`;
			}
			log(`input: appending user message reminder (${newDirsThisTurn.length} new dir(s))`);
			return { action: "continue", text: event.text + reminder };
		}

		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		if (discoveredDirs.size === 0) return;

		hasInjectedBefore = true;
		log(`before_agent_start: injecting ${discoveredDirs.size} dir(s)`);

		let sp = event.systemPrompt;

		sp =
			`\n## MANDATORY: Call add_directory First\n` +
			`Before answering the user's question, you MUST call the \`add_directory\` tool for each of these directories. ` +
			`This loads skills, search capabilities, and context files that you need.\n\n` +
			`Directories to add:\n`;

		for (const [, { rule }] of discoveredDirs) {
			sp += `- \`add_directory\` with path \`${rule.dir}\` — ${rule.description}\n`;
		}

		sp += `\nDo NOT skip this step. Call add_directory NOW, then proceed.\n\n`;

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

	// ── registerTool: manage_auto_add_dir ──────────────────────
	//
	// 注册 LLM 可调用的工具，用户用自然语言即可管理规则：
	//   "帮我加个规则，提到 obsidian 时加载笔记目录"
	//   "把规则 1 的描述改成 xxx"
	//   "删掉 walmart 那条规则"
	//   "看看现在有哪些规则"

	const ManageSchema = Type.Object({
		action: Type.Union(
			[Type.Literal("list"), Type.Literal("add"), Type.Literal("edit"), Type.Literal("remove")],
			{ description: "操作类型：list=列出, add=添加, edit=修改, remove=删除" },
		),
		index: Type.Optional(
			Type.Number({ description: "规则序号（从 1 开始），用于 edit/remove 指定目标规则" }),
		),
		dir: Type.Optional(
			Type.String({ description: "目录路径，支持 ${ENV_VAR}、相对路径。add 时必填，edit 时可修改" }),
		),
		description: Type.Optional(
			Type.String({ description: "规则用途描述。add 时必填，edit 时可修改" }),
		),
		keywords: Type.Optional(
			Type.Array(Type.String(), {
				description: "触发关键词列表。空数组或省略=无条件匹配（每次都触发）",
			}),
		),
		scope: Type.Optional(
			Type.Union([Type.Literal("global"), Type.Literal("project")], {
				description: "保存位置：global=全局配置（默认），project=当前项目配置",
			}),
		),
	});

	pi.registerTool(defineTool({
		name: "manage_auto_add_dir",
		label: "Manage Auto-Add-Dir",
		description: [
			"Manage auto-add-dir rules (add/edit/remove/list).",
			"auto-add-dir automatically loads external directories into the session when keywords match.",
			"",
			"Actions:",
			'  list   — Show all rules (no other params needed)',
			'  add    — Create a new rule (requires dir + description, optional keywords + scope)',
			'  edit   — Modify an existing rule by index (provide index + fields to change)',
			'  remove — Delete a rule by index',
			"",
			"Examples:",
			'  { action: "list" }',
			'  { action: "add", dir: "${NOTES_PATH}", description: "Obsidian Vault", keywords: ["obsidian", "vault"] }',
			'  { action: "add", dir: "D:\\\\code\\\\project", description: "My Project", keywords: ["project"], scope: "project" }',
			'  { action: "edit", index: 1, description: "New description" }',
			'  { action: "edit", index: 2, keywords: ["api", "walmart"], dir: "${WALMART_PATH}" }',
			'  { action: "remove", index: 1 }',
		].join("\n"),
		promptSnippet: "Manage auto-add-dir rules (add/edit/remove/list external directory associations).",
		promptGuidelines: [
			"When the user asks to add/edit/remove/list auto-add-dir rules, use manage_auto_add_dir tool.",
			"User intent examples: '加个规则', '当提到xxx时加载', '改下规则', '删掉规则', '有哪些规则'.",
		],
		parameters: ManageSchema,
		execute: async (_toolCallId, input, _signal, _onUpdate, ctx) => {
			const cwd: string = ctx.cwd ?? process.cwd();
			const { action } = input;

			// ── list ──
			if (action === "list") {
				config = loadConfig(cwd);
				if (config.rules.length === 0) {
					return { content: [{ type: "text" as const, text: "当前没有任何 auto-add-dir 规则。" }] };
				}
				const lines = config.rules.map((r, i) => {
					const kw = r.keywords.length ? r.keywords.join(", ") : "(无条件)";
					const exists = fs.existsSync(r.dir) ? "✅" : "❌";
					const origin = r.origin === "project" ? "📁项目" : "🌐全局";
					return `[${i + 1}] ${origin} ${exists} ${r.description}\n    dir: ${r.dirSource}\n    resolved: ${r.dir}\n    keywords: ${kw}`;
				});
				return {
					content: [{
						type: "text" as const,
						text: `共 ${config.rules.length} 条规则:\n\n${lines.join("\n\n")}`,
					}],
				};
			}

			// ── add ──
			if (action === "add") {
				if (!input.dir || !input.description) {
					return { content: [{ type: "text" as const, text: "❌ add 操作需要 dir 和 description 参数。" }] };
				}
				const rule: Rule = { dir: input.dir, description: input.description };
				if (input.keywords && input.keywords.length > 0) rule.keywords = input.keywords;

				const settingsPath = input.scope === "project"
					? path.join(cwd, ".pi", "settings.json")
					: SETTINGS_PATH;

				const ok = saveRuleToSettings(settingsPath, rule);
				if (!ok) return { content: [{ type: "text" as const, text: `❌ 写入失败: ${settingsPath}` }] };

				config = loadConfig(cwd);
				return {
					content: [{
						type: "text" as const,
						text: `✅ 规则已添加并立即生效（共 ${config.rules.length} 条）\n   dir: ${input.dir}\n   description: ${input.description}\n   keywords: ${input.keywords?.length ? input.keywords.join(", ") : "(无条件)"}\n   scope: ${input.scope === "project" ? "📁 项目" : "🌐 全局"}`,
					}],
				};
			}

			// ── edit ──
			if (action === "edit") {
				config = loadConfig(cwd);
				const idx = (input.index ?? 0) - 1;
				if (idx < 0 || idx >= config.rules.length) {
					return { content: [{ type: "text" as const, text: `❌ 无效序号 ${input.index}，当前共 ${config.rules.length} 条规则。` }] };
				}

				const oldRule = config.rules[idx];
				const newDir = input.dir ?? oldRule.dirSource;
				const newDesc = input.description ?? oldRule.description;
				const newKeywords = input.keywords !== undefined ? input.keywords : oldRule.keywords;

				const newRule: Rule = { dir: newDir, description: newDesc };
				if (newKeywords.length > 0) newRule.keywords = newKeywords;

				const settingsPath = oldRule.origin === "project"
					? path.join(cwd, ".pi", "settings.json")
					: SETTINGS_PATH;

				// dir 变了 → 先删旧规则
				if (newDir !== oldRule.dirSource) {
					removeRuleFromSettings(settingsPath, oldRule.dirSource);
				}

				const ok = saveRuleToSettings(settingsPath, newRule);
				if (!ok) return { content: [{ type: "text" as const, text: "❌ 写入失败" }] };

				config = loadConfig(cwd);
				return {
					content: [{
						type: "text" as const,
						text: `✅ 规则 [${input.index}] 已更新\n   dir: ${newDir}\n   description: ${newDesc}\n   keywords: ${newKeywords.length ? newKeywords.join(", ") : "(无条件)"}`,
					}],
				};
			}

			// ── remove ──
			if (action === "remove") {
				config = loadConfig(cwd);
				const idx = (input.index ?? 0) - 1;
				if (idx < 0 || idx >= config.rules.length) {
					return { content: [{ type: "text" as const, text: `❌ 无效序号 ${input.index}，当前共 ${config.rules.length} 条规则。` }] };
				}

				const rule = config.rules[idx];
				const settingsPath = rule.origin === "project"
					? path.join(cwd, ".pi", "settings.json")
					: SETTINGS_PATH;

				const ok = removeRuleFromSettings(settingsPath, rule.dirSource);
				if (!ok) return { content: [{ type: "text" as const, text: "❌ 删除失败" }] };

				discoveredDirs.delete(rule.dir);
				config = loadConfig(cwd);
				return {
					content: [{
						type: "text" as const,
						text: `✅ 已删除规则 [${input.index}] ${rule.description}（剩余 ${config.rules.length} 条）`,
					}],
				};
			}

			return { content: [{ type: "text" as const, text: `❌ 未知操作: ${action}` }] };
		},
	}));

	// ── /auto-add-dir slash 命令（轻量只读） ───────────────────
	// 只提供 list 和 reload，所有写操作通过 manage_auto_add_dir 工具由 AI 完成。

	pi.registerCommand("auto-add-dir", {
		description: "查看 auto-add-dir 规则列表 / 重载配置（增删改请直接告诉 AI）",
		getArgumentCompletions: (prefix: string) => {
			const subs = [
				{ label: "list", desc: "列出所有规则" },
				{ label: "reload", desc: "重新加载配置" },
			];
			const matches = subs.filter((s) => s.label.startsWith(prefix));
			return matches.length > 0
				? matches.map((s) => ({ value: s.label, label: s.label, description: s.desc }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const subCmd = args.trim().split(/\s+/)[0]?.toLowerCase() || "";

			if (subCmd === "reload") {
				config = loadConfig(ctx.cwd);
				discoveredDirs.clear();
				hasInjectedBefore = false;
				const unconditionalRules = config.rules.filter((r) => r.keywords.length === 0);
				for (const rule of unconditionalRules) {
					if (!discoveredDirs.has(rule.dir) && fs.existsSync(rule.dir)) {
						const contextFiles = readAllContextFiles(rule.dir);
						discoveredDirs.set(rule.dir, { rule, contextFiles });
					}
				}
				ctx.ui.notify(
					`[auto-add-dir] 🔄 已重载（${config.rules.length} 条规则，${unconditionalRules.length} 条无条件）`,
					"info",
				);
				return;
			}

			// 默认: list（只读显示）
			if (config.rules.length === 0) {
				ctx.ui.notify("[auto-add-dir] 当前没有任何规则。告诉 AI「加个规则」即可添加。", "info");
				return;
			}
			const lines = config.rules.map((r, i) => {
				const kw = r.keywords.length ? r.keywords.join(", ") : "(无条件)";
				const exists = fs.existsSync(r.dir) ? "✅" : "❌";
				const origin = r.origin === "project" ? "📁项目" : "🌐全局";
				return `[${i + 1}] ${origin} ${exists} ${r.description}\n    dir: ${r.dirSource}\n    keywords: ${kw}`;
			});
			ctx.ui.notify(
				`[auto-add-dir] ${config.rules.length} 条规则:\n\n${lines.join("\n\n")}\n\n💡 增删改规则：直接告诉 AI，如「加个规则」「删掉规则 1」`,
				"info",
			);
		},
	});
}
