/**
 * Host rules — which device codes the current machine carries.
 *
 * A rule maps one host to a list of codes; a code names exactly one context
 * file, `AGENTS-<code>.md`. Both directions are many-to-many: a host may carry
 * several codes, and one code may be listed under several hosts.
 *
 * Pure logic only: the caller resolves the settings file and reads the file
 * system, so every rule here is testable without a home directory.
 */

import * as path from "node:path";

import { normalizeDeviceName } from "./tool-manager-usage.js";

/** One decoded entry of `extraContext.hostRules`. */
export interface HostRule {
	/** Normalized host name — the same folding `deviceName()` applies. */
	host: string;
	/** Codes this host carries, already validated and in config order. */
	codes: string[];
}

/**
 * A code turns into a filename, so it may not escape the directory: no
 * separator, no drive letter, no `..` segment, no leading dot.
 */
export function isSafeCode(code: string): boolean {
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(code)) return false;
	return !code.includes("..");
}

/**
 * Decode `extraContext.hostRules` from settings.
 * Malformed rules are dropped, never guessed: a half-typed rule must not
 * inject a file the user did not ask for.
 */
export function parseHostRules(raw: unknown): HostRule[] {
	if (!Array.isArray(raw)) return [];

	const rules: HostRule[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const { host, codes } = entry as { host?: unknown; codes?: unknown };
		if (typeof host !== "string" || host.trim() === "") continue;
		if (!Array.isArray(codes)) continue;

		const kept = codes
			.filter((code): code is string => typeof code === "string")
			.map((code) => code.trim())
			.filter((code) => code !== "" && isSafeCode(code));
		if (kept.length === 0) continue;

		rules.push({ host: normalizeDeviceName(host.trim()), codes: kept });
	}
	return rules;
}

/**
 * Codes carried by `device`, in rule order, each once.
 * Deduplication is case-insensitive because the file system may be, and the
 * first spelling wins.
 */
export function resolveHostCodes(rules: readonly HostRule[], device: string): string[] {
	const wanted = normalizeDeviceName(device);
	const codes: string[] = [];
	const seen = new Set<string>();

	for (const rule of rules) {
		if (rule.host !== wanted) continue;
		for (const code of rule.codes) {
			const key = code.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			codes.push(code);
		}
	}
	return codes;
}

/** Where a code's context file lives: `<dir>/AGENTS-<code>.md`. */
export function hostFileOf(code: string, dir: string): string {
	return path.join(dir, `AGENTS-${code}.md`);
}
