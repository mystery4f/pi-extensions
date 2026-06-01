# pi-extensions

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A collection of [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extensions — plug-and-play enhancements for your AI coding workflow.

## 🧩 Included Extensions

| Extension | Description |
|---|---|
| [extra-agents-files](#extra-agents-files) | 按标签条件加载额外的上下文文件到 system prompt |
| [auto-add-dir](#auto-add-dir) | 检测用户输入中的关键词，自动将对应目录加入会话 |

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
      { "path": "AGENTS-Java.md", "tags": ["Java"] },
      { "path": "AGENTS-frontend.md", "tags": ["frontend"] },
      { "path": "AGENTS-general.md" }
    ],
    "includes": ["Java"]
  }
}
```

| 字段 | 说明 |
|---|---|
| `files` | 文件列表，每项为路径字符串或 `{ path, tags? }` 对象 |
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
- 🧠 **智能注入** — 第一轮通过 system prompt 指令，后续轮次追加用户消息提醒
- 🛡️ **保底机制** — 自动读取目录下的 `AGENTS.md` / `CLAUDE.md` 作为后备上下文
- 🔁 **去重** — 同一 session 中每个目录只触发一次
- 🌍 **变量替换** — `dir` 支持 `${VAR}` 占位符，从 `env.json` 或系统环境变量解析
- 📝 **调试日志** — 写入 `%TEMP%/auto-add-dir.log`，排查配置问题

**配置** (`~/.pi/agent/settings.json` → `"autoAddDir"` 字段)：

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
| `rules[].keywords` | `string[]` | 触发关键词（不区分大小写） |
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
        └── auto-add-dir.ts
```

添加新扩展：在 `src/extensions/` 下新建文件，然后在 `index.ts` 中注册即可。

## License

[MIT](LICENSE)
