param([int]$RootPid, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
while (Get-Process -Id $RootPid -ErrorAction SilentlyContinue) {
    $all = Get-CimInstance Win32_Process
    $ids = @($RootPid)
    do {
        $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { [int]$_.ProcessId })
        $ids += $next
    } while ($next.Count)
    $processes = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
    [pscustomobject]@{
        time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        workingSetBytes = ($processes | Measure-Object WorkingSet64 -Sum).Sum
        privateBytes = ($processes | Measure-Object PrivateMemorySize64 -Sum).Sum
        processes = @($processes | ForEach-Object { @{ pid = $_.Id; name = $_.ProcessName } })
    } | ConvertTo-Json -Compress -Depth 4 | Add-Content -LiteralPath $OutputPath
    Start-Sleep -Milliseconds 500
}
