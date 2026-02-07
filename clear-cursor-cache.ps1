# Clear Cursor Cache Script (with multiple-choice pruning options)
# Run: powershell -ExecutionPolicy Bypass -File scripts/clear-cursor-cache.ps1

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "=== Cursor cache & state pruning ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Choose what to do (Cursor must be closed for options 1, 2, 3, 4):" -ForegroundColor White
Write-Host ""
Write-Host "  1. Full cache cleanup" -ForegroundColor Yellow
Write-Host "     Kills Cursor, then deletes: Cache, CachedData, Code Cache, GPUCache, logs," -ForegroundColor Gray
Write-Host "     workspaceStorage, and History. Frees the most space; Cursor rebuilds cache on next start." -ForegroundColor Gray
Write-Host "     Impact: You lose recent workspaces list and local file history. Settings and extensions kept." -ForegroundColor Gray
Write-Host ""
Write-Host "  2. Prune workspace state.vscdb only" -ForegroundColor Yellow
Write-Host "     Shrinks this project state database (.vscode/state.vscdb) with SQLite VACUUM." -ForegroundColor Gray
Write-Host "     Impact: None on behavior. Only reclaims space from deleted entries. Safe (close Cursor first)." -ForegroundColor Gray
Write-Host ""
Write-Host "  3. Prune global state.vscdb only" -ForegroundColor Yellow
Write-Host "     Shrinks Cursor global state (AppData\...\globalStorage\state.vscdb) with VACUUM." -ForegroundColor Gray
Write-Host "     Impact: None on behavior. Reclaims space only. Safe (close Cursor first)." -ForegroundColor Gray
Write-Host ""
Write-Host "  4. Light cleanup (caches only, keep workspace list & history)" -ForegroundColor Yellow
Write-Host "     Kills Cursor and deletes only: Cache, CachedData, Code Cache, GPUCache, logs." -ForegroundColor Gray
Write-Host "     Does NOT delete workspaceStorage or History." -ForegroundColor Gray
Write-Host "     Impact: Recent workspaces and file history preserved. Cache rebuilds on next start." -ForegroundColor Gray
Write-Host ""

$choice = Read-Host "
  5. Analyze global state.vscdb (why is it so large?)
     Lists tables and top keys by size so you can see what uses the 800+ MB.
     Impact: None. Read-only report. Run with Cursor closed for accurate size.

Enter 1, 2, 3, 4, or 5 (or press Enter to cancel)"
if ($choice -notmatch '^[1-5]$') { Write-Host "No option selected. Exiting." -ForegroundColor Cyan; exit 0 }

$scriptRoot = $PSScriptRoot
$projectRoot = Split-Path $scriptRoot -Parent

function Invoke-PruneStateVscdb { param([switch]$Workspace, [switch]$Global)
  $argList = @(); if ($Workspace) { $argList += "--workspace" }; if ($Global) { $argList += "--global" }; $argList += "--threshold"; $argList += "0"
  Set-Location $projectRoot; & npx tsx "$scriptRoot\prune-state-vscdb.ts" @argList
  if ($LASTEXITCODE -ne 0) { Write-Host "Prune script error. Ensure Cursor is closed and sqlite3 is installed if needed." -ForegroundColor Yellow }
}

function Stop-CursorProcesses {
  $all = @(); foreach ($n in @("Cursor", "Cursor Agent", "Cursor Helper")) { try { $p = Get-Process -Name $n -ErrorAction SilentlyContinue; if ($p) { $all += $p } } catch {} }
  $all += Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "*ursor*" }
  if ($all.Count -gt 0) {
    Write-Host "Stopping $($all.Count) Cursor process(es)..." -ForegroundColor Yellow
    foreach ($proc in $all) { try { $proc.CloseMainWindow() | Out-Null; Start-Sleep -Milliseconds 500; if (!$proc.HasExited) { Stop-Process -Id $proc.Id -Force } } catch {} }
    Start-Sleep -Seconds 5
  } else { Start-Sleep -Seconds 2 }
}

function Clear-CacheDirs { param([switch]$IncludeWorkspaceStorageAndHistory)
  $cursorAppData = "$env:APPDATA\Cursor"; $cursorLocal = "$env:LOCALAPPDATA\Cursor"
  $allDirs = @("$cursorAppData\Cache", "$cursorAppData\CachedData", "$cursorAppData\Code Cache", "$cursorAppData\GPUCache", "$cursorAppData\logs", "$cursorLocal\Cache", "$cursorLocal\CachedData", "$cursorLocal\Code Cache", "$cursorLocal\GPUCache", "$cursorLocal\logs", "$cursorLocal\User\workspaceStorage", "$cursorLocal\User\History")
  if (-not $IncludeWorkspaceStorageAndHistory) { $allDirs = $allDirs | Where-Object { $_ -notlike "*workspaceStorage*" -and $_ -notlike "*\History" } }
  $totalFreed = 0
  foreach ($dir in $allDirs) {
    if (Test-Path $dir) {
      $size = (Get-ChildItem $dir -Recurse -File -EA SilentlyContinue | Measure-Object -Property Length -Sum -EA SilentlyContinue).Sum
      if ($size -gt 0) { Write-Host "Clearing: $dir ($([math]::Round($size/1MB,2)) MB)" -ForegroundColor Yellow; try { Remove-Item $dir -Recurse -Force -EA Stop; Write-Host "  [OK]" -ForegroundColor Green; $totalFreed += $size } catch { Write-Host "  [FAILED]" -ForegroundColor Red } }
    }
  }
  Write-Host "Total freed: $([math]::Round($totalFreed/1MB,2)) MB" -ForegroundColor Green
}

switch ($choice) {
  "1" { Write-Host ""; Write-Host "Full cache cleanup" -ForegroundColor Cyan; Stop-CursorProcesses; Clear-CacheDirs -IncludeWorkspaceStorageAndHistory; Write-Host "Cursor will rebuild cache on next startup." -ForegroundColor Cyan }
  "2" { Write-Host ""; Write-Host "Prune workspace state.vscdb" -ForegroundColor Cyan; Invoke-PruneStateVscdb -Workspace }
  "3" { Write-Host ""; Write-Host "Prune global state.vscdb" -ForegroundColor Cyan; Invoke-PruneStateVscdb -Global }
  "4" { Write-Host ""; Write-Host "Light cleanup" -ForegroundColor Cyan; Stop-CursorProcesses; Clear-CacheDirs; Write-Host "Workspace list and History kept." -ForegroundColor Cyan }
  "5" {
    Write-Host ""; Write-Host "Analyze global state.vscdb" -ForegroundColor Cyan
    $proj = Split-Path $PSScriptRoot -Parent
    Push-Location $proj
    try {
      npx tsx scripts/prune-state-vscdb.ts --analyze
      Write-Host ""
      Write-Host "--- Delete keys by pattern (run with Cursor closed) ---" -ForegroundColor Cyan
      Write-Host "  1) bubbleId:%  (cursorDiskKV) - chat bubbles" -ForegroundColor Gray
      Write-Host "  2) checkpointId:%  (cursorDiskKV) - Composer checkpoints" -ForegroundColor Gray
      Write-Host "  3) composerData:%  (cursorDiskKV) - Composer session metadata" -ForegroundColor Gray
      Write-Host "  4) agentKv:blob:%  (cursorDiskKV) - agent/blob cache" -ForegroundColor Gray
      Write-Host "  5) cursor.composer%  (ItemTable) - small UI state" -ForegroundColor Gray
      $sub = Read-Host "Delete which pattern? (1-5, or Enter to skip)"
      if ($sub -match '^[1-5]$') {
        $table = if ($sub -eq '5') { 'ItemTable' } else { 'cursorDiskKV' }
        $pattern = switch ($sub) { '1' { 'bubbleId:%' }; '2' { 'checkpointId:%' }; '3' { 'composerData:%' }; '4' { 'agentKv:blob:%' }; '5' { 'cursor.composer%' }; default { $null } }
        if ($pattern) {
          $ak = Read-Host "Delete (A)ll matching items, or (K)eep last N items? [A/K]"
          $keepLast = $null
          if ($ak -match '^[Kk]') {
            $nStr = Read-Host "Keep how many items? (e.g. 100)"
            $n = 0; if ([int]::TryParse($nStr.Trim(), [ref]$n) -and $n -gt 0) { $keepLast = $n }
          }
          $argList = @('--analyze', '--table', $table, '--delete-keys', $pattern)
          if ($null -ne $keepLast) { $argList += '--keep-last'; $argList += $keepLast }
          Write-Host "Running: npx tsx scripts/prune-state-vscdb.ts $($argList -join ' ')" -ForegroundColor Yellow
          & npx tsx scripts/prune-state-vscdb.ts @argList
          if ($LASTEXITCODE -ne 0) { Write-Host "Prune/delete error. Ensure Cursor is closed and sqlite3 is installed." -ForegroundColor Yellow }
          if ($sub -match '^[1-4]$') {
            Write-Host ""
            Write-Host "Final Note:" -ForegroundColor Cyan
            Write-Host "  If you fully pruned the selected items (sub-options 1, 2, 3, or 4), after restarting Cursor you may encounter a run-time error when connecting to the server. You may need to create a ""New Agent"" to continue with your conversations." -ForegroundColor Gray
          }
        }
      }
    } finally { Pop-Location }
  }
}
Write-Host ""

