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
 * 配置位置:
 *   全局: ~/.pi/agent/settings.json → "autoAddDir" 字段
 *   项目: .pi/settings.json → "autoAddDir" 字段（与全局合并，同 dir 时项目优先）
 * 环境变量: ~/.pi/agent/env.json
 * 无条件规则: keywords 省略或设为空数组 [] 时，在 session_start 即自动触发
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

interface ResolvedRule {
	keywords: string[];
	dir: string;
	dirSource: string;
	description: string;
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

// ── Config 加载 ────────────────────────────────────────────────

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
	for (const r of globalRules) rulesMap.set(r.dir, r);
	for (const r of projectRules) rulesMap.set(r.dir, r);

	const rules = [...rulesMap.values()];
	log(`loadConfig: total ${rules.length} rule(s) (global=${globalRules.length}, project=${projectRules.length})`);
	return { rules };
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

// ── 主扩展 ─────────────────────────────────────────────────────

export default function autoAddDirExtension(pi: ExtensionAPI) {
	log(`=== extension loading === EXT_DIR=${EXT_DIR}`);
	let config = loadConfig();
	const discoveredDirs = new Map<string, DirContext>();

	// 是否已经在之前的轮次中注入过 system prompt
	// 用于区分"第一轮匹配"和"中间轮次匹配"
	let hasInjectedBefore = false;

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
}
