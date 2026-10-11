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
    $typeByPid = @{}
    foreach ($proc in $all) {
      if ($proc.CommandLine -match '--type=([a-z-]+)') { $typeByPid[[int]$proc.ProcessId] = $Matches[1] }
    }
    [pscustomobject]@{
        time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        workingSetBytes = ($processes | Measure-Object WorkingSet64 -Sum).Sum
        privateBytes = ($processes | Measure-Object PrivateMemorySize64 -Sum).Sum
        processes = @($processes | ForEach-Object { @{ pid = $_.Id; name = $_.ProcessName } })
        perProcess = @($processes | ForEach-Object { $procType = if ($typeByPid.ContainsKey([int]$_.Id)) { $typeByPid[[int]$_.Id] } else { '' }; @{ pid = $_.Id; name = $_.ProcessName; type = $procType; wsBytes = $_.WorkingSet64; privateBytes = $_.PrivateMemorySize64 } })
    } | ConvertTo-Json -Compress -Depth 4 | Add-Content -LiteralPath $OutputPath
    Start-Sleep -Milliseconds 500
}
