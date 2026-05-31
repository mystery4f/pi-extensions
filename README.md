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

## Install

```bash
pi install mystery4f/pi-extensions
```

## License

MIT
