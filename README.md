# pi-extensions

A collection of [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extensions.

## Extensions

### extra-agents-files

Loads additional context files into the system prompt, configured via `settings.json` at both global and project levels.

**Global settings** (`~/.pi/agent/settings.json`):

```json
{
  "extraContextFiles": [
    { "path": "AGENTS-Java.md", "tags": ["Java"] },
    { "path": "AGENTS-frontend.md", "tags": ["frontend"] },
    { "path": "AGENTS-general.md" }
  ]
}
```

- `"tags"`: string array — only loaded when project includes a matching tag
- No tags = always loaded (unconditional)
- Paths resolve relative to `~/.pi/agent`

**Project settings** (`.pi/settings.json`):

```json
{
  "extraContextIncludes": ["Java"]
}
```

- Declares which tags the project needs
- A global file is loaded if it has no tags OR any of its tags match

Absolute paths and `~` are supported.

### auto-add-dir

当用户提及特定关键词时，自动将对应目录加入会话。

**工作原理**：

1. **`input` 事件**：匹配关键词 → 记录匹配的目录
   - 第一轮匹配：只记录，靠 system prompt 注入
   - 中间轮次匹配：记录 + transform 用户消息追加提醒（LLM 遵循率更高）
2. **`before_agent_start` 事件**：在 system prompt 中注入「强制调用 `add_directory`」指令，同时注入 CLAUDE.md / AGENTS.md 内容作为保底

**配置** (`~/.pi/agent/settings.json` → `"autoAddDir"` 字段)：

```json
{
  "autoAddDir": {
    "rules": [
      {
        "keywords": ["obsidian", "vault", "笔记"],
        "dir": "${NOTES_PATH}",
        "description": "Obsidian Vault"
      }
    ]
  }
}
```

`dir` 支持 `${VAR}` 占位符，从 `~/.pi/agent/env.json` 或系统环境变量解析。

## Install

```bash
pi install mystery4f/pi-extensions
```

## License

MIT
