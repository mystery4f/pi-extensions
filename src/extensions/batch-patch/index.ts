/**
 * Batch-Patch Extension — enhanced edit tool with batch and Codex-patch support.
 *
 * Supports all original parameters (path, oldText, newText) plus:
 * - `multi`: array of {path, oldText, newText} edits applied in sequence
 * - `patch`: Codex-style apply_patch payload
 *
 * When both top-level params and `multi` are provided, the top-level edit
 * is treated as an implicit first item prepended to the multi list.
 *
 * A preflight pass is performed before mutating files:
 * - multi/top-level mode: preflight via virtualized built-in edit tool
 * - patch mode: preflight by applying patch operations on a virtual filesystem
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { applyClassicEdits } from "./classic.js";
import { applyPatchOperations, parsePatch } from "./patch.js";
import type { EditItem } from "./types.js";
import { createRealWorkspace, createVirtualWorkspace } from "./workspace.js";

const editItemSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Path to the file to edit (relative or absolute). Inherits from top-level path if omitted.",
    }),
  ),
  oldText: Type.String({
    description: "Exact text to find and replace (must match exactly)",
  }),
  newText: Type.String({
    description: "New text to replace the old text with",
  }),
});

const batchPatchSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description: "Path to the file to edit (relative or absolute)",
    }),
  ),
  oldText: Type.Optional(
    Type.String({
      description: "Exact text to find and replace (must match exactly)",
    }),
  ),
  newText: Type.Optional(
    Type.String({ description: "New text to replace the old text with" }),
  ),
  multi: Type.Optional(
    Type.Array(editItemSchema, {
      description:
        "Multiple edits to apply in sequence. Each item has path, oldText, and newText.",
    }),
  ),
  patch: Type.Optional(
    Type.String({
      description:
        "Codex-style apply_patch payload (*** Begin Patch ... *** End Patch). Mutually exclusive with path/oldText/newText/multi.",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "batch_patch",
    label: "batch_patch",
    description:
      "Edit files with batch edits and Codex-style patches. Supports `multi` (array of edits) and `patch` (Codex-style apply_patch) parameters.",
    promptSnippet:
      "Edit files with batch edits and Codex-style patches.",
    promptGuidelines: [
      "Use batch_patch for precise changes (old text must match exactly)",
      "Use the `multi` parameter to apply multiple edits in a single tool call",
      "Use the `patch` parameter for Codex-style multi-file / hunk-based edits",
    ],
    parameters: batchPatchSchema,

    async execute(_toolCallId: any, params: any, signal: any, _onUpdate: any, ctx: any) {
      const { path, oldText, newText, multi, patch } = params;

      const hasAnyClassicParam =
        path !== undefined ||
        oldText !== undefined ||
        newText !== undefined ||
        multi !== undefined;
      if (patch !== undefined && hasAnyClassicParam) {
        throw new Error(
          "The `patch` parameter is mutually exclusive with path/oldText/newText/multi.",
        );
      }

      if (patch !== undefined) {
        const ops = parsePatch(patch);

        // Preflight on virtual filesystem before mutating real files.
        await applyPatchOperations(
          ops,
          createVirtualWorkspace(ctx.cwd),
          ctx.cwd,
          signal,
          { collectDiff: false },
        );

        // Apply for real.
        const applied = await applyPatchOperations(
          ops,
          createRealWorkspace(pi),
          ctx.cwd,
          signal,
          { collectDiff: true },
        );
        const summary = applied
          .map((r: any, i: number) => `${i + 1}. ${r.message}`)
          .join("\n");
        const combinedDiff = applied
          .filter((r: any) => r.diff)
          .map((r: any) => `File: ${r.path}\n${r.diff}`)
          .join("\n\n");
        const firstChangedLine = applied.find(
          (r: any) => r.firstChangedLine !== undefined,
        )?.firstChangedLine;
        return {
          content: [
            {
              type: "text" as const,
              text: `Applied patch with ${applied.length} operation(s).\n${summary}`,
            },
          ],
          details: {
            diff: combinedDiff,
            firstChangedLine,
          },
        };
      }

      // Build classic edit list.
      const edits: EditItem[] = [];
      const hasTopLevel =
        path !== undefined && oldText !== undefined && newText !== undefined;

      if (hasTopLevel) {
        edits.push({ path: path!, oldText: oldText!, newText: newText! });
      } else if (
        path !== undefined ||
        oldText !== undefined ||
        newText !== undefined
      ) {
        // When multi is present, only a bare top-level `path` (for inheritance) is allowed.
        // Any other partial combination (e.g. path+oldText, oldText+newText) is an error.
        const hasOnlyPath =
          path !== undefined && oldText === undefined && newText === undefined;
        if (!hasOnlyPath || multi === undefined) {
          const missing: string[] = [];
          if (path === undefined) missing.push("path");
          if (oldText === undefined) missing.push("oldText");
          if (newText === undefined) missing.push("newText");
          throw new Error(
            `Incomplete top-level edit: missing ${missing.join(", ")}. Provide all three (path, oldText, newText) or use only the multi parameter.`,
          );
        }
      }

      if (multi) {
        for (const item of multi) {
          edits.push({
            path: item.path ?? path ?? "",
            oldText: item.oldText,
            newText: item.newText,
          });
        }
      }

      if (edits.length === 0) {
        throw new Error(
          "No edits provided. Supply path/oldText/newText, a multi array, or a patch.",
        );
      }

      // Validate that every edit has a path.
      for (let i = 0; i < edits.length; i++) {
        if (!edits[i].path) {
          throw new Error(
            `Edit ${i + 1} is missing a path. Provide a path on each multi item or set a top-level path to inherit.`,
          );
        }
      }

      // Preflight pass on virtual workspace before mutating real files.
      try {
        await applyClassicEdits(
          edits,
          createVirtualWorkspace(ctx.cwd),
          ctx.cwd,
          signal,
          { collectDiff: false },
        );
      } catch (err: any) {
        throw new Error(
          `Preflight failed before mutating files.\n${err.message ?? String(err)}`,
        );
      }

      // Apply for real.
      const isBatch = edits.length > 1;
      const results = await applyClassicEdits(
        edits,
        createRealWorkspace(pi),
        ctx.cwd,
        signal,
        {
          collectDiff: true,
          rollbackOnError: true,
          continueOnError: isBatch,
        },
      );

      const succeeded = results.filter((r) => r?.success);
      const failed = results.filter((r) => r && !r.success);

      if (results.length === 1) {
        const r = results[0];
        return {
          content: [{ type: "text" as const, text: r.message }],
          details: {
            diff: r.diff ?? "",
            firstChangedLine: r.firstChangedLine,
          },
        };
      }

      const combinedDiff = results
        .filter((r) => r?.diff)
        .map((r) => r.diff)
        .join("\n");

      const firstChanged = results.find(
        (r) => r?.firstChangedLine !== undefined,
      )?.firstChangedLine;
      const summary = results
        .map((r, i) => `${i + 1}. ${r.message}`)
        .join("\n");

      const statusLine =
        failed.length > 0
          ? `Applied ${succeeded.length}/${results.length} edit(s). ${failed.length} failed:\n${summary}`
          : `Applied ${results.length} edit(s) successfully.\n${summary}`;

      return {
        content: [{ type: "text" as const, text: statusLine }],
        details: {
          diff: combinedDiff,
          firstChangedLine: firstChanged,
        },
      };
    },
  }));
}
