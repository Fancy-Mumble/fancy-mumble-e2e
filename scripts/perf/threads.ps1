param([int]$ProcId, [int]$Seconds = 10)
# Per-thread CPU of one process over a window, with thread names (GetThreadDescription).
$code = @'
using System; using System.Runtime.InteropServices;
public static class Thr {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenThread(uint access, bool inherit, uint id);
  [DllImport("kernel32.dll")] public static extern int GetThreadDescription(IntPtr h, out IntPtr desc);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
  public static string Name(uint id) {
    IntPtr h = OpenThread(0x0040, false, id); if (h == IntPtr.Zero) return "?";
    IntPtr d; string s = "";
    if (GetThreadDescription(h, out d) >= 0 && d != IntPtr.Zero) { s = Marshal.PtrToStringUni(d); LocalFree(d); }
    CloseHandle(h); return s;
  }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'Thr').Type) { Add-Type -TypeDefinition $code }
$p = Get-Process -Id $ProcId
$t0 = @{}; foreach ($t in $p.Threads) { $t0[$t.Id] = $t.TotalProcessorTime.TotalMilliseconds }
Start-Sleep -Seconds $Seconds
$p = Get-Process -Id $ProcId
$rows = foreach ($t in $p.Threads) { $prev = if ($t0.ContainsKey($t.Id)) { $t0[$t.Id] } else { 0 }; [pscustomobject]@{ Tid=$t.Id; 'ms'=[math]::Round($t.TotalProcessorTime.TotalMilliseconds - $prev,1); Name=[Thr]::Name([uint32]$t.Id) } }
$total = ($rows | Measure-Object ms -Sum).Sum
"process total: {0} ms over {1}s = {2:N2}% of one core, {3} threads" -f $total, $Seconds, ($total / ($Seconds * 10)), $p.Threads.Count
$rows | Where-Object { $_.ms -gt 0 } | Sort-Object ms -Descending | Select-Object -First 8 | Format-Table -AutoSize | Out-String -Width 120
