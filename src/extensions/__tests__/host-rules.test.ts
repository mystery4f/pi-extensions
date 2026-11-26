/**
 * host-rules — contract tests for the hostname → code rules.
 *
 * Run: node --test src/extensions/__tests__/host-rules.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
	hostFileOf,
	isSafeCode,
	parseHostRules,
	resolveHostCodes,
} from "../host-rules.ts";

describe("isSafeCode", () => {
	test("accepts a plain code, mixed case and dots", () => {
		for (const code of ["kfCode", "home", "home-2", "a.b"]) {
			assert.equal(isSafeCode(code), true, code);
		}
	});

	test("refuses anything that could leave the directory", () => {
		for (const code of [
			"",
			"../kfCode",
			"a/b",
			"a\\b",
			"C:x",
			".hidden",
			"kf Code",
			"kfCode ",
		]) {
			assert.equal(isSafeCode(code), false, code);
		}
	});
});

describe("parseHostRules", () => {
	test("returns no rules for a missing or non-array value", () => {
		assert.deepEqual(parseHostRules(undefined), []);
		assert.deepEqual(parseHostRules(null), []);
		assert.deepEqual(parseHostRules("desktop"), []);
	});

	test("normalizes the host with the same folding deviceName() applies", () => {
		const rules = parseHostRules([
			{ host: "DESKTOP-3UBEPM3", codes: ["kfCode"] },
			{ host: " Work PC ", codes: ["homeCode"] },
		]);
		assert.deepEqual(rules, [
			{ host: "desktop-3ubepm3", codes: ["kfCode"] },
			{ host: "work-pc", codes: ["homeCode"] },
		]);
	});

	test("drops a malformed rule instead of guessing it", () => {
		const rules = parseHostRules([
			{ codes: ["kfCode"] },
			{ host: "", codes: ["kfCode"] },
			{ host: "pc-a", codes: "kfCode" },
			{ host: "pc-b", codes: ["../escape"] },
			{ host: "pc-c", codes: [] },
			{ host: "pc-d", codes: [" kfCode ", 7, null] },
			"pc-e",
		]);
		assert.deepEqual(rules, [{ host: "pc-d", codes: ["kfCode"] }]);
	});
});

describe("resolveHostCodes", () => {
	const rules = parseHostRules([
		{ host: "pc-a", codes: ["kfCode", "shared"] },
		{ host: "pc-b", codes: ["homeCode"] },
		{ host: "PC-A", codes: ["KFCode", "extra"] },
	]);

	test("matches the device after folding, whatever the config case", () => {
		assert.deepEqual(resolveHostCodes(rules, "PC-A"), ["kfCode", "shared", "extra"]);
	});

	test("keeps rule order and yields each code once, first spelling winning", () => {
		const codes = resolveHostCodes(rules, "pc-a");
		assert.deepEqual(codes, ["kfCode", "shared", "extra"]);
		assert.equal(codes.filter((c) => c.toLowerCase() === "kfcode").length, 1);
	});

	test("returns nothing for a host no rule names", () => {
		assert.deepEqual(resolveHostCodes(rules, "pc-z"), []);
		assert.deepEqual(resolveHostCodes([], "pc-a"), []);
	});
});

describe("hostFileOf", () => {
	test("names the file after the code, inside the given directory", () => {
		assert.equal(
			hostFileOf("kfCode", path.join("/home", "u", ".pi", "agent")),
			path.join("/home", "u", ".pi", "agent", "AGENTS-kfCode.md"),
		);
	});
});
