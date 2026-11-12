---
name: package-prune
description: Clean up pi packages left behind after removal from settings.json (e.g. after Syncthing syncs a pruned declaration list). Runs npm prune and moves orphan git clones to a trash dir. Default is dry-run.
---

Run the prune script, show the report, and ask the user before applying:

```bash
node "C:\Users\Administrator\.pi\agent\git\github.com\mystery4f\pi-extensions\skills\package-prune\prune.mjs"
```

The script is read-only by default. Explain the report to the user:

- `orphan dep` — npm dependencies not declared in settings.json; `--apply` rebuilds `~/.pi/agent/npm/package.json` and runs `npm prune` (lockfile updated, backup written to temp).
- `orphan clone` — git clones under `~/.pi/agent/git/` with no matching `git:` declaration; `--apply` moves them to `agent/git/.trash/` (never deletes; user cleans the trash manually).
- `dirty declarations` — malformed sources in settings.json (leading `-`, trailing `\"`); reported only, never modified.

Only run with `--apply` after the user explicitly confirms the dry-run report:

```bash
node "...prune.mjs" --apply
```

Note: packages declared in settings.json but missing from disk are left alone — pi installs them on next start. npm has no command that cleans git-clone packages; that is why the git side is handled here.
