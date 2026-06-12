/**
 * CodeGraph Guidance — injects system-prompt guidelines when codegraph MCP tools are detected.
 *
 * Detects codegraph by checking registered tool names for the "codegraph_" prefix.
 * If found, injects usage guidance into the system prompt so the LLM knows how to
 * use codegraph efficiently instead of falling back to grep/read.
 *
 * 来源：迁移自 https://github.com/lcwecker/decorated-pi
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEGRAPH_GUIDANCE = [
	"### CodeGraph, code source map",
	"- This project's `codegraph_*` MCP tools are enabled. The graph is a pre-built index; grep/glob/Read of source code is repeating work the index already did.",
	"",
	"#### When to reach for it",
	'- Starting any task that touches code → `codegraph_explore("how does X work")` or `codegraph_files`',
	"- Looking for where a symbol is defined → `codegraph_search <name>`",
	"- Reading a function's body → `codegraph_node <name>` (or `codegraph_explore`)",
	"- Tracing call flow → `codegraph_callers` / `codegraph_callees`",
	"- Assessing refactor risk → `codegraph_impact <name>`",
	"",
	"#### Do NOT do this",
	"- `ls`, `find`, `grep -rn`, `rg` to discover symbols → use `codegraph_search`",
	"- `read` of an entire file to find a function → use `codegraph_explore` first",
	'- Reading 3+ files to understand a module → use `codegraph_explore("how does X work")`',
	"- `bash` with `cat`, `head`, `sed` to view source → use `codegraph_node` or `read` (single file only)",
	"",
	"#### If it errors",
	'- "Project not initialized" → ask the user to run `codegraph init -i` in their terminal',
	"- Empty results → fall back to grep/Read (the index is best-effort, not authoritative)",
	"- Tool timeout → `codegraph_status` to check; if indexer is dead, fall back",
].join("\n");

const MARKER = "### CodeGraph, code source map";

export default function codegraphGuidanceExtension(pi: ExtensionAPI) {
	// 每轮都尝试注入 guidance。通过闭包访问 pi.getActiveTools() 检测
	// codegraph 工具是否注册。如果不存在则跳过，避免污染 prompt。
	pi.on("before_agent_start", async (event) => {
		if (!event.systemPrompt) return undefined;
		// Already injected — skip
		if (event.systemPrompt.includes(MARKER)) return undefined;

		// Check if codegraph MCP tools are registered in this session
		const activeTools = pi.getActiveTools();
		const hasCodegraph = activeTools.some(
			(name) => name.startsWith("codegraph_"),
		);
		if (!hasCodegraph) return undefined;

		return {
			systemPrompt: event.systemPrompt + "\n\n" + CODEGRAPH_GUIDANCE,
		};
	});
}
