/**
 * tool-manager-picker — contract tests for the /tools TUI input handling.
 *
 * Covers the two behaviours that are easy to regress and hard to see by hand:
 * pasted text reaching the search query, and the detail panel scrolling instead
 * of truncating content.
 *
 * Run: node --test src/extensions/__tests__/tool-manager-picker.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ToolManagerPicker } from "../tool-manager.ts";

type PickerTheme = ConstructorParameters<typeof ToolManagerPicker>[0];
type PickerRow = ConstructorParameters<typeof ToolManagerPicker>[2][number];

/** Colour functions are identity here: assertions read plain text. */
const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as PickerTheme;

const longDescription = Array.from(
	{ length: 40 },
	(_unused, index) => `sentence ${index + 1} of a deliberately long description.`,
).join(" ");

const rows: PickerRow[] = [
	{
		name: "read_file",
		source: "extension",
		description: "Read a file from disk.",
	},
	{
		name: "long_tool",
		source: "extension",
		description: longDescription,
	},
];

function createPicker(): ToolManagerPicker {
	return new ToolManagerPicker(
		theme,
		() => {},
		rows,
		() => new Set(rows.map((row) => row.name)),
	);
}

function renderText(picker: ToolManagerPicker): string[] {
	return picker.render(112);
}

/** The search line is the only one carrying the "█" cursor marker. */
function searchLine(picker: ToolManagerPicker): string {
	const line = renderText(picker).find((row) => row.includes("█"));
	assert.ok(line, "search line not rendered");
	return line;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

describe("paste into the search query", () => {
	test("a paste inside search appends its payload", () => {
		const picker = createPicker();
		picker.handleInput("/");
		picker.handleInput(`${PASTE_START}read${PASTE_END}`);
		assert.match(searchLine(picker), /\/\[tool\] read█/);
	});

	test("a paste outside search opens the search with its payload", () => {
		const picker = createPicker();
		picker.handleInput(`${PASTE_START}long_tool${PASTE_END}`);
		assert.match(searchLine(picker), /\/\[tool\] long_tool█/);
	});

	test("a paste split over several chunks is reassembled", () => {
		const picker = createPicker();
		picker.handleInput("/");
		picker.handleInput(`${PASTE_START}rea`);
		picker.handleInput("d_file");
		picker.handleInput(PASTE_END);
		assert.match(searchLine(picker), /\/\[tool\] read_file█/);
	});

	test("newlines and control characters collapse into single spaces", () => {
		const picker = createPicker();
		picker.handleInput("/");
		picker.handleInput(`${PASTE_START}read\n\tdone\r\n${PASTE_END}`);
		assert.match(searchLine(picker), /\/\[tool\] read done█/);
	});

	test("keys typed after the closing marker are handled normally", () => {
		const picker = createPicker();
		picker.handleInput("/");
		picker.handleInput(`${PASTE_START}read${PASTE_END}x`);
		assert.match(searchLine(picker), /\/\[tool\] readx█/);
	});
});

describe("detail panel scrolling", () => {
	const detailSection = (picker: ToolManagerPicker): string[] => {
		const text = renderText(picker);
		const start = text.findIndex((line) => line.includes("long_tool"));
		return text.slice(start);
	};

	test('"d" opens the detail panel from the list', () => {
		const picker = createPicker();
		picker.handleInput("d");
		// The first row is read_file, so its detail must be on screen.
		const detail = renderText(picker).join("\n");
		assert.match(detail, /read_file {2}extension/);
		assert.match(detail, /desc: Read a file from disk\./);
	});

	test("content taller than the viewport is reachable by scrolling", () => {
		const picker = createPicker();
		picker.handleInput("\x1b[B"); // down arrow: move to long_tool
		picker.handleInput("d");
		const first = detailSection(picker).join("\n");
		assert.match(first, /lines 1-/);

		for (let i = 0; i < 30; i++) picker.handleInput("\x1b[B"); // down
		picker.handleInput("\x1b[6~"); // pageDown
		const last = detailSection(picker).join("\n");
		assert.notEqual(last, first);
		// The tail of the description is only visible after scrolling.
		assert.match(last, /deliberately long description/);
	});

	test("ctrl+end jumps to the end of the detail content", () => {
		const picker = createPicker();
		picker.handleInput("\x1b[B"); // down arrow
		picker.handleInput("d");
		picker.handleInput("\x1b[1;5F"); // ctrl+end
		const detail = detailSection(picker).join("\n");
		assert.match(detail, /deliberately long description/);
	});

	test("changing the row resets the detail scroll", () => {
		const picker = createPicker();
		picker.handleInput("\x1b[B"); // down arrow
		picker.handleInput("d");
		picker.handleInput("\x1b[1;5F");
		assert.match(detailSection(picker).join("\n"), /deliberately long description/);
		picker.handleInput("\x1bp"); // alt+up: row up while the panel is open
		assert.match(detailSection(picker).join("\n"), /Read a file from disk/);
	});
});
