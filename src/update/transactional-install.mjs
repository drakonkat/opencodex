/**
 * Transactional npm self-update: stage -> verify -> swap -> rollback (#1942 / #1849).
 *
 * The legacy path ran `npm install -g` straight into the live global tree, so a
 * failure after npm removed the old files left a file-less package skeleton with no
 * recovery. This module stages the new version into a SIBLING directory of the live
 * package (same volume, so directory renames are atomic-ish and never cross devices),
 * verifies the staged tree with a manifest before anything live is touched, then swaps
 * live -> backup -> stage-into-live with a reverse-rename rollback on failure and a
 * recovery marker on double fault.
 *
 * Layout (siblings, never children — a child would travel WITH the live rename and the
 * live dir cannot move into its own subtree):
 *   <scopeDir>/opencodex                      live package
 *   <scopeDir>/.ocx-staging-<ts>/             npm --prefix root (contains node_modules/...)
 *   <scopeDir>/.ocx-backup-<ts>/opencodex     previous live tree during/after the swap
 *   <scopeDir>/.ocx-recovery.json             double-fault marker with a one-line restore
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Verification manifest for a staged (or live) package tree. */
export function verifyInstallTree(packageDir, expectedVersion) {
  const failures = [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  } catch (error) {
    return { ok: false, failures: ["package.json unreadable: " + (error?.message ?? String(error))] };
  }
  if (expectedVersion && pkg.version !== expectedVersion) {
    failures.push("package.json version " + pkg.version + " != expected " + expectedVersion);
  }
  const launcher = join(packageDir, "bin", "ocx.mjs");
  try {
    const st = statSync(launcher);
    if (!st.isFile() || st.size < 1024) failures.push("bin/ocx.mjs missing or truncated");
  } catch {
    failures.push("bin/ocx.mjs absent");
  }
  // Sentinel direct deps: each must have an intact package.json. The bundled Bun dep is
  // the load-bearing one — without it the launcher cannot start the proxy at all.
  const deps = Object.keys(pkg.dependencies ?? {});
  const sentinels = deps.filter(name => name === "bun" || name === "zod").length > 0
    ? deps.filter(name => name === "bun" || name === "zod")
    : deps.slice(0, 2);
  for (const name of sentinels) {
    const depPkg = join(packageDir, "node_modules", ...name.split("/"), "package.json");
    if (!existsSync(depPkg)) failures.push("sentinel dependency missing: " + name);
  }
  return failures.length === 0 ? { ok: true, failures: [] } : { ok: false, failures };
}

function stampedName(prefix) {
  return prefix + "-" + new Date().toISOString().replace(/[:.]/g, "-");
}

function recoveryMarkerPath(scopeDir) {
  return join(scopeDir, ".ocx-recovery.json");
}

/** Startup probe: restore a backup when the live tree is broken (D4 power-loss rows). */
export function bootRestoreProbe(packageDir, deps = {}) {
  const rename = deps.rename ?? renameSync;
  const scopeDir = dirname(packageDir);
  let backups = [];
  try {
    backups = readdirSync(scopeDir).filter(name => name.startsWith(".ocx-backup-")).sort();
  } catch {
    return { action: "none" };
  }
  if (backups.length === 0) return { action: "none" };
  const liveOk = existsSync(join(packageDir, "package.json"))
    && verifyInstallTree(packageDir).ok;
  const newestBackup = join(scopeDir, backups[backups.length - 1], "opencodex");
  if (liveOk) {
    // Live is healthy: the backups are leftovers from a completed swap. Reap them.
    for (const name of backups) {
      try { rmSync(join(scopeDir, name), { recursive: true, force: true }); } catch { /* keep */ }
    }
    try { rmSync(recoveryMarkerPath(scopeDir), { force: true }); } catch { /* keep */ }
    return { action: "reaped", count: backups.length };
  }
  if (!existsSync(join(newestBackup, "package.json"))) return { action: "none" };
  try {
    try { rmSync(packageDir, { recursive: true, force: true }); } catch { /* may not exist */ }
    rename(newestBackup, packageDir);
    return { action: "restored", from: newestBackup };
  } catch (error) {
    return { action: "failed", error: error?.message ?? String(error) };
  }
}

/**
 * Run the transactional update. `runNpm(args, opts)` is injected so the caller keeps
 * its hardened npm resolution (npm-invocation.mjs) and logging.
 */
export function transactionalNpmUpdate({
  packageDir,
  pkgName,
  targetVersion,
  tag,
  runNpm,
  log = () => {},
  deps = {},
}) {
  const rename = deps.rename ?? renameSync;
  const scopeDir = dirname(packageDir);
  const stageRoot = join(scopeDir, stampedName(".ocx-staging"));
  const stagedPackage = join(stageRoot, "node_modules", ...pkgName.split("/"));

  // D1: stage to the side. --prefix keeps npm entirely inside stageRoot; the live tree
  // and the npm bin shims are untouched until the swap.
  mkdirSync(stageRoot, { recursive: true });
  const spec = pkgName + "@" + (targetVersion || tag);
  log("Staging " + spec + " into " + stageRoot);
  const install = runNpm(["install", "--prefix", stageRoot, "--no-audit", "--no-fund", spec]);
  if (install.status !== 0) {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "stage", error: "npm staging install failed (" + (install.status ?? "?") + ")" };
  }

  // D2: verify INSIDE the stage. Live is still untouched on any failure here.
  const staged = verifyInstallTree(stagedPackage, targetVersion || undefined);
  if (!staged.ok) {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "verify", error: "staged tree failed verification: " + staged.failures.join("; ") };
  }

  // D3: swap. live -> backup, stage -> live, re-verify live, rollback on failure.
  const backupRoot = join(scopeDir, stampedName(".ocx-backup"));
  const backupPackage = join(backupRoot, "opencodex");
  mkdirSync(backupRoot, { recursive: true });
  try {
    rename(packageDir, backupPackage);
  } catch (error) {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "swap-backup", error: "could not move live tree aside: " + (error?.message ?? String(error)) };
  }
  try {
    rename(stagedPackage, packageDir);
  } catch (error) {
    // Rollback: reverse the first rename. Double fault leaves the recovery marker.
    try {
      rename(backupPackage, packageDir);
      try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      try { rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, phase: "swap-live", rolledBack: true, error: "could not place staged tree: " + (error?.message ?? String(error)) };
    } catch (rollbackError) {
      writeFileSync(recoveryMarkerPath(scopeDir), JSON.stringify({
        at: new Date().toISOString(),
        backup: backupPackage,
        live: packageDir,
        restore: 'move "' + backupPackage + '" back to "' + packageDir + '"',
        error: String(error?.message ?? error),
        rollbackError: String(rollbackError?.message ?? rollbackError),
      }, null, 2));
      return { ok: false, phase: "double-fault", rolledBack: false, error: "swap and rollback both failed; recovery marker written at " + recoveryMarkerPath(scopeDir) };
    }
  }
  const liveCheck = verifyInstallTree(packageDir, targetVersion || undefined);
  if (!liveCheck.ok) {
    try {
      rmSync(packageDir, { recursive: true, force: true });
      rename(backupPackage, packageDir);
      try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      try { rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, phase: "post-verify", rolledBack: true, error: "live tree failed post-swap verification: " + liveCheck.failures.join("; ") };
    } catch (rollbackError) {
      writeFileSync(recoveryMarkerPath(scopeDir), JSON.stringify({
        at: new Date().toISOString(),
        backup: backupPackage,
        live: packageDir,
        restore: 'move "' + backupPackage + '" back to "' + packageDir + '"',
        error: "post-swap verification failed: " + liveCheck.failures.join("; "),
        rollbackError: String(rollbackError?.message ?? rollbackError),
      }, null, 2));
      return { ok: false, phase: "double-fault", rolledBack: false, error: "post-verify rollback failed; recovery marker written" };
    }
  }
  // Success: stage scaffolding is disposable now; the backup stays until the next
  // healthy boot reaps it (bootRestoreProbe) — the process that spawned this update may
  // still hold the old cwd.
  try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  return { ok: true, phase: "done", backup: backupPackage };
}

