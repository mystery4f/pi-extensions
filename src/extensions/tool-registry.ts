/**
 * Tool Registry — bidirectional lookup between tools and the plugins that provide them.
 *
 * Provides the `registry` tool for the model:
 *   - by plugin: list every tool a plugin provides (plugin given as `npm:<pkg>` or `git:<owner>/<repo>`)
 *   - by tool:  report which plugin a named tool comes from
 *
 * Motivation: when a tool fails or behaves unexpectedly, the model needs to know
 * where it came from before guessing — e.g. deciding whether to read the plugin's
 * source, report a bug upstream, or look for a same-named tool from another plugin.
 *
 * Plugin identity is derived from `sourceInfo` the same way `tool-manager` renders it
 * in the picker: npm packages become `npm:<pkg>` and git checkouts become
 * `git:<owner>/<repo>`; built-in and other sources keep their source label with no
 * prefix. Tools with no resolvable plugin are grouped under their source label.
 *
 * `getAllTools()` is read from the extension API captured at registration time:
 * the tool `execute()` context exposes no tool listing.
 *
 * @author mystery4f
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ToolInfo } from "@earendil-works/pi-coding-agent";

/** A plugin key: `npm:<pkg>`, `git:<owner>/<repo>`, or a bare source label (builtin/sdk/mcp/...). */
type PluginKey = string;

type PluginEntry = {
	plugin: PluginKey;
	origin: "npm" | "git" | "source";
	/** Human-readable path hint: package name, owner/repo, or source label. */
	detail: string;
	scope?: string;
	tools: { name: string; description: string }[];
};

/**
 * Resolve the plugin key for one tool. Mirrors `pluginLabel()` in tool-manager:
 * package → `npm:<pkg>`, git checkout → `git:<owner>/<repo>`, otherwise the source label.
 */
function pluginOf(tool: ToolInfo): { key: PluginKey; origin: "npm" | "git" | "source"; detail: string } {
	const info = tool.sourceInfo;
	const source = info?.source ?? "extension";

	if (info?.path && info.origin === "package") {
		const segments = info.path.split(/[\\/]/);
		const nm = segments.lastIndexOf("node_modules");
		if (nm >= 0 && segments[nm + 1]) {
			const pkg = segments[nm + 1];
			const name = pkg.startsWith("@") ? `${pkg}/${segments[nm + 2]}` : pkg;
			return { key: `npm:${name}`, origin: "npm", detail: name };
		}
	}

	if (info?.path) {
		const segments = info.path.split(/[\\/]/);
		const git = segments.findIndex((seg) => seg === "git-github.com" || seg === "github.com");
		if (git >= 0) {
			const rest = segments
				.slice(git + 1)
				.filter((seg) => seg !== "." && !/^[0-9a-f]{6,}$/.test(seg));
			if (rest.length >= 2) {
				const repo = rest.slice(0, 2).join("/");
				return { key: `git:${repo}`, origin: "git", detail: repo };
			}
		}
	}

	// Non-package top-level extension file: group by its directory name.
	if (info?.path && info.origin !== "package") {
		const dir = info.baseDir ?? info.path.replace(/[\\/][^\\/]+$/, "");
		const base = dir.split(/[\\/]/).filter(Boolean).pop();
		if (base && ![".", "/", "\\"].includes(base)) {
			return { key: base, origin: "source", detail: base };
		}
	}

	return { key: source, origin: "source", detail: source };
}

/** Build the plugin → tools index, preserving registration order within each plugin. */
function buildIndex(tools: ToolInfo[]): Map<PluginKey, PluginEntry> {
	const index = new Map<PluginKey, PluginEntry>();
	for (const tool of tools) {
		const { key, origin, detail } = pluginOf(tool);
		let entry = index.get(key);
		if (!entry) {
			entry = {
				plugin: key,
				origin,
				detail,
				scope: tool.sourceInfo?.scope,
				tools: [],
			};
			index.set(key, entry);
		}
		entry.tools.push({
			name: tool.name,
			description: (tool.description ?? "").split("\n")[0] ?? "",
		});
	}
	return index;
}

/** Normalize a user-supplied plugin query to a comparable key. */
function normalizePluginQuery(query: string): string {
	let q = query.trim();
	if (!q) return q;
	// `git:github.com/owner/repo` and `github.com/owner/repo` both mean the same plugin.
	if (q.startsWith("git:")) q = q.slice(4);
	if (/^(github\.com[\\/])+/.test(q)) q = q.replace(/^(github\.com[\\/])+/, "");
	// Bare "owner/repo" reads as a git plugin; a name containing "/" or "@" reads as a package.
	if (/^[\w.-]+\/[\w.-]+$/.test(q)) return `git:${q}`;
	if (q.includes("/") || q.startsWith("@")) return `npm:${q}`;
	// A bare package name: try the npm plugin of that exact name (caller falls back further).
	return `npm:${q}`;
}

function makeRegistryTool(listTools: () => ToolInfo[]) {
	return defineTool({
	name: "registry",
	label: "Tool registry",
	description:
		"Look up the relationship between tools and the plugins that provide them. " +
		"Query by plugin (list its tools) or by tool (find its plugin). Plugins are " +
		"identified as npm:<pkg> or git:<owner>/<repo>. Use it before debugging a tool, " +
		"before writing a subagent's tools: whitelist or extensions: field, or to see " +
		"everything one plugin provides — one call returns the tool names instead of " +
		"reading the package source.",
	parameters: Type.Object({
		plugin: Type.Optional(
			Type.String({
				description:
					"Plugin to list tools for, as npm:<pkg> or git:<owner>/<repo> " +
					"(bare owner/repo or package name also accepted). Omit when querying by tool.",
			}),
		),
		tool: Type.Optional(
			Type.String({
				description:
					"Tool name to resolve to its providing plugin. Omit when querying by plugin.",
			}),
		),
		listPlugins: Type.Optional(
			Type.Boolean({
				description:
					"List every distinct plugin with its tool count (default: false). " +
					"Set true when you want an overview instead of a specific lookup.",
			}),
		),
	}),
	promptSnippet:
		"registry: find which plugin provides a tool, or which tools a plugin provides (npm:/git: ids)",
	promptGuidelines: [
		"Before debugging or reporting a failing tool, call `registry` with tool=<name> to learn which plugin provides it.",
		"To see every tool a plugin ships, call `registry` with plugin=npm:<pkg> or plugin=git:<owner>/<repo>.",
	],

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const all = listTools();
		const index = buildIndex(all);
		const lines: string[] = [];
		const details: { plugins?: PluginEntry[]; match?: PluginEntry; tool?: unknown } = {};

		if (params.listPlugins) {
			const entries = [...index.values()].sort((a, b) => b.tools.length - a.tools.length);
			details.plugins = entries;
			lines.push(`${entries.length} plugin(s), ${all.length} tool(s) total:`);
			for (const e of entries) {
				lines.push(`  ${e.plugin} — ${e.tools.length} tool(s)`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
			};
		}

		if (params.plugin) {
			const key = normalizePluginQuery(params.plugin);
			let entry = index.get(key);
			if (!entry) {
				// Fall back: suffix match on the query (bare name vs npm:/git: id),
				// then a case-insensitive comparison across all known plugins.
				const tail = params.plugin.trim().toLowerCase();
				const candidates = [...index.values()].filter((e) =>
					e.plugin.toLowerCase().endsWith(tail),
				);
				entry =
					candidates.length > 0
						? candidates[0]
						: [...index.values()].find((e) => e.plugin.toLowerCase() === tail);
			}
			if (!entry) {
				const known = [...index.keys()].sort();
				return {
					content: [
						{
							type: "text",
							text:
								`No plugin matching "${params.plugin}" (normalized: "${key}").\n` +
								`Known plugins:\n${known.map((k) => `  ${k}`).join("\n")}`,
						},
					],
					details: { known },
				};
			}
			details.match = entry;
			lines.push(`${entry.plugin} — ${entry.tools.length} tool(s):`);
			for (const t of entry.tools) {
				lines.push(`  ${t.name}${t.description ? ` — ${t.description}` : ""}`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
			};
		}

		if (params.tool) {
			const wanted = params.tool.trim();
			const hits = all.filter((t) => t.name === wanted);
			if (hits.length === 0) {
				const near = all.filter((t) => t.name.includes(wanted)).map((t) => t.name);
				return {
					content: [
						{
							type: "text",
							text:
								`No tool named "${wanted}".` +
								(near.length
									? `\nSimilar:\n${near.map((n) => `  ${n}`).join("\n")}`
									: ""),
						},
					],
					details: { similar: near },
				};
			}
			const resolved = hits.map((t) => {
				const { key, origin } = pluginOf(t);
				return {
					tool: t.name,
					plugin: key,
					origin,
					scope: t.sourceInfo?.scope,
					path: t.sourceInfo?.path,
					description: (t.description ?? "").split("\n")[0] ?? "",
				};
			});
			details.tool = resolved;
			for (const r of resolved) {
				lines.push(
					`${r.tool} → ${r.plugin}` +
						(r.scope ? ` (scope: ${r.scope})` : "") +
						(r.path ? `\n  path: ${r.path}` : ""),
				);
				if (r.description) lines.push(`  ${r.description}`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
			};
		}

		return {
			content: [
				{
					type: "text",
					text:
						"Specify one of: plugin (npm:<pkg> / git:<owner>/<repo>), tool (<name>), " +
						"or listPlugins=true.",
				},
			],
			details,
		};
	},
	});
}

export default function toolRegistry(pi: ExtensionAPI) {
	pi.registerTool(makeRegistryTool(() => pi.getAllTools()));
}
