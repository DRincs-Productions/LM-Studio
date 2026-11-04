$ErrorActionPreference = 'Stop'

if (-not $env:GITHUB_REPOSITORY -or -not $env:CURRENT_TAG -or -not $env:RUNNER_TEMP) {
  throw 'GITHUB_REPOSITORY, CURRENT_TAG, and RUNNER_TEMP must be set by the GitHub Actions job.'
}

$api = "https://api.github.com/repos/$env:GITHUB_REPOSITORY"
$headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'Shadow-Controller-Updater-Smoke-Test' }
$current = Invoke-RestMethod -Uri "$api/releases/tags/$env:CURRENT_TAG" -Headers $headers
$stableReleases = Invoke-RestMethod -Uri "$api/releases?per_page=100" -Headers $headers
$previous = $stableReleases |
  Where-Object { -not $_.prerelease -and -not $_.draft -and $_.tag_name -ne $env:CURRENT_TAG -and $_.tag_name -like 'server-v*' } |
  Sort-Object published_at -Descending |
  Select-Object -First 1

function Get-SetupAsset($release) {
  $asset = $release.assets | Where-Object { $_.name -match '-setup\.exe$' } | Select-Object -First 1
  if (-not $asset) { throw "No NSIS setup executable found in $($release.tag_name)" }
  return $asset.browser_download_url
}

function Install-Release($release, $name) {
  $root = Join-Path $env:RUNNER_TEMP $name
  $install = Join-Path $root 'app'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $setup = Join-Path $root 'setup.exe'
  Invoke-WebRequest -Uri (Get-SetupAsset $release) -OutFile $setup
  $process = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$install") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer $($release.tag_name) failed with exit code $($process.ExitCode)" }
  $exe = Join-Path $install 'shadow-controller.exe'
  if (-not (Test-Path $exe)) { throw "Installed executable missing for $($release.tag_name): $exe" }
  return @{ Root = $root; Install = $install; Exe = $exe; Data = (Join-Path $env:APPDATA 'com.drincs.shadowcontroller') }
}

function Stop-TestApp($exe) {
  Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -eq $exe } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Remove-TestInstall($test) {
  if (-not $test) { return }
  Stop-TestApp $test.Exe
  $uninstaller = Join-Path $test.Install 'uninstall.exe'
  if (Test-Path $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait }
  Remove-Item -LiteralPath $test.Root -Recurse -Force -ErrorAction SilentlyContinue
}

function Wait-ForLog($test, $pattern, $timeoutSeconds = 240) {
  $log = Join-Path $test.Data 'update.log'
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern $pattern -Quiet)) { return $log }
    Start-Sleep -Seconds 2
  }
  if (Test-Path $log) { Get-Content $log }
  $coordinatorLog = Join-Path $test.Data 'coordinator.log'
  if (Test-Path $coordinatorLog) {
    Write-Host "Coordinator log: $coordinatorLog"
    Get-Content $coordinatorLog
  }
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq 'shadow-controller.exe' } |
    Select-Object ProcessId, ExecutablePath, CommandLine |
    Format-List
  throw "Timed out waiting for update log pattern '$pattern' for $($test.Exe)"
}

function Stop-TestCoordinator($test, $requestStop = $false) {
  if (-not $test) { return }
  $stopFile = Join-Path $test.Data 'coordinator.stop'
  $pidFile = Join-Path $test.Data 'coordinator.pid'
  if ($requestStop -and (Test-Path $pidFile)) {
    $token = (Get-Content $pidFile | Select-Object -Skip 1 -First 1)
    if ($token) { Set-Content -LiteralPath $stopFile -Value $token -NoNewline }
  }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and (Test-Path $pidFile)) { Start-Sleep -Milliseconds 250 }
  if (Test-Path $pidFile) { throw "Coordinator did not stop in its isolated profile: $pidFile" }
  if (Test-Path $stopFile) { Remove-Item -LiteralPath $stopFile -Force }
}

function Clear-UpdateLog($test) {
  if (-not $test) { return }
  $log = Join-Path $test.Data 'update.log'
  if (Test-Path $log) { Remove-Item -LiteralPath $log -Force }
}

$currentTest = $null
$previousTest = $null
try {
  $currentTest = Install-Release $current 'shadow-controller-current-smoke'
  Clear-UpdateLog $currentTest
  $currentProcess = Start-Process -FilePath $currentTest.Exe -ArgumentList '--background' -PassThru
  Write-Host "Started $($current.tag_name) smoke app as PID $($currentProcess.Id)"
  $currentLog = Wait-ForLog $currentTest 'No newer release available'
  Write-Host "PASS: $($current.tag_name) starts with no update and logs $currentLog"
  Stop-TestCoordinator $currentTest $true
  Remove-TestInstall $currentTest
  $currentTest = $null

  if ($previous) {
    $previousTest = Install-Release $previous 'shadow-controller-upgrade-smoke'
    Clear-UpdateLog $previousTest
    $previousProcess = Start-Process -FilePath $previousTest.Exe -ArgumentList '--background' -PassThru
    Write-Host "Started $($previous.tag_name) upgrade app as PID $($previousProcess.Id)"
    $upgradePattern = "Found signed update $($current.tag_name.Substring('server-v'.Length))"
    $upgradeLog = Wait-ForLog $previousTest $upgradePattern 360
    $stableLog = Wait-ForLog $previousTest 'No newer release available' 360
    Write-Host "PASS: $($previous.tag_name) automatically updated to $($current.tag_name); update log $upgradeLog; post-update log $stableLog"
    Stop-TestCoordinator $previousTest $true
  } else {
    Write-Host 'No previous stable server release exists; upgrade test will run on the next stable release.'
  }
} finally {
  Remove-TestInstall $currentTest
  Remove-TestInstall $previousTest
}
