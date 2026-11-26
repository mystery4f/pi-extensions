/**
 * auto-add-dir — save/remove round-trip against real settings files.
 *
 * Covers the malformed-`autoAddDir` shapes issue #1 called out: a write must
 * repair the bag instead of throwing, and an unparsable file must be left alone.
 *
 * Run: node --test src/extensions/__tests__/auto-add-dir-settings.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { removeRuleFromSettings, saveRuleToSettings } from "../auto-add-dir.ts";
import { readSettings } from "../settings-store.ts";

const RULE = { dir: "~/work/alpha", description: "Alpha repo", keywords: ["alpha"] };

function withSettings(content: string | null, run: (file: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-add-dir-"));
	try {
		const file = path.join(dir, "settings.json");
		if (content !== null) fs.writeFileSync(file, content, "utf-8");
		run(file);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function rulesOf(file: string): unknown[] {
	const settings = readSettings(file);
	const bag = settings?.autoAddDir;
	if (!bag || typeof bag !== "object" || Array.isArray(bag)) return [];
	const rules = (bag as { rules?: unknown }).rules;
	return Array.isArray(rules) ? rules : [];
}

describe("saveRuleToSettings", () => {
	test("creates the file and the rules array", () => {
		withSettings(null, (file) => {
			assert.equal(saveRuleToSettings(file, RULE), true);
			assert.deepEqual(rulesOf(file), [RULE]);
		});
	});

	test("repairs a string autoAddDir and keeps unrelated keys", () => {
		withSettings('{"theme":"dark","autoAddDir":"garbage"}', (file) => {
			assert.equal(saveRuleToSettings(file, RULE), true);
			assert.deepEqual(rulesOf(file), [RULE]);
			assert.equal(readSettings(file)?.theme, "dark");
		});
	});

	test("repairs a non-array rules value", () => {
		withSettings('{"autoAddDir":{"rules":"nope"}}', (file) => {
			assert.equal(saveRuleToSettings(file, RULE), true);
			assert.deepEqual(rulesOf(file), [RULE]);
		});
	});

	test("updates a rule with the same dir instead of duplicating it", () => {
		withSettings(null, (file) => {
			saveRuleToSettings(file, RULE);
			assert.equal(saveRuleToSettings(file, { ...RULE, description: "Renamed" }), true);
			const rules = rulesOf(file) as { dir: string; description: string }[];
			assert.equal(rules.length, 1);
			assert.equal(rules[0]?.description, "Renamed");
		});
	});

	test("refuses to overwrite an unparsable settings file", () => {
		withSettings("{ broken", (file) => {
			assert.equal(saveRuleToSettings(file, RULE), false);
			assert.equal(fs.readFileSync(file, "utf-8"), "{ broken");
		});
	});
});

describe("removeRuleFromSettings", () => {
	test("removes the matching rule and keeps the rest", () => {
		withSettings(null, (file) => {
			saveRuleToSettings(file, RULE);
			saveRuleToSettings(file, { dir: "~/work/beta", description: "Beta repo" });
			assert.equal(removeRuleFromSettings(file, RULE.dir), true);
			const dirs = (rulesOf(file) as { dir: string }[]).map((r) => r.dir);
			assert.deepEqual(dirs, ["~/work/beta"]);
		});
	});

	test("reports false when nothing matches", () => {
		withSettings(null, (file) => {
			saveRuleToSettings(file, RULE);
			assert.equal(removeRuleFromSettings(file, "~/work/absent"), false);
		});
	});

	test("reports false on a malformed bag", () => {
		withSettings('{"autoAddDir":"garbage"}', (file) => {
			assert.equal(removeRuleFromSettings(file, RULE.dir), false);
		});
	});
});
