/**
 * tool-registry — contract tests for the parameterless inventory tools.
 *
 * Covers `registry_tools` (tool → plugin) and `registry_plugins` (plugin → tool
 * count), driven through the extension's public registration seam so the test
 * breaks when registration is dropped, not when the index is refactored.
 *
 * Run: node --import tsx --test src/extensions/__tests__/tool-registry.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Type } from "typebox";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

import toolRegistry from "../tool-registry.ts";

const parameters = Type.Object({});

function fakeTool(name: string, path: string, origin: "package" | "top-level"): ToolInfo {
	return {
		name,
		description: `${name} does something.\nSecond line is ignored.`,
		parameters,
		exposure: "direct",
		sourceInfo: { path, source: "extension", scope: "user", origin },
	} as unknown as ToolInfo;
}

const tools: ToolInfo[] = [
	fakeTool("alpha", "C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\pi-foo\\index.js", "package"),
	fakeTool(
		"beta",
		"C:\\Users\\me\\.pi\\agent\\git\\github.com\\acme\\plugin\\index.ts",
		"top-level",
	),
];

/** Registered tool definitions, captured from the registration seam. */
function registeredTools() {
	const captured: { name: string; execute: (...args: any[]) => Promise<any> }[] = [];
	const pi = {
		getAllTools: () => tools,
		registerTool: (tool: { name: string }) => captured.push(tool as never),
	} as unknown as ExtensionAPI;
	toolRegistry(pi);
	return captured;
}

async function run(name: string) {
	const tool = registeredTools().find((candidate) => candidate.name === name);
	assert.ok(tool, `${name} must be registered`);
	const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);
	return result.content.map((part: { text: string }) => part.text).join("\n");
}

describe("tool-registry inventories", () => {
	test("registry_tools lists every tool with its plugin", async () => {
		const text = await run("registry_tools");
		assert.equal(
			text,
			["2 tool(s):", "  alpha — npm:pi-foo", "  beta — git:acme/plugin"].join("\n"),
		);
	});

	test("registry_plugins lists plugins with tool counts, heaviest first", async () => {
		const text = await run("registry_plugins");
		assert.equal(
			text,
			["2 plugin(s):", "  npm:pi-foo — 1 tool(s)", "  git:acme/plugin — 1 tool(s)"].join("\n"),
		);
	});

	test("registry stays the query tool and takes the same plugin ids", async () => {
		const captured = registeredTools();
		const registry = captured.find((candidate) => candidate.name === "registry");
		assert.ok(registry);
		const result = await registry.execute(
			"call-2",
			{ tool: "beta" },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content.map((part: { text: string }) => part.text).join("\n");
		assert.match(text, /^beta → git:acme\/plugin/);
	});
});
