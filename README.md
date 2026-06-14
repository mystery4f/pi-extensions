# pi-extensions

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A collection of [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extensions — plug-and-play enhancements for your AI coding workflow.

## 🧩 Included Extensions

| Extension | Description |
|---|---|
| [extra-agents-files](#extra-agents-files) | 按标签条件加载额外的上下文文件到 system prompt |
| [auto-add-dir](#auto-add-dir) | 检测用户输入中的关键词，自动将对应目录加入会话 |
| [patch](#patch) | 精确字符串替换文件编辑工具，支持锚点定位和 diff 预览 |
| [codegraph-guidance](#codegraph-guidance) | 检测 codegraph MCP 工具并注入使用指南到 system prompt |

---

### patch

精确字符串替换文件编辑工具，替代 pi 原生的 `edit`/`write`。支持锚点（anchor）定位、多编辑批量应用、diff 预览。

> **来源**：迁移自 [lcwecker/decorated-pi](https://github.com/lcwecker/decorated-pi)，原项目采用 MIT 协议。

**特性**：

- ✏️ **精确字符串替换** — `old_str` / `new_str` 精确匹配，不使用正则或模糊匹配
- ⚓ **锚点定位** — 可选 `anchor` 参数缩小搜索范围，用于 `old_str` 不唯一时
- 📦 **批量编辑** — 单次调用可应用多个编辑（`edits[]`），自动检测冲突和重叠
- 🔄 **原子覆写** — 支持 `overwrite: true` + `new_str` 原子替换整个文件
- 📊 **diff 预览** — TUI 中实时显示 unified diff，可折叠/展开
- 🔗 **链式编辑** — 后续编辑可引用前序编辑的输出，自动回退到顺序模式
- 🛡️ **模糊匹配降级** — 精确匹配失败时尝试 tab/space/尾部空白容错匹配

**用法示例**：

```
# 基本替换
{ path: "src/foo.ts", edits: [{ old_str: "return 1", new_str: "return 42" }] }

# 带锚点的替换
{ path: "src/foo.ts", edits: [{ anchor: "function bar() {", old_str: "return x", new_str: "return x + 1" }] }

# 多编辑批量
{ path: "src/foo.ts", edits: [
  { anchor: "function init() {", old_str: "const DEBUG = true;", new_str: "const DEBUG = false;" },
  { old_str: "log(\"debug\");", new_str: "// debug disabled" }
] }
```

---

### codegraph-guidance

自动检测 codegraph MCP 工具是否可用，并在 system prompt 中注入高效使用指南。引导 LLM 优先使用 `codegraph_explore`、`codegraph_search` 等工具代替 grep/read，提升代码导航效率。

> **来源**：迁移自 [lcwecker/decorated-pi](https://github.com/lcwecker/decorated-pi)，原项目采用 MIT 协议。

**工作原理**：

1. `before_agent_start` 事件中检测已注册的工具名是否有 `codegraph_` 前缀
2. 如果检测到 codegraph 工具，将使用指南注入 system prompt
3. 指南包括：何时使用、应避免的操作（如用 grep 替代）、常见错误的处理方式

**前提**：需要在 Pi 的 MCP 配置中启用 codegraph 服务器（如 `mcp.json` 或 settings）。

---

### router-bridge

桥接 `pi-auto-router` 和 `pi-bar`，提供两项能力：

1. **准确的上下文使用率显示** — 解析 auto-router 实际路由到的底层模型，让 pi-bar 的 meter 段显示真正的 context window 和百分比，而不是虚拟模型的错误数值
2. **限流快速 fallthrough** — 通过暴露 `__piAutoRouter_onTargetError` hook，让特定 provider（如 opencode）在返回 429/限流错误时**立即跳过**，不等超时、不重试

> **依赖**：需要安装 `pi-auto-router` 扩展配合使用。

**特性**：

- 📊 **3 层 fallback 解析 context window** — 实际路由模型 → route 第一目标 → 虚拟模型自身
- ⚡ **opencode 429 快速跳过** — opencode-go-1/opencode-go-2 返回 429 时立即 fallthrough 到下一个 target
- 🔧 **可扩展的 error hook** — 通过 `__piAutoRouter_onTargetError` 接口，新增 provider 策略只需改 router-bridge
- 🀄 **中文限流模式匹配** — 内置中文限流关键词检测（频率过高、限流、配额不足等），覆盖智谱/DeepSeek/Moonshot 等国内 provider
- 📝 **调试日志** — 设置 `ROUTER_BRIDGE_DEBUG=1` 写入 `~/.pi/agent/extensions/router-bridge.debug.log`

**暴露的全局接口**：

| Hook | 签名 | 用途 |
|---|---|---|
| `__piRouterBridge` | `{ getRoutedModel, getActualPercent, getContextWindowLabel, getTargetTimeoutMs }` | pi-bar 读取真实的 context window |
| `__piAutoRouter_isRetryableError` | `(message: any) => boolean \| undefined` | 扩展 auto-router 的 retryable 判断（中文模式等） |
| `__piAutoRouter_onTargetError` | `(provider: string, error: any, target: any) => "skip" \| undefined` | **返回 `"skip"` 强制 fallthrough**，用于 opencode 等需要快速跳过的 provider |

**opencode 429 快速 fallthrough 流程**：

```
opencode-go-1 返回 { status: 429, errorMessage: "..." }
  ↓
tryTarget 调用 __piAutoRouter_onTargetError("opencode-go-1", error)
  ↓
router-bridge 检测: provider 是 opencode + status === 429
  ↓
返回 "skip"
  ↓
tryTarget 立即 retryableFailure → 主循环 continue → 下一个 LLM
```

**添加新 provider 的快速 fallthrough 策略**（在 `router-bridge.ts` 中）：

```typescript
// 在 __piAutoRouter_onTargetError hook 中添加条件：
if (provider === "your-provider") {
    const status = error?.status ?? error?.statusCode;
    if (status === 429) return "skip";
    // 或者匹配消息关键词：
    if (String(error?.errorMessage ?? "").includes("your pattern")) return "skip";
}
```

**pi-bar 配置示例**（`~/.pi/agent/settings.json`）：

```json
{
  "statusbar": {
    "segments": [
      {
        "type": "meter",
        "value_eval": "globalThis.__piRouterBridge?.getActualPercent() ?? ctx.getContextUsage()?.percent ?? 0",
        "eval": "(() => { const b = globalThis.__piRouterBridge; const pct = Math.round(value); const cw = b?.getContextWindowLabel() ?? ''; return `${pct}% of ${cw}`; })()"
      }
    ]
  }
}
```

---

### extra-agents-files

根据全局和项目级 `settings.json` 配置，将额外的 Markdown/文本文件注入到 system prompt 中，支持标签过滤。

**特性**：

- 📁 **两级配置** — 全局 (`~/.pi/agent/settings.json`) + 项目 (`.pi/settings.json`)
- 🏷️ **标签过滤** — 全局文件可标记标签，项目按需声明加载哪些标签
- 🔄 **去重** — 同一路径只加载一次，项目配置优先级高于全局
- 🏠 **路径灵活** — 支持相对路径、绝对路径、`~` 展开

**配置格式**（全局 `~/.pi/agent/settings.json` 和项目 `.pi/settings.json` 通用）：

```json
{
  "extraContext": {
    "files": [
      "AGENTS-general.md",
      { "path": "AGENTS-Java.md", "tags": ["Java"] },
      { "path": "AGENTS-frontend.md", "tags": ["frontend"] }
    ],
    "includes": ["Java"]
  }
}
```

| 字段 | 说明 |
|---|---|
| `files` | 文件列表，每项为路径字符串或 `{ path, tags? }` 对象 |
| `"AGENTS-general.md"` | 直接写字符串路径，无条件加载，等同 `{ "path": "...", "tags": [] }` |
| `files[].path` | 文件路径，全局配置相对于 `~/.pi/agent`，项目配置相对于项目根目录，支持 `~` 和绝对路径 |
| `files[].tags` | 可选标签数组。无标签 = 所有项目都加载 |
| `includes` | 可选，声明项目需要的标签。全局文件 **无标签** 或 **标签匹配** 时才会加载 |

**加载逻辑**：

1. 读取项目 `.pi/settings.json` 的 `extraContext.includes`，构建标签集合
2. 加载全局 `extraContext.files`（过滤标签）
3. 加载项目级 `extraContext.files`（不过滤标签）
4. 所有匹配文件的内容注入 system prompt

---

### auto-add-dir

监听用户输入中的关键词，自动将对应的外部目录加入 Pi 会话——无需手动调用 `add_directory`。

**特性**：

- 🔍 **关键词匹配** — 不区分大小写，一条规则可配多个关键词
- ⚡ **无条件规则** — `keywords` 设为空数组 `[]` 时，session 启动即自动触发，无需等待用户输入
- 🖥️ **交互式命令** — 通过 `/auto-add-dir` 命令交互式管理规则（添加/编辑/删除），无需手改配置文件
- 🧠 **智能注入** — 第一轮通过 system prompt 指令，后续轮次追加用户消息提醒
- 🛡️ **保底机制** — 自动读取目录下的 `AGENTS.md` / `CLAUDE.md` 作为后备上下文
- 🔁 **去重** — 同一 session 中每个目录只触发一次
- 🌍 **变量替换** — `dir` 支持 `${VAR}` 占位符，从 `env.json` 或系统环境变量解析
- 📝 **调试日志** — 写入 `%TEMP%/auto-add-dir.log`，排查配置问题

**通过 /auto-add-dir 命令管理（推荐）**：

```;
/auto-add-dir            → 主菜单（添加 / 列出编辑 / 重载）
/auto-add-dir add        → 直接添加
/auto-add-dir list       → 列出并编辑
/auto-add-dir reload     → 重新加载
```

添加规则交互式填写目录路径（支持 `${ENV_VAR}`）、描述、关键词（逗号分隔），选择保存到全局或项目。
编辑时每个字段显示当前值，输入新值直接保存，空输入跳过。

**手动配置** (`~/.pi/agent/settings.json` → `"autoAddDir"` 字段)：

```json
{
  "autoAddDir": {
    "basePath": "${PROJECT_ROOT}",
    "rules": [
      {
        "keywords": ["obsidian", "vault", "笔记"],
        "dir": "${NOTES_PATH}",
        "description": "Obsidian Vault"
      },
      {
        "keywords": ["api", "walmart"],
        "dir": "walmart-api-crawler",
        "description": "Walmart API Crawler"
      }
    ]
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `basePath` | `string?` | 全局基础路径，支持 `${VAR}` 占位符 |
| `rules` | `Rule[]` | 规则列表 |
| `rules[].keywords` | `string[]` | 触发关键词（不区分大小写）。设为空数组 `[]` 时成为**无条件规则**，session 启动立即触发 |
| `rules[].dir` | `string` | 目录路径。绝对路径、`${VAR}` 占位符、相对路径（相对 `basePath`） |
| `rules[].description` | `string` | 用途描述，注入 system prompt 时展示 |

**环境变量** (`~/.pi/agent/env.json`)：

```json
{
  "NOTES_PATH": "D:\\Documents\\obsidian\\notes",
  "PROJECT_ROOT": "D:\\Projects"
}
```

解析优先级：`env.json` > 系统环境变量

**工作流程**：

```
用户输入 "帮我看看 obsidian 插件"
        │
        ▼
  input 事件：匹配关键词 "obsidian"
        │
        ▼
  记录目录 → 读取 AGENTS.md / CLAUDE.md
        │
        ▼
  before_agent_start 事件：
    ├─ 注入 "MANDATORY: Call add_directory" 指令
    └─ 注入目录上下文文件内容（保底）
        │
        ▼
  LLM 自动调用 add_directory 加载完整目录
```

---

## 📦 安装

```bash
pi install mystery4f/pi-extensions
```

安装后，在 `~/.pi/agent/settings.json` 中配置需要的扩展即可启用。

## 🏗️ 项目结构

```
pi-extensions/
├── index.ts                     # 入口，注册所有扩展
├── package.json
├── tsconfig.json
└── src/
    └── extensions/
        ├── extra-agents-files.ts
        ├── auto-add-dir.ts
        ├── router-bridge.ts
        ├── patch/
        │   ├── index.ts    # 工具注册 + TUI 渲染
        │   └── core.ts     # 编辑逻辑 + diff 生成
        └── codegraph-guidance.ts
```

添加新扩展：在 `src/extensions/` 下新建文件，然后在 `index.ts` 中注册即可。

## License

[MIT](LICENSE)
