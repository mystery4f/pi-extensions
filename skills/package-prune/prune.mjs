#!/usr/bin/env node
// Prune pi packages that were removed from settings.json but left behind by sync.
// - npm side: rebuild npm/package.json dependencies from declared npm:* sources, then `npm prune`.
// - git side: move agent/git/<host>/<owner>/<repo> clones not in the declared git:* set to agent/git/.trash/.
// Default is dry-run; pass --apply to execute.
// @author dongcheng.xie

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const agentDirIdx = args.indexOf("--agent-dir");
const agentDir = agentDirIdx >= 0 ? args[agentDirIdx + 1] : join(homedir(), ".pi", "agent");

const settingsPath = join(agentDir, "settings.json");
const npmDir = join(agentDir, "npm");
const npmPkgPath = join(npmDir, "package.json");
const gitDir = join(agentDir, "git");
const trashDir = join(gitDir, ".trash");

const dirty = [];
const declaredNpm = new Set();
const declaredGit = new Set();

for (const entry of JSON.parse(readFileSync(settingsPath, "utf8")).packages ?? []) {
  let src = typeof entry === "string" ? entry : entry?.source;
  if (!src) continue;
  const original = src;
  // Normalize sync artifacts: leading '-' and trailing escaped quote garbage.
  const cleaned = src.replace(/^-/, "").replace(/\\+"$/, "");
  if (cleaned !== original) dirty.push({ original, cleaned });
  src = cleaned;
  if (src.startsWith("npm:")) {
    declaredNpm.add(src.slice(4));
  } else if (src.startsWith("git:")) {
    // git:host/owner/repo[@branch] — branch suffix does not affect the clone directory.
    const rest = src.slice(4);
    const at = rest.indexOf("@");
    declaredGit.add(at >= 0 ? rest.slice(0, at) : rest);
  }
}

// ---- npm side ----
const npmPkg = JSON.parse(readFileSync(npmPkgPath, "utf8"));
const deps = npmPkg.dependencies ?? {};
const npmOrphans = Object.keys(deps).filter((name) => !declaredNpm.has(name));
// Declared but absent from package.json: pi will install them at next start — never touch.
const declaredMissing = [...declaredNpm].filter((name) => !(name in deps));

console.log(`== pi package prune (${apply ? "APPLY" : "dry-run"}) — ${agentDir}`);

console.log(`\n-- npm (${npmDir})`);
if (npmOrphans.length === 0) {
  console.log("no orphan dependencies");
} else {
  for (const name of npmOrphans) console.log(`orphan dep: ${name} (${deps[name]})`);
  if (apply) {
    const backup = join(tmpdir(), `npm-package.json.bak-${Date.now()}`);
    writeFileSync(backup, JSON.stringify(npmPkg, null, 2));
    const newDeps = { ...deps };
    for (const name of npmOrphans) delete newDeps[name];
    npmPkg.dependencies = Object.fromEntries(Object.keys(newDeps).sort().map((n) => [n, newDeps[n]]));
    writeFileSync(npmPkgPath, JSON.stringify(npmPkg, null, 2) + "\n");
    console.log(`backup written: ${backup}`);
    console.log("running npm prune...");
    const r = spawnSync("npm", ["prune", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: npmDir, stdio: "inherit", shell: true });
    if (r.status !== 0) {
      writeFileSync(npmPkgPath, readFileSync(backup));
      console.error(`npm prune failed (exit ${r.status}); package.json restored from backup`);
      process.exitCode = 1;
    }
  }
}
if (declaredMissing.length) console.log(`declared but not installed (leave to pi): ${declaredMissing.join(", ")}`);

// ---- git side ----
console.log(`\n-- git (${gitDir})`);
const gitOrphans = [];
if (existsSync(gitDir)) {
  for (const host of readdirSync(gitDir, { withFileTypes: true })) {
    if (!host.isDirectory() || host.name === ".trash") continue;
    for (const owner of readdirSync(join(gitDir, host.name), { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      const ownerPath = join(gitDir, host.name, owner.name);
      // Two-level layout: host/owner/repo
      const children = readdirSync(ownerPath, { withFileTypes: true });
      const repoLike = children.filter((c) => c.isDirectory() && !c.name.startsWith("."));
      const isRepoDir = repoLike.length === 0 || existsSync(join(ownerPath, ".git")) || existsSync(join(ownerPath, "HEAD"));
      if (isRepoDir) {
        if (!declaredGit.has(`${host.name}/${owner.name}`)) gitOrphans.push(ownerPath);
      } else {
        for (const repo of repoLike) {
          const key = `${host.name}/${owner.name}/${repo.name}`;
          if (!declaredGit.has(key)) gitOrphans.push(join(ownerPath, repo.name));
        }
      }
    }
  }
}
if (gitOrphans.length === 0) {
  console.log("no orphan clones");
} else {
  for (const p of gitOrphans) console.log(`orphan clone: ${p}`);
  if (apply) {
    mkdirSync(trashDir, { recursive: true });
    for (const p of gitOrphans) {
      let dest = join(trashDir, basename(p));
      if (existsSync(dest)) dest = join(trashDir, `${basename(p)}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
      renameSync(p, dest);
      console.log(`moved to ${dest}`);
    }
    // Remove now-empty owner/host dirs.
    for (const host of readdirSync(gitDir, { withFileTypes: true })) {
      if (!host.isDirectory() || host.name === ".trash") continue;
      const hostPath = join(gitDir, host.name);
      for (const owner of readdirSync(hostPath, { withFileTypes: true })) {
        if (!owner.isDirectory()) continue;
        const ownerPath = join(hostPath, owner.name);
        if (readdirSync(ownerPath).length === 0) rmSync(ownerPath, { recursive: true });
      }
      if (readdirSync(hostPath).length === 0) rmSync(hostPath, { recursive: true });
    }
  }
}

// ---- dirty declarations ----
if (dirty.length) {
  console.log(`\n-- dirty declarations in settings.json (report only, not modified)`);
  for (const d of dirty) console.log(`${d.original}  ->  ${d.cleaned}`);
}

console.log(apply ? "\ndone" : "\ndry-run only; re-run with --apply to execute");
