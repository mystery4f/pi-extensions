/**
 * Extra Context Files Extension
 *
 * Loads additional context files into the system prompt, configured via
 * settings.json at both global and project levels.
 *
 * Global settings (~/.pi/agent/settings.json):
 *
 *   {
 *     "extraContextFiles": [
 *       { "path": "AGENTS-Java.md", "tags": ["Java"] },
 *       { "path": "AGENTS-frontend.md", "tags": ["frontend"] },
 *       { "path": "AGENTS-general.md" }
 *     ]
 *   }
 *
 *   - "tags": string array — only loaded when project includes a matching tag
 *   - No tags = always loaded (unconditional)
 *   - Paths resolve relative to ~/.pi/agent
 *
 * Project settings (.pi/settings.json):
 *
 *   {
 *     "extraContextIncludes": ["Java"]
 *   }
 *
 *   - Declares which tags the project needs
 *   - A global file is loaded if it has no tags OR any of its tags match
 *
 * Absolute paths and ~ are supported.
 *
 * Placement: ~/.pi/agent/extensions/extra-agents-files.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ExtraFile {
	displayPath: string;
	content: string;
}

type FileEntry = string | { path: string; tags?: string[] };

function readJSON(filePath: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function resolveFilePath(filePath: string, baseDir: string): string {
	if (filePath.startsWith("~")) {
		return path.join(os.homedir(), filePath.slice(1));
	}
	return path.resolve(baseDir, filePath);
}

function normalizeFileEntry(entry: FileEntry): { filePath: string; tags: string[] } {
	if (typeof entry === "string") {
		return { filePath: entry, tags: [] };
	}
	return { filePath: entry.path, tags: entry.tags ?? [] };
}

/**
 * Check if a file's tags match the project's includes.
 * Files with no tags are always loaded.
 */
function matches(tags: string[], includes: Set<string>): boolean {
	if (tags.length === 0) return true;
	return tags.some((tag) => includes.has(tag));
}

/**
 * Read extraContextFiles from a settings.json file.
 * Optionally filters by the project's extraContextIncludes.
 */
function loadFromSettings(
	settingsPath: string,
	baseDir: string,
	seen: Set<string>,
	includes?: Set<string>,
): ExtraFile[] {
	const results: ExtraFile[] = [];
	const raw = readJSON(settingsPath);
	if (!raw || !Array.isArray(raw.extraContextFiles)) return results;

	for (const entry of raw.extraContextFiles as FileEntry[]) {
		const { filePath, tags } = normalizeFileEntry(entry);

		// Filter by includes (only for global settings)
		if (includes !== undefined && !matches(tags, includes)) continue;

		const resolved = resolveFilePath(filePath, baseDir);
		if (seen.has(resolved)) continue;

		try {
			const content = fs.readFileSync(resolved, "utf-8");
			seen.add(resolved);
			results.push({ displayPath: filePath, content });
		} catch {
			// skip unreadable files
		}
	}

	return results;
}

/**
 * Collect extra context files from both global and project settings.
 */
function collectExtraFiles(cwd: string): ExtraFile[] {
	const results: ExtraFile[] = [];
	const seen = new Set<string>();
	const homeDir = os.homedir();

	// Read project includes first (needed to filter global files)
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	const projectRaw = readJSON(projectSettingsPath);
	const includes = new Set<string>(
		Array.isArray(projectRaw?.extraContextIncludes)
			? (projectRaw.extraContextIncludes as string[])
			: [],
	);

	// 1. Global settings: ~/.pi/agent/settings.json (resolve relative to ~/.pi/agent)
	const globalSettingsPath = path.join(homeDir, ".pi", "agent", "settings.json");
	const globalBase = path.join(homeDir, ".pi", "agent");
	for (const f of loadFromSettings(globalSettingsPath, globalBase, seen, includes)) {
		results.push(f);
	}

	// 2. Project settings: .pi/settings.json (resolve relative to cwd, no tag filtering)
	for (const f of loadFromSettings(projectSettingsPath, cwd, seen)) {
		results.push(f);
	}

	return results;
}

export default function extraAgentsFilesExtension(pi: ExtensionAPI) {
	let extraFiles: ExtraFile[] = [];

	pi.on("session_start", async (_event, ctx) => {
		extraFiles = collectExtraFiles(ctx.cwd);

		if (extraFiles.length > 0) {
			ctx.ui.notify(
				`Loaded ${extraFiles.length} extra context file(s): ${extraFiles.map((f) => f.displayPath).join(", ")}`,
				"info",
			);
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (extraFiles.length === 0) return;

		const sections = extraFiles
			.map((f) => `### ${f.displayPath}\n\n${f.content}`)
			.join("\n\n");

		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Extra Project Context\n\n${sections}`,
		};
	});
}
