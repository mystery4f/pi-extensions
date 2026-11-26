/**
 * settings-store — contract tests for the shared settings reader/writer.
 *
 * Run: node --test src/extensions/__tests__/settings-store.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isJsonObject, readSettings, writeSettings } from "../settings-store.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-store-"));
}

describe("isJsonObject", () => {
	test("accepts a plain object", () => {
		assert.equal(isJsonObject({ a: 1 }), true);
	});

	test("rejects arrays, null and primitives", () => {
		assert.equal(isJsonObject([]), false);
		assert.equal(isJsonObject(null), false);
		assert.equal(isJsonObject("x"), false);
		assert.equal(isJsonObject(3), false);
	});
});

describe("readSettings", () => {
	test("missing file reads as an empty object", () => {
		const dir = tempDir();
		try {
			assert.deepEqual(readSettings(path.join(dir, "absent.json")), {});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("unparsable file reads as null", () => {
		const dir = tempDir();
		try {
			const file = path.join(dir, "settings.json");
			fs.writeFileSync(file, "{ not json", "utf-8");
			assert.equal(readSettings(file), null);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("non-object top level reads as null", () => {
		const dir = tempDir();
		try {
			const file = path.join(dir, "settings.json");
			fs.writeFileSync(file, "[1,2]", "utf-8");
			assert.equal(readSettings(file), null);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("valid file reads as its object", () => {
		const dir = tempDir();
		try {
			const file = path.join(dir, "settings.json");
			fs.writeFileSync(file, '{"autoAddDir":{"rules":[]}}', "utf-8");
			assert.deepEqual(readSettings(file), { autoAddDir: { rules: [] } });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("writeSettings", () => {
	test("creates missing parents and round-trips the object", () => {
		const dir = tempDir();
		try {
			const file = path.join(dir, "nested", "deep", "settings.json");
			assert.equal(writeSettings(file, { autoAddDir: { rules: [] } }), true);
			assert.deepEqual(readSettings(file), { autoAddDir: { rules: [] } });
			assert.match(fs.readFileSync(file, "utf-8"), /^\{\n {2}"autoAddDir": \{/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reports false when the target cannot be written", () => {
		const dir = tempDir();
		try {
			const blocked = path.join(dir, "settings.json");
			fs.mkdirSync(blocked);
			assert.equal(writeSettings(blocked, { a: 1 }), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
