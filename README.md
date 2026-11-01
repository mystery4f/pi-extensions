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
| [tool-toggle](#tool-toggle) | `/tools` 交互式启用/禁用工具（会话或全局作用域） |
| [thinking-loop-guard](#thinking-loop-guard) | 检测 thinking/正文流式复读循环，警告并自动中止（MiMo 等模型的思考死循环兜底） |

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
- 🖥️ **交互式命令** — 通过 `/extra-files` 命令交互式管理（添加/编辑/删除/includes/重载），无需手改配置文件

**通过 /extra-files 命令管理（推荐）**：

```
/extra-files            → 主菜单（添加 / 列出编辑 / includes / 重载 / 查看）
/extra-files add        → 添加文件（路径 + 标签 + 选择全局/项目）
/extra-files list       → 列出并编辑/删除（显示 ✅已加载 / ⏸️被 includes 过滤）
/extra-files includes   → 管理项目 includes 标签（设置 / 全选 / 清空）
/extra-files reload     → 重新加载配置
/extra-files show       → 查看当前已加载文件
```

添加文件时交互式填写路径、标签（逗号分隔，留空=无条件加载）、选择全局或项目；列出时可编辑路径/标签、删除单条；includes 管理自动扫描全局可用标签，支持全选或清空。所有改动即时热重载。

**配置格式**（手动编辑；全局 `~/.pi/agent/settings.json` 和项目 `.pi/settings.json` 通用）：

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

### tool-toggle

`/tools` 命令打开 TUI 复选框列表，交互式启用/禁用所有可用工具。被禁用的工具从模型工具列表中移除，调用会被拦截。支持 `/` 进入搜索模式按工具名称/描述/插件名（来源包或扩展目录）过滤。参考 `@firstpick/pi-extension-tools` 的核心机制精简实现（无模糊搜索、无排序关键词、无按模型配置）。

**命令**：
二级参数支持自动补全：输入 `/tools` 后按空格，编辑器会提示 `global` / `clear` / `clear global` 供选择。

| 命令 | 作用 |
|---|---|
| `/tools` | 编辑会话选择（存为 custom entry，分支切换后保持） |
| `/tools global` | 编辑全局选择（写入 `~/.pi/agent/tool-toggle.json`，对新会话生效） |
| `/tools clear` | 清除会话选择（回退到全局/运行时默认） |
| `/tools clear global` | 清除全局选择（删除配置文件） |

**按键**：`↑/↓` 移动 · `空格` 切换 · `a` 切换当前显示的行 · `/` 搜索（输入即过滤，`退格` 删除，`Esc` 退出搜索） · `f` 切换视图（全部 → 已启用 → 已禁用，与搜索叠加生效） · `Ctrl+S` 保存（保存后列表不关闭，可继续调整，并提示保存成功） · `Esc` 关闭列表

**作用域优先级**：会话选择 > 全局选择 > 运行时默认。两个作用域都只保存**被禁用的工具名**（`{"disabledTools": [...]}`），新出现的工具默认启用。旧版 `{"enabledTools": [...]}` 白名单文件会被直接忽略（不做迁移），需要时重新用 `/tools global` 勾选即可。

**生效机制**：

- `pi.setActiveTools()` 裁剪当前激活工具列表
- `context_with_system` 事件追加 `toolsRemoved` 系统消息，请求载荷中同样移除（覆盖后注册的工具）
- `tool_call` 事件兜底拦截被禁工具的调用
- 清单变化后通过 `cache_warming_decision` 事件一次性停止旧进程的缓存保活重放（旧快照仍带旧工具清单，避免继续向服务端发送过期请求；下一条真实消息后自动恢复保活）

仅在交互式 TUI 会话生效；RPC / print 模式不受影响。

---
### thinking-loop-guard

检测模型在 thinking / 正文流式输出中的复读循环（典型场景：MiMo 长思考陷入推理死循环，重复同一段 token 直到 max_tokens 或超时烧完），命中后通知用户并默认自动中止当前 run。

**背景**：MiMo 系列模型在长思考场景存在广泛报告的推理循环问题（学术论文 arxiv 2512.12895 指出根因是 RL 训练中"循环动作"比"正确下一步"更易学习；小米官方博客确认并已用 MOPD 修复部分场景）。但线上仍可能遇到旧版本或新变种，此扩展作为客户端兜底：检测到循环立即止损，不再空烧 token。

**检测算法**：连续周期重复（与 MiMo Code 内置复读检测同思路）。维护一个滑动 token 窗口（默认 500 token），对每个候选周期 `p ∈ [minPeriod, window/threshold]`，检查窗口尾部是否有连续 `p×(threshold-1)` 个位置满足 `tok[i] == tok[i+p]`（即同一 token 块首尾相接重复 ≥ threshold 次），且该块内不同 token 数 ≥ `distinctMin`（排除纯空白/标点填充的退化块）。命中即判定循环。分词规则：拉丁文按词，CJK 逐字。

**特性**：

- 🔁 **双流检测** — thinking 和正文 text 流用同一套检测器，独立计数
- 🎯 **按 provider/model 开关** — glob 匹配（如 `xiaomi`、`*mimo*`），只对你指定的模型生效，默认关闭不影响其他扩展用户
- ⚡ **在线检测** — 逐 token 增量触发，循环形成后尽快止损，不等整个段落生成完
- 🔕 **可降级为仅警告** — `action: "warn"` 时不中止，只提示
- 🔄 **自动升级恢复** — `action: "retry"` 命中后中止并自动重来，第 1 次提醒换思路，第 2 次要求推倒重来，超过 `maxRetries` 次退回纯中止；收到真实用户消息后计数复位。提醒在 run 彻底结束（`agent_settled`）后才投递——若随 `abort` 一起塞进 followUp 队列会成为孤儿卡在 queued（中止不清洗队列），8 秒兜底定时器防止事件丢失时提醒不发
- 🛠️ **doom loop 检测** — 同一条回复里连续 `toolRepeatCount`（默认 3）次同名同参工具调用触发干预（与复读层共用同一套升级逻辑）
- 🧩 **配置分层** — 全局 `~/.pi/agent/settings.json` → 项目 `.pi/settings.json`（覆盖）→ 环境变量（最高）

**配置**（`~/.pi/agent/settings.json` 或项目 `.pi/settings.json`）：

```json
{
  "thinkingLoopGuard": {
    "enabled": true,
    "providers": ["mimo-plan", "xiaomi", "xiaomi-token-plan-*"],
    "models": ["*mimo*"],
    "action": "abort",
    "maxRetries": 2,
    "toolRepeatCount": 3,
    "windowTokens": 500,
    "minPeriod": 4,
    "threshold": 20,
    "distinctMin": 3
  }
}
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `false` | 总开关。默认关闭，显式配置才生效 |
| `providers` | `string[]` | `[]` | provider glob 列表，命中即开启检测。空 = 不按 provider 匹配 |
| `models` | `string[]` | `[]` | model id glob 列表，命中即开启检测。空 = 不按 model 匹配 |
| `action` | `"abort" \| "warn" \| "retry"` | `"abort"` | `abort` 警告并中止 run；`warn` 仅警告；`retry` 中止后自动重来并升级提醒（remind → replan → 超限退回纯中止），提醒在 run 彻底结束（`agent_settled`）后才投递，收到真实用户消息时计数复位 |
| `maxRetries` | `number` | `2` | `action: "retry"` 时最多自动重试次数，超限退回纯中止 |
| `toolRepeatCount` | `number` | `3` | doom loop 阈值：同一条回复里同名同参工具调用连续出现该次数即干预 |
| `windowTokens` | `number` | `500` | 滑动窗口 token 数 |
| `minPeriod` | `number` | `4` | 最短循环周期（token 数），块小于该值不判循环 |
| `threshold` | `number` | `20` | 同一块连续重复次数阈值 |
| `distinctMin` | `number` | `3` | 循环块内最少不同 token 数，防退化误报 |

**环境变量覆盖**（优先级最高）：`THINKING_LOOP_GUARD_ENABLED`、`THINKING_LOOP_GUARD_PROVIDERS`（逗号分隔）、`THINKING_LOOP_GUARD_MODELS`（逗号分隔）、`THINKING_LOOP_GUARD_ACTION`（`abort`/`warn`/`retry`）、`THINKING_LOOP_GUARD_MAX_RETRIES`、`THINKING_LOOP_GUARD_TOOL_REPEAT_COUNT`、`THINKING_LOOP_GUARD_WINDOW`、`THINKING_LOOP_GUARD_MIN_PERIOD`、`THINKING_LOOP_GUARD_THRESHOLD`、`THINKING_LOOP_GUARD_DISTINCT_MIN`。

**注意**：pi 没有"截断思考段但继续生成答案"的 API，中止是整个 run 级别的——已流出的内容保留在会话历史中，可手动追加提示词让模型换思路继续。

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
        ├── whoami.ts
        ├── zhipu-provider.ts
        ├── tool-toggle.ts
        ├── thinking-loop-guard.ts
        ├── patch/
        │   ├── index.ts    # 工具注册 + TUI 渲染
        │   └── core.ts     # 编辑逻辑 + diff 生成
        └── codegraph-guidance.ts
```

添加新扩展：在 `src/extensions/` 下新建文件，然后在 `index.ts` 中注册即可。

## License

[MIT](LICENSE)
