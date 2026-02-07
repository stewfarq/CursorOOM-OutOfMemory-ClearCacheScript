#!/usr/bin/env ts-node

/**
 * Prune state.vscdb files to reduce size without impacting Cursor/VS Code settings
 * 
 * This script safely reduces the size of state.vscdb SQLite databases by running VACUUM,
 * which reclaims space from deleted/old entries without affecting active settings.
 * 
 * Usage:
 *   npx tsx scripts/prune-state-vscdb.ts [--workspace] [--global] [--threshold 50]
 *   npx tsx scripts/prune-state-vscdb.ts --analyze
 *   npx tsx scripts/prune-state-vscdb.ts --analyze --delete-keys "cursor.composer%"
 *   npx tsx scripts/prune-state-vscdb.ts --analyze --table cursorDiskKV --delete-keys "bubbleId:%"
 *   npx tsx scripts/prune-state-vscdb.ts --check-integrity [--global-only]
 *
 * Options:
 *   --workspace       Prune workspace-specific state.vscdb (default: true)
 *   --global          Prune global state.vscdb (default: false)
 *   --threshold       Size threshold in MB to trigger pruning (default: 50)
 *   --analyze         Report what is using space in global state.vscdb (no pruning)
 *   --check-integrity Run SQLite PRAGMA quick_check + integrity_check (global DB by default; use --global-only for global only).
 *   --global-only     With --check-integrity: check only global state.vscdb (default: check global + workspace + all workspaceStorage).
 *   --table           Table to delete from when using --delete-keys: ItemTable (default) or cursorDiskKV
 *   --delete-keys     Delete keys matching SQL LIKE pattern; then VACUUM. Requires Cursor closed.
 *   --keep-last N     With --delete-keys: keep the last N matching items (by rowid), delete the rest. Omit to delete all.
 *   --count-categories Show item counts for the 5 categories (bubbleId:%, checkpointId:%, composerData:%, agentKv:blob:%, cursor.composer%). Read-only.
 */

import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';

const ALLOWED_TABLES = ['ItemTable', 'cursorDiskKV'] as const;
type TableName = (typeof ALLOWED_TABLES)[number];

interface PruneOptions {
  workspace: boolean;
  global: boolean;
  thresholdMb: number;
  analyze: boolean;
  checkIntegrity: boolean;
  globalOnlyIntegrity: boolean;
  countCategories: boolean;
  deleteKeysPattern: string | null;
  deleteTable: TableName;
  keepLast: number | null;
}

function parseArgs(): PruneOptions {
  const args = process.argv.slice(2);
  const options: PruneOptions = {
    workspace: true,
    global: false,
    thresholdMb: 50,
    analyze: false,
    checkIntegrity: false,
    globalOnlyIntegrity: false,
    countCategories: false,
    deleteKeysPattern: null,
    deleteTable: 'ItemTable',
    keepLast: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workspace') {
      options.workspace = true;
    } else if (arg === '--global') {
      options.global = true;
    } else if (arg === '--analyze') {
      options.analyze = true;
    } else if (arg === '--check-integrity') {
      options.checkIntegrity = true;
    } else if (arg === '--global-only') {
      options.globalOnlyIntegrity = true;
    } else if (arg === '--count-categories') {
      options.countCategories = true;
    } else if (arg === '--threshold' && i + 1 < args.length) {
      options.thresholdMb = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--table' && i + 1 < args.length) {
      const t = args[i + 1];
      if (ALLOWED_TABLES.includes(t as TableName)) {
        options.deleteTable = t as TableName;
      }
      i++;
    } else if (arg === '--delete-keys' && i + 1 < args.length) {
      options.deleteKeysPattern = args[i + 1];
      i++;
    } else if (arg === '--keep-last' && i + 1 < args.length) {
      const n = parseInt(args[i + 1], 10);
      if (n > 0) options.keepLast = n;
      i++;
    }
  }

  return options;
}

function getWorkspaceStatePath(): string | null {
  // Workspace state.vscdb is typically in .vscode/state.vscdb or workspaceStorage
  const workspacePath = process.cwd();
  const possiblePaths = [
    join(workspacePath, '.vscode', 'state.vscdb'),
    join(workspacePath, '.cursor', 'state.vscdb'),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

/** Returns all state.vscdb paths: project, workspaceStorage (each workspace), and global. */
function getAllStateVscdbPaths(): { path: string; label: string }[] {
  const out: { path: string; label: string }[] = [];
  const seen = new Set<string>();

  const add = (filePath: string, label: string) => {
    if (!existsSync(filePath) || seen.has(filePath)) return;
    seen.add(filePath);
    out.push({ path: filePath, label });
  };

  // 1) Project: .vscode/state.vscdb, .cursor/state.vscdb
  const workspacePath = getWorkspaceStatePath();
  if (workspacePath) add(workspacePath, 'Workspace (project) state.vscdb');

  // 2) workspaceStorage: each workspace has a state.vscdb
  const appData = process.env.APPDATA;
  const home = homedir();
  const wsDirs: string[] = [];
  if (appData) {
    wsDirs.push(
      join(appData, 'Cursor', 'User', 'workspaceStorage'),
      join(appData, 'Code', 'User', 'workspaceStorage')
    );
  } else {
    wsDirs.push(
      join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage'),
      join(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
      join(home, '.config', 'Cursor', 'User', 'workspaceStorage'),
      join(home, '.config', 'Code', 'User', 'workspaceStorage'),
      join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
      join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage')
    );
  }
  for (const wsDir of wsDirs) {
    if (!existsSync(wsDir)) continue;
    try {
      const ids = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const id of ids) {
        const statePath = join(wsDir, id.name, 'state.vscdb');
        if (existsSync(statePath)) add(statePath, `WorkspaceStorage/${id.name} state.vscdb`);
      }
    } catch {
      // ignore permission or read errors
    }
  }

  // 3) Global
  const globalPath = getGlobalStatePath();
  if (globalPath) add(globalPath, 'Global state.vscdb');

  return out;
}

function getGlobalStatePath(): string | null {
  const home = homedir();
  const appData = process.env.APPDATA; // Windows: C:\Users\<user>\AppData\Roaming
  const possiblePaths: string[] = [];
  // Windows: prefer APPDATA so we always hit C:\Users\<user>\AppData\Roaming\Cursor\User\globalStorage\state.vscdb
  if (appData) {
    possiblePaths.push(
      join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb')
    );
  }
  possiblePaths.push(
    join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'state.vscdb'),
    join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'), // Linux
    join(home, '.config', 'Code', 'User', 'globalStorage', 'state.vscdb'), // Linux
    join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'), // macOS
    join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb') // macOS
  );

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function getFileSizeMb(filePath: string): number {
  const stats = statSync(filePath);
  return stats.size / (1024 * 1024);
}

function getSqlite3Command(): string {
  let sqlite3Cmd = 'sqlite3';
  try {
    execSync('sqlite3 --version', { stdio: 'ignore' });
    return sqlite3Cmd;
  } catch {
    const winPaths = [
      'C:\\Program Files\\SQLite\\sqlite3.exe',
      'C:\\Program Files (x86)\\SQLite\\sqlite3.exe',
      join(process.env.LOCALAPPDATA || '', 'Programs', 'sqlite3', 'sqlite3.exe'),
    ];
    for (const winPath of winPaths) {
      if (existsSync(winPath)) return winPath;
    }
    throw new Error(
      'sqlite3 command not found. Install SQLite: Windows choco install sqlite, macOS brew install sqlite, Linux apt-get install sqlite3'
    );
  }
}

function runSqliteQuery(filePath: string, sql: string, sqlite3Cmd: string): string {
  return execSync(`"${sqlite3Cmd}" "${filePath}" ${JSON.stringify(sql)}`, { encoding: 'utf-8' });
}

function vacuumDatabase(filePath: string, sqlite3Cmd?: string): { beforeMb: number; afterMb: number } {
  const cmd = sqlite3Cmd ?? getSqlite3Command();
  const beforeMb = getFileSizeMb(filePath);
  console.log(`  Size before: ${beforeMb.toFixed(2)} MB`);
  try {
    execSync(`"${cmd}" "${filePath}" "VACUUM;"`, { stdio: 'inherit' });
  } catch (error) {
    throw new Error(
      `Failed to run VACUUM: ${error instanceof Error ? error.message : String(error)}\n` +
      'Make sure Cursor/VS Code is closed before running this script.'
    );
  }
  const afterMb = getFileSizeMb(filePath);
  const savedMb = beforeMb - afterMb;
  const savedPercent = beforeMb > 0 ? ((savedMb / beforeMb) * 100).toFixed(1) : '0';
  console.log(`  Size after:  ${afterMb.toFixed(2)} MB`);
  console.log(`  Saved:       ${savedMb.toFixed(2)} MB (${savedPercent}%)`);
  return { beforeMb, afterMb };
}

function pruneDatabase(filePath: string, label: string, thresholdMb: number): boolean {
  console.log(`\n${label}:`);
  console.log(`  Path: ${filePath}`);

  const sizeMb = getFileSizeMb(filePath);

  if (sizeMb < thresholdMb) {
    console.log(`  Size: ${sizeMb.toFixed(2)} MB (below threshold of ${thresholdMb} MB, skipping)`);
    return false;
  }

  console.log(`  Size: ${sizeMb.toFixed(2)} MB (above threshold, pruning...)`);
  try {
    vacuumDatabase(filePath);
    return true;
  } catch (error) {
    console.error(`  Error pruning ${label}:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** Analyze global state.vscdb: list tables and top keys by size (ItemTable). */
function analyzeGlobalStateVscdb(filePath: string): void {
  const sqlite3 = getSqlite3Command();
  const fileMb = getFileSizeMb(filePath);
  console.log('\n=== Global state.vscdb analysis ===\n');
  console.log(`Path: ${filePath}`);
  console.log(`File size: ${fileMb.toFixed(2)} MB\n`);

  try {
    const tablesOut = runSqliteQuery(filePath, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;", sqlite3);
    const tables = tablesOut.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    console.log('Tables:', tables.join(', ') || '(none)');

    const runTopKeys = (tableName: string, keyCol: string, valueCol: string, limit: number) => {
      const sumOut = runSqliteQuery(
        filePath,
        `SELECT SUM(LENGTH(${valueCol})) FROM ${tableName};`,
        sqlite3
      );
      const totalBytes = parseInt(sumOut.trim(), 10) || 0;
      const totalMb = totalBytes / (1024 * 1024);
      console.log(`\n${tableName} total value size: ${totalMb.toFixed(2)} MB\n`);
      console.log(`Top ${limit} keys by value size:`);
      console.log('-----------------------------------------------');
      const topOut = runSqliteQuery(
        filePath,
        `SELECT ${keyCol}, ROUND(LENGTH(${valueCol})/1024.0/1024.0, 2) AS size_mb FROM ${tableName} ORDER BY LENGTH(${valueCol}) DESC LIMIT ${limit};`,
        sqlite3
      );
      const lines = topOut.trim().split(/\r?\n/).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const sep = line.includes('|') ? '|' : '\t';
        const parts = line.split(sep);
        const key = (parts[0] || '').trim();
        const sizeMb = (parts[1] || '').trim();
        const keyShort = key.length > 70 ? key.slice(0, 67) + '...' : key;
        console.log(`${keyShort.padEnd(70)} ${sizeMb} MB`);
      }
    };

    for (const table of ['ItemTable', 'cursorDiskKV']) {
      if (!tables.some((t) => t === table)) continue;
      try {
        const infoOut = runSqliteQuery(filePath, `PRAGMA table_info(${table});`, sqlite3);
        const cols = infoOut.trim().split(/\r?\n/).map((r) => (r.split('|')[1] || r.split('\t')[1] || '').trim()).filter(Boolean);
        const keyCol = cols[0] || 'key';
        const valueCol = cols[1] || 'value';
        runTopKeys(table, keyCol, valueCol, 50);
      } catch (err) {
        console.log(`\n(Skipping ${table}: ${err instanceof Error ? err.message : String(err)})\n`);
      }
    }

    console.log('\n--- Sub-options to free space (run with Cursor closed) ---\n');

    console.log('1) bubbleId:%  (cursorDiskKV)');
    console.log('   Possible reduction: Often 100–400+ MB (each chat bubble is ~1–5 MB).');
    console.log('   Impact: Deletes stored content of past AI chat bubbles (composer/chat threads).');
    console.log('   Your projects and code are unchanged. You lose the ability to scroll back through old');
    console.log('   conversations in Cursor; new chats and Composer sessions work as usual.');
    console.log('   Command: npx tsx scripts/prune-state-vscdb.ts --analyze --table cursorDiskKV --delete-keys "bubbleId:%"\n');

    console.log('2) checkpointId:%  (cursorDiskKV)');
    console.log('   Possible reduction: Often 100–300+ MB (each checkpoint ~0.9–1.1 MB).');
    console.log('   Impact: Deletes saved checkpoints for Composer sessions (snapshots used to restore state).');
    console.log('   Your projects and code are unchanged. You lose the ability to restore older Composer');
    console.log('   states from the UI; current work and new sessions are unaffected.');
    console.log('   Command: npx tsx scripts/prune-state-vscdb.ts --analyze --table cursorDiskKV --delete-keys "checkpointId:%"\n');

    console.log('3) composerData:%  (cursorDiskKV)');
    console.log('   Possible reduction: Typically 1–50+ MB (metadata for Composer sessions).');
    console.log('   Impact: Deletes Composer session metadata (e.g. context, panel state).');
    console.log('   Your projects and code are unchanged. You may lose in-progress Composer context');
    console.log('   and panel layout for past sessions; new Composer sessions work as usual.');
    console.log('   Command: npx tsx scripts/prune-state-vscdb.ts --analyze --table cursorDiskKV --delete-keys "composerData:%"\n');

    console.log('4) agentKv:blob:%  (cursorDiskKV)');
    console.log('   Possible reduction: Often 100–400+ MB (each blob ~0.3–0.9 MB; many entries).');
    console.log('   Impact: Deletes cached agent/blob data used by Cursor (e.g. model outputs, context).');
    console.log('   Your projects and code are unchanged. Cursor may re-download or regenerate some');
    console.log('   data; performance might briefly change. New sessions work as usual.');
    console.log('   Command: npx tsx scripts/prune-state-vscdb.ts --analyze --table cursorDiskKV --delete-keys "agentKv:blob:%"\n');

    console.log('5) ItemTable (small; VS Code / extension state only)');
    console.log('   Possible reduction: Usually under 1 MB.');
    console.log('   Impact: Depends on the key pattern (e.g. cursor.composer% for some UI state).');
    console.log('   Command: npx tsx scripts/prune-state-vscdb.ts --analyze --delete-keys "cursor.composer%"\n');
  } catch (e) {
    console.error('Analysis failed:', e instanceof Error ? e.message : String(e));
  }
}

/** Delete rows where key LIKE pattern in the given table, then VACUUM. If keepLast is set, only the oldest (by rowid) are deleted so the last keepLast items remain. */
function deleteKeysAndVacuum(filePath: string, pattern: string, table: TableName, keepLast: number | null): void {
  const sqlite3 = getSqlite3Command();
  const escaped = pattern.replace(/'/g, "''");
  const likeLiteral = `'${escaped}'`;
  const countOut = runSqliteQuery(
    filePath,
    `SELECT COUNT(*) FROM ${table} WHERE key LIKE ${likeLiteral};`,
    sqlite3
  );
  const count = parseInt(countOut.trim(), 10) || 0;
  if (count === 0) {
    console.log(`No keys matching "${pattern}" in ${table}. Nothing to delete.`);
    return;
  }
  const beforeMb = getFileSizeMb(filePath);
  const toDelete = keepLast != null ? Math.max(0, count - keepLast) : count;
  if (toDelete === 0) {
    console.log(`All ${count} key(s) match "${pattern}". Keeping last ${keepLast}; nothing to delete.`);
    return;
  }
  if (keepLast != null) {
    console.log(`Deleting ${toDelete} key(s) from ${table} matching "${pattern}" (keeping last ${keepLast})...`);
    runSqliteQuery(
      filePath,
      `DELETE FROM ${table} WHERE key LIKE ${likeLiteral} AND rowid NOT IN (SELECT rowid FROM ${table} WHERE key LIKE ${likeLiteral} ORDER BY rowid DESC LIMIT ${keepLast});`,
      sqlite3
    );
  } else {
    console.log(`Deleting ${count} key(s) from ${table} matching "${pattern}"...`);
    runSqliteQuery(filePath, `DELETE FROM ${table} WHERE key LIKE ${likeLiteral};`, sqlite3);
  }
  console.log('Running VACUUM to reclaim space...');
  vacuumDatabase(filePath, sqlite3);
  const afterMb = getFileSizeMb(filePath);
  console.log(`\nFreed: ${(beforeMb - afterMb).toFixed(2)} MB`);
}

/** Run SQLite PRAGMA quick_check and integrity_check; report ok or first error. Close Cursor for reliable results. */
function checkIntegrity(filePath: string, label: string): boolean {
  const sqlite3 = getSqlite3Command();
  const sizeMb = getFileSizeMb(filePath);
  console.log(`\n${label}`);
  console.log(`  Path: ${filePath}`);
  console.log(`  Size: ${sizeMb.toFixed(2)} MB`);

  try {
    const quick = runSqliteQuery(filePath, 'PRAGMA quick_check;', sqlite3).trim();
    const ok = quick === 'ok';
    console.log(`  PRAGMA quick_check: ${quick}`);
    if (!ok) {
      console.log('  ❌ Corruption or inconsistency detected (quick_check).');
      return false;
    }

    const integrity = runSqliteQuery(filePath, 'PRAGMA integrity_check;', sqlite3).trim();
    const integrityOk = integrity === 'ok';
    console.log(`  PRAGMA integrity_check: ${integrityOk ? 'ok' : integrity.split('\n')[0] || integrity}`);
    if (!integrityOk) {
      console.log('  ❌ Integrity check reported errors.');
      return false;
    }
    console.log('  ✅ No corruption detected.');
    return true;
  } catch (e) {
    console.log('  ❌ Error running check:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

const CATEGORIES: { table: TableName; pattern: string; label: string }[] = [
  { table: 'cursorDiskKV', pattern: 'bubbleId:%', label: 'bubbleId:% (cursorDiskKV) - chat bubbles' },
  { table: 'cursorDiskKV', pattern: 'checkpointId:%', label: 'checkpointId:% (cursorDiskKV) - Composer checkpoints' },
  { table: 'cursorDiskKV', pattern: 'composerData:%', label: 'composerData:% (cursorDiskKV) - Composer session metadata' },
  { table: 'cursorDiskKV', pattern: 'agentKv:blob:%', label: 'agentKv:blob:% (cursorDiskKV) - agent/blob cache' },
  { table: 'ItemTable', pattern: 'cursor.composer%', label: 'cursor.composer% (ItemTable) - small UI state' },
];

/** Run SELECT COUNT(*) and SUM(LENGTH(value)) for each category and display to the user. Read-only. */
function countCategories(filePath: string): void {
  const sqlite3 = getSqlite3Command();
  const sizeMb = getFileSizeMb(filePath);
  console.log('\n=== Item counts by category (global state.vscdb) ===\n');
  console.log(`Path: ${filePath}`);
  console.log(`File size: ${sizeMb.toFixed(2)} MB\n`);
  console.log('Category                                          | Count      | Est. size (MB)');
  console.log('--------------------------------------------------|------------|----------------');

  for (const { table, pattern, label } of CATEGORIES) {
    try {
      const escaped = pattern.replace(/'/g, "''");
      const likeLiteral = `'${escaped}'`;
      const countOut = runSqliteQuery(
        filePath,
        `SELECT COUNT(*) FROM ${table} WHERE key LIKE ${likeLiteral};`,
        sqlite3
      );
      const count = parseInt(countOut.trim(), 10) || 0;
      const sumOut = runSqliteQuery(
        filePath,
        `SELECT COALESCE(SUM(LENGTH(value)), 0) FROM ${table} WHERE key LIKE ${likeLiteral};`,
        sqlite3
      );
      const totalBytes = parseInt(sumOut.trim(), 10) || 0;
      const estMb = totalBytes / (1024 * 1024);
      const labelPadded = (label.slice(0, 49) + ' ').slice(0, 50);
      const countStr = count.toLocaleString().padStart(10);
      const mbStr = estMb.toFixed(2).padStart(14);
      console.log(`${labelPadded} | ${countStr} | ${mbStr}`);
    } catch (e) {
      console.log(`${label.slice(0, 50).padEnd(50)} | Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log('');
}

function main() {
  const options = parseArgs();

  if (options.countCategories) {
    const globalPath = getGlobalStatePath();
    if (!globalPath) {
      console.log('Global state.vscdb not found. Cannot show counts.');
      return;
    }
    countCategories(globalPath);
    return;
  }

  if (options.checkIntegrity) {
    if (options.globalOnlyIntegrity) {
      const globalPath = getGlobalStatePath();
      if (!globalPath) {
        console.log('Global state.vscdb not found. Cannot check integrity.');
        return;
      }
      checkIntegrity(globalPath, 'Global state.vscdb');
    } else {
      const all = getAllStateVscdbPaths();
      if (all.length === 0) {
        console.log('No state.vscdb found.');
        return;
      }
      let okCount = 0;
      for (const { path: filePath, label } of all) {
        if (checkIntegrity(filePath, label)) okCount++;
      }
      console.log(`\n✅ Integrity check complete: ${okCount}/${all.length} database(s) passed.`);
    }
    return;
  }

  if (options.analyze) {
    const globalPath = getGlobalStatePath();
    if (!globalPath) {
      console.log('Global state.vscdb not found. Cannot analyze.');
      return;
    }
    analyzeGlobalStateVscdb(globalPath);
    if (options.deleteKeysPattern) {
      console.log('\n--- Deleting keys by pattern ---');
      deleteKeysAndVacuum(globalPath, options.deleteKeysPattern, options.deleteTable, options.keepLast);
    }
    return;
  }

  console.log('Pruning state.vscdb files...');
  console.log(`Options: workspace=${options.workspace}, global=${options.global}, threshold=${options.thresholdMb}MB\n`);

  let prunedCount = 0;
  let totalSavedMb = 0;

  if (options.workspace) {
    // Option 2: prune all state.vscdb (project + workspaceStorage + global)
    const all = getAllStateVscdbPaths();
    if (all.length === 0) {
      console.log('No state.vscdb found (checked project .vscode/.cursor, workspaceStorage, and global).');
    } else {
      for (const { path: filePath, label } of all) {
        const beforeMb = getFileSizeMb(filePath);
        if (pruneDatabase(filePath, label, options.thresholdMb)) {
          prunedCount++;
          totalSavedMb += beforeMb - getFileSizeMb(filePath);
        }
      }
    }
  }

  if (options.global && !options.workspace) {
    // Option 3: prune global only
    const globalPath = getGlobalStatePath();
    if (globalPath) {
      if (pruneDatabase(globalPath, 'Global state.vscdb', options.thresholdMb)) {
        prunedCount++;
        totalSavedMb += 0; // already reported in pruneDatabase
      }
    } else {
      console.log('Global state.vscdb: Not found (e.g. ' + (process.env.APPDATA || '') + '\\Cursor\\User\\globalStorage\\state.vscdb)');
    }
  }

  console.log(`\n✅ Pruning complete. ${prunedCount} database(s) pruned.`);
  if (totalSavedMb > 0) {
    console.log(`   Total space reclaimed: ${totalSavedMb.toFixed(2)} MB`);
  }
  console.log('\nNote: All Cursor/VS Code settings are preserved. VACUUM only reclaims free space inside the file.');
  if (prunedCount > 0 && totalSavedMb < 50) {
    console.log('If savings were small, the DB is mostly active data. For larger savings use option 1 or 4 (clear caches).');
  }
}

if (require.main === module) {
  main();
}
