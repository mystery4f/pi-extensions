/**
 * tool-manager-usage — contract tests for the per-device usage files.
 *
 * Run: node --test src/extensions/__tests__/tool-manager-usage.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	clearUsage,
	createUsageRecorder,
	deviceName,
	formatUsageTable,
	listUsageFiles,
	mergeUsageFiles,
	parseUsageLines,
	usageFile,
} from "../tool-manager-usage.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tool-manager-usage-"));
}

function writeFile(dir: string, name: string, lines: unknown[]): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
	return file;
}

describe("deviceName", () => {
	test("folds unsafe characters into dashes and lowercases", () => {
		assert.equal(deviceName("My Laptop/PC"), "my-laptop-pc");
	});

	test("falls back to unknown when the sanitized name is empty", () => {
		assert.equal(deviceName("  ///  "), "unknown");
	});
});

describe("parseUsageLines", () => {
	test("drops blank, malformed and non-object lines", () => {
		const text = '{"tool":"bash","count":1}\n\nnot json\n[1,2]\n{"tool":"read","count":2}\n';
		assert.deepEqual(
			parseUsageLines(text).map((line) => line.tool),
			["bash", "read"],
		);
	});
});

describe("mergeUsageFiles", () => {
	test("sums counts and errors across device files and keeps the latest ts", () => {
		const dir = tempDir();
		writeFile(dir, "usage-a.jsonl", [
			{ v: 1, ts: "2026-11-01T10:00:00.000Z", device: "a", tool: "bash", count: 3, errors: 1 },
		]);
		writeFile(dir, "usage-b.jsonl", [
			{ v: 1, ts: "2026-11-09T10:00:00.000Z", device: "b", tool: "bash", count: 4, errors: 0 },
			{ v: 1, ts: "2026-11-02T10:00:00.000Z", device: "b", tool: "read", count: 2, errors: 0 },
		]);
		const usage = mergeUsageFiles(listUsageFiles(dir));
		assert.deepEqual(usage.get("bash"), {
			count: 7,
			errors: 1,
			lastUsed: "2026-11-09T10:00:00.000Z",
		});
		assert.equal(usage.get("read")?.count, 2);
	});

	test("keeps tool names case-sensitive", () => {
		const dir = tempDir();
		writeFile(dir, "usage-a.jsonl", [
			{ ts: "2026-11-01T00:00:00.000Z", tool: "Bash", count: 1 },
			{ ts: "2026-11-01T00:00:00.000Z", tool: "bash", count: 1 },
		]);
		const usage = mergeUsageFiles(listUsageFiles(dir));
		assert.equal(usage.size, 2);
	});

	test("ignores non-positive or non-numeric counts", () => {
		const dir = tempDir();
		writeFile(dir, "usage-a.jsonl", [
			{ tool: "bash", count: "12" },
			{ tool: "read", count: 0 },
			{ tool: "grep", count: 5 },
		]);
		const usage = mergeUsageFiles(listUsageFiles(dir));
		assert.equal(usage.get("bash")?.count ?? 0, 0);
		assert.equal(usage.get("read")?.count, 0);
		assert.equal(usage.get("grep")?.count, 5);
	});
});

describe("createUsageRecorder", () => {
	test("appends one aggregated line per tool and appends again on the next flush", () => {
		const dir = tempDir();
		const clock = () => new Date("2026-11-11T08:00:00.000Z");
		const recorder = createUsageRecorder({ device: "pc", dir, clock });

		recorder.record("bash", false);
		recorder.record("bash", true);
		recorder.record("read", false);
		assert.equal(recorder.pendingCount(), 2);

		recorder.flush();
		assert.equal(recorder.pendingCount(), 0);

		recorder.record("bash", false);
		recorder.flush();

		const lines = fs
			.readFileSync(usageFile("pc", dir), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(lines.length, 3);
		assert.deepEqual(lines[0], {
			v: 1,
			ts: "2026-11-11T08:00:00.000Z",
			device: "pc",
			tool: "bash",
			count: 2,
			errors: 1,
		});
		assert.equal(lines[2].count, 1);
	});

	test("flush with nothing pending leaves no file behind", () => {
		const dir = tempDir();
		createUsageRecorder({ device: "pc", dir }).flush();
		assert.deepEqual(listUsageFiles(dir), []);
	});
});

describe("clearUsage", () => {
	test("removes only this device's file unless all is requested", () => {
		const dir = tempDir();
		writeFile(dir, "usage-pc.jsonl", [{ tool: "bash", count: 1 }]);
		writeFile(dir, "usage-laptop.jsonl", [{ tool: "read", count: 1 }]);

		assert.equal(clearUsage("pc", dir), 1);
		assert.deepEqual(
			listUsageFiles(dir).map((file) => path.basename(file)),
			["usage-laptop.jsonl"],
		);

		assert.equal(clearUsage("pc", dir, true), 1);
		assert.deepEqual(listUsageFiles(dir), []);
	});
});

describe("formatUsageTable", () => {
	test("orders rows by count, pads wide names and totals every row", () => {
		const usage = new Map([
			["read", { count: 2, errors: 0, lastUsed: "2026-11-02T00:00:00.000Z" }],
			["bash", { count: 9, errors: 1, lastUsed: "2026-11-11T00:00:00.000Z" }],
		]);
		const lines = formatUsageTable(usage).join("\n");
		assert.ok(lines.indexOf("bash") < lines.indexOf("read"));
		assert.match(lines, /2026-11-11/);
		assert.match(lines, /合计\s+11\s+1/);
	});
});
