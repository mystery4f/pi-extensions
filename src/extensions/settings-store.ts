/**
 * Settings store — one owner for the `settings.json` bag that several extensions read and write.
 *
 * A settings file is a `JsonObject`: values stay `unknown` until the code that needs them narrows
 * them, so a malformed value is caught there instead of being trusted as `any` down to the write.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** A parsed JSON object whose values are still unvalidated. */
export type JsonObject = Record<string, unknown>;

/** True for a plain JSON object: not null, not an array. */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a settings file.
 *
 * Missing file → `{}`, so a caller may create it. Unparseable or non-object JSON → `null`, so a
 * caller refuses to clobber a file it cannot understand.
 */
export function readSettings(settingsPath: string): JsonObject | null {
	if (!fs.existsSync(settingsPath)) return {};
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		return isJsonObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Write a settings bag back with two-space indent, creating its directory. */
export function writeSettings(settingsPath: string, settings: JsonObject): boolean {
	const dir = path.dirname(settingsPath);
	if (!fs.existsSync(dir)) {
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch {
			return false;
		}
	}
	try {
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
		return true;
	} catch {
		return false;
	}
}
