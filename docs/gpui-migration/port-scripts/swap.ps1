# Dot-source, then: Swap <file> <old text> <new text> [-All]
# Exact text replacement that keeps the file's bytes (LF stays LF).
function Swap([string]$Path, [string]$Old, [string]$New, [switch]$All) {
    $full = (Resolve-Path $Path).Path
    $t = [IO.File]::ReadAllText($full)
    $n = ([regex]::Matches($t, [regex]::Escape($Old))).Count
    if ($n -eq 0) { Write-Output "MISSING in ${Path}: $Old"; return }
    if ($n -gt 1 -and -not $All) { Write-Output "AMBIGUOUS ($n) in ${Path}: $Old"; return }
    $t = $t.Replace($Old, $New)
    [IO.File]::WriteAllText($full, $t, (New-Object Text.UTF8Encoding $false))
    Write-Output "ok ($n) $Path"
}
