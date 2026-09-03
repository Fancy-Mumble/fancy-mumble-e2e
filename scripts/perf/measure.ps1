param(
  [int]$RootPid = 0,
  [int]$Seconds = 10,
  [string]$Label = ""
)
# Enumerate the process tree under the client (mumble-tauri.exe + its WebView2
# children), sample CPU over $Seconds, and print per-process + totals.
# PWS = private working set (what Task Manager's "Memory" column shows).
if ($RootPid -eq 0) {
  $root = Get-Process -Name mumble-tauri -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1
  if (-not $root) { Write-Host "no mumble-tauri process"; exit 1 }
  $RootPid = $root.Id
}
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
$tree = New-Object System.Collections.Generic.List[int]
$tree.Add($RootPid)
$i = 0
while ($i -lt $tree.Count) {
  $p = $tree[$i]; $i++
  foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $p })) {
    if (-not $tree.Contains([int]$c.ProcessId)) { $tree.Add([int]$c.ProcessId) }
  }
}
$kind = @{}
foreach ($pid_ in $tree) {
  $row = $all | Where-Object { $_.ProcessId -eq $pid_ }
  $cl = "$($row.CommandLine)"
  $k = $row.Name
  if ($cl -match '--type=([a-z-]+)') { $k = $Matches[1]; if ($cl -match '--utility-sub-type=([A-Za-z.]+)') { $k = $Matches[1] -replace '\.mojom\.', ':' } }
  elseif ($row.Name -eq 'msedgewebview2.exe') { $k = 'browser' }
  $kind[$pid_] = $k
}
$t0 = @{}
foreach ($pid_ in $tree) { $pr = Get-Process -Id $pid_ -ErrorAction SilentlyContinue; if ($pr) { $t0[$pid_] = $pr.TotalProcessorTime.TotalMilliseconds } }
Start-Sleep -Seconds $Seconds
$pws = @{}
foreach ($perf in (Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { $tree.Contains([int]$_.IDProcess) })) { $pws[[int]$perf.IDProcess] = $perf.WorkingSetPrivate }
$rows = @()
foreach ($pid_ in $tree) {
  $pr = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
  if (-not $pr) { continue }
  $cpu = $pr.TotalProcessorTime.TotalMilliseconds - $t0[$pid_]
  $rows += [pscustomobject]@{
    Pid = $pid_
    Kind = $kind[$pid_]
    'CPU%' = [math]::Round($cpu / ($Seconds * 1000) * 100, 2)   # % of ONE core
    'PWS_MB' = if ($pws.ContainsKey($pid_)) { [math]::Round($pws[$pid_] / 1MB, 1) } else { -1 }
    'WS_MB' = [math]::Round($pr.WorkingSet64 / 1MB, 1)
    'Commit_MB' = [math]::Round($pr.PrivateMemorySize64 / 1MB, 1)
    'Thr' = $pr.Threads.Count
  }
}
if ($Label) { Write-Host "== $Label  ($(Get-Date -Format HH:mm:ss), ${Seconds}s window)" }
$rows | Sort-Object PWS_MB -Descending | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
$ws = ($rows | Measure-Object WS_MB -Sum).Sum
$pv = ($rows | Measure-Object Commit_MB -Sum).Sum
$pw = ($rows | Measure-Object PWS_MB -Sum).Sum
$cp = ($rows | Measure-Object 'CPU%' -Sum).Sum
Write-Host ("TOTAL  procs={0}  PWS={1:N1} MB  WS={2:N1} MB  Commit={3:N1} MB  CPU={4:N2}% of one core" -f $rows.Count, $pw, $ws, $pv, $cp)
