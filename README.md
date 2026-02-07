# Clear Cursor Cache Script — Product Specification & User Guide

**Document type:** Product specification and user documentation  
**Audience:** Cursor IDE users experiencing OOM, crashes, or oversized state databases  
**Last updated:** 2025

---

## 1. Overview

### 1.1 Purpose

The **Clear Cursor Cache** script (`scripts/clear-cursor-cache.ps1`) is an interactive PowerShell tool that helps you **reduce Cursor's disk usage and memory pressure** by cleaning caches and pruning SQLite state databases (`state.vscdb`). It is intended for users who experience:

- **Out of Memory (OOM)** errors
- **Repeated Cursor crashes** after long use
- **Very large** `state.vscdb` files (e.g. hundreds of MB to over 1 GB)

The script offers several levels of cleanup—from light (VACUUM only) to full (delete caches and workspace history)—and an **analyze** mode that shows what is using space so you can choose targeted pruning (e.g. chat bubbles, checkpoints, agent blobs) with the option to **keep the last N items** instead of deleting everything.

### 1.2 Problem Statement

Cursor (and VS Code–based editors) store:

- **Cache directories** — HTTP cache, GPU cache, CachedData, logs.
- **Workspace storage** — per-workspace state and recent workspaces list.
- **Global state** — a SQLite file `state.vscdb` in `globalStorage` that holds:
  - Extension and UI state (ItemTable)
  - Cursor-specific data (cursorDiskKV): chat bubbles, Composer checkpoints, session metadata, agent/blob cache

As you use Cursor over time, the global `state.vscdb` can grow to **500 MB–1 GB+** because of accumulated chat bubbles, checkpoints, and blob cache. Loading and querying this file can contribute to high memory use and **OOM** or **repeated crashes**. Reducing its size (and clearing caches) helps Cursor start and run more reliably.

### 1.3 Scope

| In scope | Out of scope |
|----------|--------------|
| Clearing Cursor cache directories (Cache, CachedData, Code Cache, GPUCache, logs) | Modifying Cursor application binaries or settings UI |
| Pruning workspace and global `state.vscdb` with SQLite VACUUM | Fixing Cursor product bugs or feature requests |
| Analyzing global `state.vscdb` (tables, key sizes) | Supporting other editors (only Cursor paths are targeted) |
| Deleting keys by pattern (bubbles, checkpoints, composerData, agentKv blobs, ItemTable) with optional "keep last N" | Automated/scheduled runs (script is interactive) |
| Checking SQLite integrity of `state.vscdb` files | Data recovery after accidental deletion |

---

## 2. Prerequisites & Requirements

### 2.1 Environment

- **OS:** Windows (primary; script uses `%APPDATA%`, `%LOCALAPPDATA%`). The underlying Node/TS script can be adapted for macOS/Linux (paths in `prune-state-vscdb.ts`).
- **PowerShell:** Windows PowerShell 5.x or PowerShell Core; execution policy that allows running the script (e.g. `Bypass` for the session).
- **Node.js:** Required for option 2, 3, and 5 (runs `npx tsx scripts/prune-state-vscdb.ts`). Typically Node 18+.
- **SQLite:** Required for options 2, 3, and 5 when pruning or deleting keys. The script looks for `sqlite3` in `PATH` or in standard Windows locations (e.g. `C:\Program Files\SQLite\sqlite3.exe`). Install via e.g. `choco install sqlite` or [sqlite.org](https://www.sqlite.org/download.html).

### 2.2 When to Run

- **Options 1 and 4 (cache cleanup):** Cursor is **closed** (the script can attempt to stop Cursor processes).
- **Options 2 and 3 (VACUUM only):** Cursor should be **closed** so the database is not in use.
- **Option 5 (analyze and/or delete by pattern):** For accurate sizes and safe deletion, Cursor should be **closed**.

---

## 3. Features

### 3.1 Main Menu (5 options)

| Option | Name | What it does | Impact |
|--------|------|---------------|--------|
| **1** | Full cache cleanup | Stops Cursor, then deletes: Cache, CachedData, Code Cache, GPUCache, logs, **workspaceStorage**, **History** (in both AppData and LocalAppData Cursor folders). | Frees the most space. You lose **recent workspaces list** and **local file history**. Settings and extensions are kept. |
| **2** | Prune workspace state.vscdb only | Runs SQLite **VACUUM** on this project's state DB (e.g. `.vscode/state.vscdb` or `.cursor/state.vscdb`). | Reclaims space from deleted entries only. No behavioral impact. Safe. |
| **3** | Prune global state.vscdb only | Runs SQLite **VACUUM** on the global `state.vscdb` (e.g. `%APPDATA%\Cursor\User\globalStorage\state.vscdb`). | Same as 2: reclaims free space only. No behavioral impact. Safe. |
| **4** | Light cleanup (caches only) | Stops Cursor and deletes only: Cache, CachedData, Code Cache, GPUCache, logs. Does **not** delete workspaceStorage or History. | Recent workspaces and file history preserved. Cache rebuilds on next start. |
| **5** | Analyze global state.vscdb | Runs a **read-only** report: file size, tables (ItemTable, cursorDiskKV), and top keys by value size. Then offers **sub-options** to view item counts or delete keys by pattern (see below). | No change until you choose a sub-option and confirm. |

### 3.2 Option 5 — Sub-options (view counts or delete by pattern)

After the analysis report, a **sub-menu loops** so you can run multiple actions (view counts, then prune one category, then another, etc.). The prompt is **Choose 1–7 (or Enter to skip)**. Choose **7** or press **Enter** to exit the sub-menu.

| Sub-option | Action | Description |
|------------|--------|-------------|
| **1** | **View item counts** | **Read-only.** Shows a table with **Count** and **Est. size (MB)** for each category. No data is deleted. |
| **2–6** | Delete by pattern | Prune a category (see table below). You are asked **Are you sure? [Y/N]** before any change; then **A** (all) or **K** (keep last N). |
| **7** | **Exit** | Leave the sub-menu and finish option 5. |

**Categories for view (1) and for delete (2–6):**

| Sub-option | Pattern | Table | Typical size impact | What you lose (if deleted) |
|------------|---------|--------|----------------------|----------------------------|
| **2** | `bubbleId:%` | cursorDiskKV | Often 100–400+ MB | Stored content of **past AI chat bubbles** (Composer/chat). You can't scroll back through old conversations; new chats work normally. |
| **3** | `checkpointId:%` | cursorDiskKV | Often 100–300+ MB | **Composer checkpoints** (snapshots to restore session state). You can't restore older Composer states from the UI; current and new sessions unaffected. |
| **4** | `composerData:%` | cursorDiskKV | Typically 1–50+ MB | **Composer session metadata** (context, panel state). Past session layout/context; new sessions work normally. |
| **5** | `agentKv:blob:%` | cursorDiskKV | Often 100–400+ MB | **Cached agent/blob data** (model outputs, context). Cursor may re-download or regenerate; possible brief performance change. |
| **6** | `cursor.composer%` | ItemTable | Usually &lt; 1 MB | Some **Cursor Composer UI state**. Minor. |

**Sub-option 1 — View item counts (use and expected outcome):**

- **Use:** Choose **1** to see **how many items** and **estimated size (MB)** per category without deleting anything. Helpful before pruning (e.g. "I have 25,000 agent blobs; I'll delete all but the last 500").
- **Expected outcome:** The script runs `npx tsx scripts/prune-state-vscdb.ts --count-categories`. You see path, file size, then a table: **Category | Count | Est. size (MB)**. No files are modified.

**Sub-options 2–6 (delete):** Before pruning, you must confirm **Are you sure? [Y/N]**; if **N**, pruning is cancelled and the menu is shown again. If **Y**:

- **Delete (A)ll** — Remove all keys matching the pattern.
- **Keep last N** — Delete only the "oldest" keys (by SQLite `rowid`), keeping the last N.

After pruning sub-options **2, 3, 4, or 5**, the script shows a **Final Note**: after restarting Cursor you may see a run-time error when connecting and may need to create a **"New Agent"** to continue conversations. The sub-menu then appears again until you choose **7** or **Enter**.

### 3.3 Underlying Script: `prune-state-vscdb.ts`

The PowerShell script calls `npx tsx scripts/prune-state-vscdb.ts` for options 2, 3, and 5. That script supports:

- **VACUUM** (options 2/3): `--workspace`, `--global`, `--threshold <MB>`.
- **Analyze:** `--analyze` (read-only report).
- **Delete by pattern:** `--analyze --table <ItemTable|cursorDiskKV> --delete-keys "<pattern>" [--keep-last N]`.
- **Count categories:** `--count-categories` — runs `SELECT COUNT(*)` and `SUM(LENGTH(value))` per category and prints a table (path, file size, category | count | est. size MB). Read-only; no deletion. Used by option 5 sub-option 1.
- **Integrity check:** `--check-integrity [--global-only]` (SQLite `PRAGMA quick_check` and `integrity_check`).

You can run these commands directly from a shell if you prefer not to use the PowerShell menu.

---

## 4. Benefits

- **Reduce OOM and crashes** by shrinking the global `state.vscdb` and clearing caches that contribute to memory and disk load.
- **Targeted pruning** so you can free hundreds of MB (e.g. agent blobs, bubbles, checkpoints) while optionally **keeping the last N** items.
- **Transparency** via the analyze report (what's big and where), so you can decide what to prune.
- **Graduated choices** from safe VACUUM-only (options 2, 3) to light cache-only (4) to full cleanup (1) to key-level deletion (5).
- **Integrity check** (via the TS script) to confirm `state.vscdb` is not corrupted before/after pruning.
- **No code or project changes** — only Cursor's own cache and state files are touched; your repos and source code are unaffected.

---

## 5. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Cursor open during prune/delete** — file locked or inconsistent state | Run with Cursor **closed**. Options 1 and 4 try to stop Cursor processes before cleanup. |
| **Losing recent workspaces / file history** | Only **option 1** removes workspaceStorage and History. Use option 4 for "light" cleanup if you want to keep them. |
| **Losing chat/Composer history or checkpoints** | Sub-options 1–4 delete Cursor-stored conversation/checkpoint/blob data. Use "keep last N" to retain the most recent N items. |
| **Run-time error / "New Agent" after pruning** | Expected possible outcome after sub-options 1–4. The script shows a **Final Note**; create a **New Agent** in Cursor to continue. |
| **SQLite not installed** | Script reports an error. Install SQLite (e.g. `choco install sqlite`) and ensure `sqlite3` is on PATH or in the expected Windows locations. |
| **Accidental full cleanup** | Option 1 is explicit ("Full cache cleanup"); script does not run destructive options without user choice. |
| **Corruption of state.vscdb** | Run `npx tsx scripts/prune-state-vscdb.ts --check-integrity` (Cursor closed) to verify. VACUUM and delete operations use standard SQLite; avoid interrupting the script. |

---

## 6. Outputs

### 6.1 Console Output

- **Main menu:** Printed list of options 1–5 and prompt for input.
- **Option 1:** Messages about stopping Cursor, each directory cleared, size freed, and "Cursor will rebuild cache on next startup."
- **Option 2 / 3:** Path and size of each `state.vscdb` considered; "above/below threshold"; before/after size and space saved after VACUUM; "Pruning complete" with count and total reclaimed.
- **Option 4:** Same as 1 but only cache dirs; "Workspace list and History kept."
- **Option 5:**  
  - **Analyze:** "Global state.vscdb analysis", path, file size, tables, per-table total value size, top 50 keys by size, then "Sub-options" including "6) View item counts for all categories", and prompt "Choose 1–6 (or Enter to skip)".  
  - **Sub-menu loops** until user chooses **7** or **Enter**. Prompt: "Choose 1-7 (or Enter to skip)".
  - **If sub-option 1:** "Item counts by category (global state.vscdb)", path, file size, table: Category | Count | Est. size (MB). No deletion.
  - **If sub-option 2–6 (delete):** "You are about to prune: … Are you sure? [Y/N]"; if Y, "Delete (A)ll or (K)eep last N?", then "Deleting keys by pattern", VACUUM, "Freed: X MB". If N, "Pruning cancelled."
  - **If sub-option 2–5:** "Final Note" about possible run-time error and "New Agent".

### 6.2 Side Effects (on disk)

- **Option 1:** Cache dirs, workspaceStorage, and History under Cursor AppData/LocalAppData removed or emptied.
- **Option 2:** Workspace `state.vscdb` file rewritten (smaller) by VACUUM.
- **Option 3:** Global `state.vscdb` rewritten (smaller) by VACUUM.
- **Option 4:** Only cache dirs removed; workspaceStorage and History unchanged.
- **Option 5 + sub-option 1–5 (delete):** Rows deleted from global `state.vscdb` (cursorDiskKV or ItemTable), then VACUUM run on that file.
- **Option 5 + sub-option 6 (view counts):** No change on disk; read-only queries.

No separate log file is created unless you redirect output (e.g. `.\scripts\clear-cursor-cache.ps1 > log.txt`).

---

## 7. How to Run

### 7.1 From project root (recommended)

```powershell
# From the repository root (parent of scripts/)
powershell -ExecutionPolicy Bypass -File .\scripts\clear-cursor-cache.ps1
```

Or:

```powershell
cd D:\path\to\your\repo
.\scripts\clear-cursor-cache.ps1
```

If execution policy blocks the script:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\clear-cursor-cache.ps1
```

### 7.2 Dependencies

- **Node/npx:** From the repo root, `npx tsx scripts/prune-state-vscdb.ts` must work (options 2, 3, 5).
- **SQLite:** Required for pruning and for option 5 delete/VACUUM. Install and ensure `sqlite3` is available.

### 7.3 Typical workflow for OOM / large state.vscdb

1. **Close Cursor** (and any Cursor Agent/Helper processes).
2. Run `.\scripts\clear-cursor-cache.ps1`.
3. Choose **5** to **analyze** and see what's using space.
4. Optionally choose a **sub-option (1–4)** and then **A** (all) or **K** (keep last N) and a number.
5. Restart Cursor. If you see a run-time error when connecting, create a **New Agent** and continue.
6. For future prevention, periodically run **option 3** (VACUUM global) or **option 5** with targeted delete (e.g. keep last 100–500 for blobs/bubbles).

---

## 8. Technical Details (for maintainers / GitHub)

### 8.1 Paths (Windows)

- **Global state.vscdb:** `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
- **Workspace state.vscdb:** `<project>\.vscode\state.vscdb` or `<project>\.cursor\state.vscdb`
- **Cache / workspaceStorage / History:** under `%APPDATA%\Cursor` and `%LOCALAPPDATA%\Cursor` (see script for full list).

### 8.2 Related files

- `scripts/clear-cursor-cache.ps1` — Interactive menu and orchestration.
- `scripts/prune-state-vscdb.ts` — All VACUUM, analyze, delete-by-pattern, and integrity-check logic; used by options 2, 3, and 5.

### 8.3 Standalone use

If this is published as a **standalone GitHub repo** for Cursor users:

- Include at least: `scripts/clear-cursor-cache.ps1`, `scripts/prune-state-vscdb.ts`, and a `package.json` that allows `npx tsx scripts/prune-state-vscdb.ts` (e.g. `tsx` as a dependency).
- This document can serve as the main **README** or **docs/SCRIPT_GUIDE.md**; link it from the repo README.
- Recommend closing Cursor before running and mention the "New Agent" note after sub-options 1–4.

---

## 9. FAQ

**Q: Will this delete my code or projects?**  
A: No. Only Cursor's cache and state files (and optionally workspace list / local history if you choose option 1) are touched. Your source code and repos are unchanged.

**Q: I get "sqlite3 not found".**  
A: Install SQLite and ensure the `sqlite3` binary is on your PATH or in a standard Windows location (see script or `prune-state-vscdb.ts`).

**Q: After pruning bubbles/checkpoints/blobs, Cursor shows an error when connecting.**  
A: The script's **Final Note** explains this: create a **"New Agent"** in Cursor to continue. Your projects and settings are still there.

**Q: Can I run only VACUUM without deleting any keys?**  
A: Yes. Use **option 2** (workspace) or **option 3** (global). They only run SQLite VACUUM and do not delete rows.

**Q: What does "keep last N" mean?**  
A: For the chosen pattern, the script keeps the N most recently stored rows (by SQLite `rowid`) and deletes the rest. So you retain the "newest" N items (e.g. last 100 chat bubbles or blobs).

**Q: How do I see how many items are in each category without deleting?**  
A: Choose **option 5** (Analyze), then **sub-option 1** (View item counts for all categories). You get a table with Count and Est. size (MB) for each category. No data is deleted. You can also run `npx tsx scripts/prune-state-vscdb.ts --count-categories` from the repo root.

**Q: Can I prune more than one category in one go?**  
A: Yes. Under option 5 the sub-menu **loops**: after each action (view counts or prune) the menu is shown again. Choose **7** or press **Enter** to exit. Before any prune you must confirm **Are you sure? [Y/N]**.

**Q: Does this work on macOS or Linux?**  
A: The PowerShell script is written for Windows. The underlying `prune-state-vscdb.ts` uses paths that can be extended for macOS/Linux; you could run it with `npx tsx scripts/prune-state-vscdb.ts` and the same flags from a shell.

---

## 10. Summary

| Section | Content |
|--------|---------|
| **Use** | Reduce Cursor disk use and memory pressure; recover from OOM and repeated crashes caused by large `state.vscdb` and caches. |
| **Scope** | Cursor cache dirs and SQLite `state.vscdb` (workspace + global); analyze and optional key-level pruning with "keep last N". |
| **Features** | Five main options; option 5 sub-menu loops (1=view counts with Est. size MB, 2–6=delete by category, 7=exit); Are you sure? [Y/N] before pruning; integrity check via TS script. |
| **Benefits** | Fewer OOM/crashes, targeted pruning, transparency, graduated safety, no impact on project files. |
| **Risks** | Loss of workspace list/history (option 1 only), loss of chat/checkpoint/blob data (sub-options 1–4), possible "New Agent" after restart; mitigated by prompts and Final Note. |
| **Outputs** | Console messages and on-disk changes (cleaned dirs, shrunk/reduced `state.vscdb`). |

This script is provided to help the community manage Cursor's local state when it grows too large. Use options 2 or 3 for the safest space reclaim; use option 5 with sub-options when you need aggressive reduction and accept losing older chat/checkpoint/blob data (with optional "keep last N").
