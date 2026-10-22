#Requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'portable.ps1') -Library
function Get-MwsDshProcesses { return @() }
function Assert-Test([bool]$Condition, [string]$Message) { if (-not $Condition) { throw ('TEST FAILED: ' + $Message) } }
function Assert-Throws([scriptblock]$Action, [string]$Expected) {
    try { & $Action | Out-Null } catch {
        if ($_.Exception.Message -like ('*' + $Expected + '*')) { return }
        throw ('TEST FAILED: wrong error. Expected ' + $Expected + '; got ' + $_.Exception.Message)
    }
    throw ('TEST FAILED: expected an error containing ' + $Expected)
}

$testRoot = Join-Path $PSScriptRoot ('test-work\' + [Guid]::NewGuid().ToString('N'))
$unicodeName = [string][char]0x63D2 + [char]0x4EF6 + ' path with spaces'
$fixture = Join-Path $testRoot $unicodeName
$fixtureHome = Join-Path $fixture '.dsh isolated'
$source = Join-Path $fixture 'release source'
$profilePath = Join-Path $fixtureHome 'profiles\desktop'
$manifestPath = Join-Path $profilePath 'package.json'
$fakeCli = Join-Path $fixture 'fake dsh.ps1'
$success = $false
$savedTestFail = $env:MWS_TEST_FAIL_MODE
$savedDshHome = $env:DSH_HOME
$savedOffline = $env:npm_config_offline
$savedIgnoreScripts = $env:npm_config_ignore_scripts
New-Item -ItemType Directory -Path (Join-Path $source 'lib'), $profilePath -Force | Out-Null
Write-MwsUtf8 (Join-Path $source 'package.json') '{"name":"dsh-multi-workspace","version":"1.0.0","type":"module","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}'
Write-MwsUtf8 (Join-Path $source 'cordis.patch.yml') '- insert: []'
Write-MwsUtf8 (Join-Path $source 'lib\index.js') 'export function apply() {}'
Write-MwsUtf8 (Join-Path $source 'lib\client.js') '/* prebuilt client fixture */'
Write-MwsUtf8 $manifestPath '{"name":"profile-test","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","other-plugin"]}},"dependencies":{"other-plugin":"link:D:/an unrelated place"},"customSetting":{"keep":"unchanged","nested":{"alpha":1,"zeta":2},"sequence":["alpha","beta"]}}'
Write-MwsUtf8 (Join-Path $profilePath 'cordis.patch.yml') "# unrelated user patch`n- id: kept-setting`n"
Write-MwsUtf8 (Join-Path $profilePath 'pnpm-workspace.yaml') "packages:`n  - .`nautoInstallPeers: false`n"
$mockSource = @'
$ErrorActionPreference = 'Stop'
if ($args -notcontains '--offline' -or $args -notcontains '--ignore-scripts') { throw 'Mock requires explicit offline and no-script arguments.' }
if ($env:npm_config_offline -ne 'true' -or $env:npm_config_ignore_scripts -ne 'true') { throw 'Mock requires inherited offline and no-script configuration.' }
$profileIndex = [Array]::IndexOf($args, '--profile')
$profile = $args[$profileIndex + 1]
$operation = $args[$profileIndex + 2]
$value = $args[$profileIndex + 3]
$dir = Join-Path $env:DSH_HOME ('profiles\' + $profile)
$path = Join-Path $dir 'package.json'
$manifest = [IO.File]::ReadAllText($path) | ConvertFrom-Json
$name = 'dsh-multi-workspace'
$nodeLink = Join-Path $dir ('node_modules\' + $name)
$existing = Get-Item -LiteralPath $nodeLink -Force -ErrorAction SilentlyContinue
if ($existing) {
    if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { [IO.Directory]::Delete($nodeLink, $false) }
    else { Remove-Item -LiteralPath $nodeLink -Recurse -Force }
}
if ($operation -eq 'add') {
    $target = $value.Substring('link:'.Length)
    if (-not $manifest.dependencies) { $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
    $manifest.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
    if (@($manifest.dsh.profile.bundles) -notcontains $name) { $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles) + $name }
    New-Item -ItemType Directory -Path (Split-Path -Parent $nodeLink) -Force | Out-Null
    # A normal directory fixture avoids requiring junction privileges in CI.
    # The real DSH CLI creates and owns its actual node_modules link.
    Copy-Item -LiteralPath $target -Destination $nodeLink -Recurse
} elseif ($operation -eq 'remove') {
    $manifest.dependencies.PSObject.Properties.Remove($name)
    $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne $name })
} else { throw ('Unexpected operation: ' + $operation) }
if ($env:MWS_TEST_FAIL_MODE -eq 'unrelated') { $manifest.customSetting.keep = 'unexpected mutation' }
if ($env:MWS_TEST_FAIL_MODE -eq 'arrayorder') { $manifest.customSetting.sequence = @('beta', 'alpha') }
if ($env:MWS_TEST_FAIL_MODE -eq 'reorder') {
    $manifest.customSetting.nested = [pscustomobject][ordered]@{ zeta = 2; alpha = 1 }
    $manifest.customSetting = [pscustomobject][ordered]@{ sequence = $manifest.customSetting.sequence; nested = $manifest.customSetting.nested; keep = $manifest.customSetting.keep }
    $reordered = [ordered]@{}
    foreach ($property in @($manifest.PSObject.Properties | Sort-Object Name -Descending)) { $reordered[$property.Name] = $property.Value }
    $manifest = [pscustomobject]$reordered
}
[IO.File]::WriteAllText($path, ($manifest | ConvertTo-Json -Depth 50), (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $dir 'pnpm-lock.yaml'), '# mock updated lock', (New-Object Text.UTF8Encoding($false)))
if ($env:MWS_TEST_FAIL_MODE -eq 'exit') {
    # Simulate DSH's repair subprocess: it gets no original pnpm flags.
    # A probe file avoids native-argument quote stripping that would make the
    # environment check itself unreliable on Windows PowerShell 5.1.
    $probe = Join-Path (Split-Path -Parent $path) 'repair-probe.ps1'
    [IO.File]::WriteAllText($probe, 'if ($env:npm_config_offline -ne "true" -or $env:npm_config_ignore_scripts -ne "true") { exit 31 }' + [Environment]::NewLine + 'exit 0' + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    $executable = if ($PSVersionTable.PSVersion.Major -ge 6) { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }
    & $executable -NoProfile -NonInteractive -File $probe
    if ($LASTEXITCODE -ne 0) { throw 'Repair subprocess lost offline/no-script configuration.' }
    $global:LASTEXITCODE = 23
    return
}
$global:LASTEXITCODE = 0
'@
Write-MwsUtf8 $fakeCli $mockSource
$parameters = @{ DshPath = $fakeCli; DshHome = $fixtureHome; Profile = 'desktop'; PluginSource = $source }
try {
    $beforeCheck = [IO.File]::ReadAllText($manifestPath)
    $check = Invoke-MwsDeployment -Mode Check @parameters
    Assert-Test ([IO.File]::ReadAllText($manifestPath) -eq $beforeCheck) 'Check changed profile metadata.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $fixtureHome 'backups'))) 'Check created backup directories.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $fixtureHome 'custom-plugins'))) 'Check created install directories.'
    Write-Host '[PASS] read-only check'

    $env:DSH_HOME = 'an original process value'
    $env:npm_config_offline = 'false'
    $env:npm_config_ignore_scripts = 'false'
    $installed = Invoke-MwsDeployment -Mode Install @parameters
    Assert-Test ($env:DSH_HOME -eq 'an original process value') 'DSH_HOME process value was not restored.'
    Assert-Test ($env:npm_config_offline -eq 'false' -and $env:npm_config_ignore_scripts -eq 'false') 'npm configuration was not restored after success.'
    $manifest = Read-MwsJson $manifestPath
    Assert-Test ($manifest.dependencies.'other-plugin' -eq 'link:D:/an unrelated place') 'Another dependency changed.'
    Assert-Test ($manifest.customSetting.keep -eq 'unchanged') 'Another setting changed.'
    Assert-Test (@($manifest.dsh.profile.bundles).Count -eq 3) 'The plugin bundle was not appended once.'
    Assert-Test ((Read-MwsJson (Join-Path $installed.NodeLink 'package.json')).version -eq '1.0.0') 'The installed link is unreadable.'
    Assert-Test ($installed.InstallDir.Contains($unicodeName)) 'Unicode path fixture was not used.'
    Write-Host '[PASS] offline install with Unicode/spaces and process environment restoration'

    $manifestBeforeFailure = [IO.File]::ReadAllText($manifestPath)
    $lockBeforeFailure = [IO.File]::ReadAllText((Join-Path $profilePath 'pnpm-lock.yaml'))
    Write-MwsUtf8 (Join-Path $source 'package.json') '{"name":"dsh-multi-workspace","version":"1.0.1","type":"module","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}'
    $env:MWS_TEST_FAIL_MODE = 'exit'
    Assert-Throws { Invoke-MwsDeployment -Mode Install @parameters } 'was rolled back'
    Assert-Test ($env:npm_config_offline -eq 'false' -and $env:npm_config_ignore_scripts -eq 'false') 'npm configuration was not restored after failure.'
    Assert-Test ([IO.File]::ReadAllText($manifestPath) -eq $manifestBeforeFailure) 'Failed upgrade did not restore the exact manifest bytes.'
    Assert-Test ([IO.File]::ReadAllText((Join-Path $profilePath 'pnpm-lock.yaml')) -eq $lockBeforeFailure) 'Failed upgrade did not restore lock bytes.'
    Assert-Test ((Read-MwsJson (Join-Path $installed.NodeLink 'package.json')).version -eq '1.0.0') 'Failed upgrade did not restore the previous plugin/link.'
    Write-Host '[PASS] failed upgrade rollback restores prior plugin, link and metadata'

    $env:MWS_TEST_FAIL_MODE = 'unrelated'
    Assert-Throws { Invoke-MwsDeployment -Mode Install @parameters } 'unrelated profile setting changed'
    Assert-Test ([IO.File]::ReadAllText($manifestPath) -eq $manifestBeforeFailure) 'Unrelated mutation rollback was not exact.'
    Assert-Test ((Read-MwsJson (Join-Path $installed.NodeLink 'package.json')).version -eq '1.0.0') 'Unrelated mutation did not restore plugin.'
    Write-Host '[PASS] unrelated profile mutation is refused and rolled back'

    $env:MWS_TEST_FAIL_MODE = $null
    $upgraded = Invoke-MwsDeployment -Mode Install @parameters
    Assert-Test ((Read-MwsJson (Join-Path $upgraded.NodeLink 'package.json')).version -eq '1.0.1') 'Upgrade did not install the new release.'
    Assert-Test (@((Read-MwsJson $manifestPath).dsh.profile.bundles | Where-Object { $_ -eq 'dsh-multi-workspace' }).Count -eq 1) 'Upgrade duplicated the bundle.'
    Write-Host '[PASS] upgrade is idempotent and keeps one bundle'

    $env:MWS_TEST_FAIL_MODE = 'reorder'
    $reordered = Invoke-MwsDeployment -Mode Install @parameters
    Assert-Test ((Read-MwsJson $manifestPath).customSetting.nested.alpha -eq 1) 'Nested values changed during key-order-only rewrite.'
    Assert-Test ((Read-MwsJson (Join-Path $reordered.NodeLink 'package.json')).version -eq '1.0.1') 'Key-order-only rewrite was incorrectly refused.'
    Write-Host '[PASS] root and nested object key reorder is accepted'

    $arrayBeforeFailure = [IO.File]::ReadAllText($manifestPath)
    $env:MWS_TEST_FAIL_MODE = 'arrayorder'
    Assert-Throws { Invoke-MwsDeployment -Mode Install @parameters } 'unrelated profile setting changed'
    Assert-Test ([IO.File]::ReadAllText($manifestPath) -eq $arrayBeforeFailure) 'Array-order mutation was not rolled back.'
    Write-Host '[PASS] array order remains significant and is protected'
    $env:MWS_TEST_FAIL_MODE = $null

    $later = Read-MwsJson $manifestPath
    $later.dependencies | Add-Member -NotePropertyName 'later-plugin' -NotePropertyValue 'link:D:/later'
    $later.dsh.profile.bundles = @($later.dsh.profile.bundles) + 'later-plugin'
    Write-MwsUtf8 $manifestPath ($later | ConvertTo-Json -Depth 50)
    $removed = Invoke-MwsDeployment -Mode Uninstall @parameters
    $remaining = Read-MwsJson $manifestPath
    Assert-Test ($remaining.dependencies.'later-plugin' -eq 'link:D:/later') 'Uninstall erased a later plugin.'
    Assert-Test (@($remaining.dsh.profile.bundles) -contains 'later-plugin') 'Uninstall erased a later bundle.'
    Assert-Test (@($remaining.dsh.profile.bundles) -notcontains 'dsh-multi-workspace') 'Uninstall left the multi-workspace bundle.'
    Assert-Test (-not (Test-Path -LiteralPath $removed.InstallDir)) 'Uninstall left the active stable directory.'
    Write-Host '[PASS] uninstall preserves settings added after installation'

    Assert-Throws { Invoke-MwsDeployment -Mode Install -DshPath $fakeCli -DshHome $fixtureHome -Profile '..\escape' -PluginSource $source } 'profile name'
    Assert-Throws { Remove-MwsOwnedDirectory $fixtureHome $source } 'outside the expected directory'
    Write-Host '[PASS] path traversal and cross-root deletion are refused'

    function Get-MwsDshProcesses { return @([pscustomobject]@{ Id = 12345 }) }
    $beforeRunning = [IO.File]::ReadAllText($manifestPath)
    Assert-Throws { Invoke-MwsDeployment -Mode Install @parameters } 'DSH Desktop is running'
    Assert-Test ([IO.File]::ReadAllText($manifestPath) -eq $beforeRunning) 'Running-app refusal changed metadata.'
    Write-Host '[PASS] running desktop refusal is non-mutating'
    $success = $true
    Write-Host 'Portable installer: 10 meaningful fixture checks passed. No real DSH profile was changed.'
} finally {
    $env:MWS_TEST_FAIL_MODE = $savedTestFail
    $env:DSH_HOME = $savedDshHome
    $env:npm_config_offline = $savedOffline
    $env:npm_config_ignore_scripts = $savedIgnoreScripts
    if ($success) { Remove-MwsOwnedDirectory $testRoot (Join-Path $PSScriptRoot 'test-work') }
    else { Write-Host ('Fixture retained for diagnosis: ' + $fixture) }
}
