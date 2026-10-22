#Requires -Version 5.1
<#
.SYNOPSIS
    Validate a dsh-multi-workspace release directory and/or portable ZIP.

.DESCRIPTION
    Checks the release contract from multi-workspace/DESIGN.md section 5:
      * required files exist in the package directory;
      * package.json name / version / engines.dsh / dsh manifest entries;
      * delivery launchers are ASCII-only and CRLF;
      * SHA256SUMS.txt lists every entry and every hash matches;
      * ZIP entry names use forward slashes, no duplicates and no unexpected entries;
      * lib/client.js parses with node --check (directory and ZIP copy).

    This file is intentionally pure ASCII: Windows PowerShell 5.1 reads a
    BOM-less .ps1 as ANSI, so the Chinese delivery file names below are built
    from Unicode code points instead of being embedded as literals.

.PARAMETER PackageRoot
    Package directory. Defaults to the parent of this script's directory
    (the multi-workspace folder).

.PARAMETER ZipPath
    Optional release ZIP to validate. When omitted, the script looks for
    dsh-multi-workspace-<version>-win-x64.zip next to the package root and
    prints a SKIP line when it is not there yet (packaging may not have run).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File test\package-check.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File test\package-check.ps1 -PackageRoot . -ZipPath ..\dsh-multi-workspace-1.0.0-win-x64.zip
#>
[CmdletBinding()]
param(
    [string]$PackageRoot,
    [string]$ZipPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$script:Utf8Strict = New-Object Text.UTF8Encoding($false, $true)
$script:PassCount = 0
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:ExpectedVersion = $null

function Write-Pass([string]$Message) {
    $script:PassCount += 1
    Write-Host ('  PASS  ' + $Message)
}

function Write-Fail([string]$Message) {
    $script:Failures.Add($Message) | Out-Null
    Write-Host ('  FAIL  ' + $Message) -ForegroundColor Red
}

function Test-Check([bool]$Condition, [string]$Message) {
    if ($Condition) { Write-Pass $Message } else { Write-Fail $Message }
}

# Pure-ASCII source: build the Chinese delivery names from code points.
function New-UnicodeString([int[]]$CodePoints) {
    $builder = New-Object System.Text.StringBuilder
    foreach ($codePoint in $CodePoints) { $null = $builder.Append([char]$codePoint) }
    return $builder.ToString()
}

$script:InstructionsTxt = (New-UnicodeString @(0x4F7F, 0x7528, 0x8BF4, 0x660E)) + '.txt' # instructions
$script:InstallCmd = (New-UnicodeString @(0x5B89, 0x88C5)) + '.cmd'                         # install
$script:UninstallCmd = (New-UnicodeString @(0x5378, 0x8F7D)) + '.cmd'                       # uninstall
$script:CheckCmd = (New-UnicodeString @(0x68C0, 0x67E5, 0x73AF, 0x5883)) + '.cmd'           # check environment

function Resolve-NodeExe {
    $candidate = 'C:\Program Files\nodejs\node.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    return $null
}
$script:NodeExe = Resolve-NodeExe

function Read-Utf8Text([string]$Path) {
    return [IO.File]::ReadAllText($Path, $script:Utf8Strict)
}

function Read-Manifest([string]$Path) {
    return (Read-Utf8Text $Path) | ConvertFrom-Json
}

function Test-NodeSyntax([string]$Path, [string]$Label) {
    if ($null -eq $script:NodeExe) {
        Write-Fail ($Label + ': node executable not found; node --check cannot run')
        return
    }
    $output = & $script:NodeExe --check $Path 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        Write-Pass ($Label + ': node --check parses the file')
    } else {
        Write-Fail ($Label + ': node --check failed (exit ' + $exitCode + '): ' + (($output | Out-String).Trim()))
    }
}

function Assert-Manifest($Manifest, [string]$Label) {
    if ($null -eq $Manifest) { Write-Fail ($Label + ': manifest could not be parsed'); return }
    Test-Check ($Manifest.name -eq 'dsh-multi-workspace') ($Label + ': name is dsh-multi-workspace (actual: ' + $Manifest.name + ')')
    Test-Check ([string]$Manifest.version -match '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') ($Label + ': version is valid for a portable release filename (actual: ' + $Manifest.version + ')')
    if (-not [string]::IsNullOrWhiteSpace($script:ExpectedVersion)) {
        Test-Check ($Manifest.version -eq $script:ExpectedVersion) ($Label + ': version matches source package.json ' + $script:ExpectedVersion + ' (actual: ' + $Manifest.version + ')')
    }
    Test-Check ($Manifest.type -eq 'module') ($Label + ': type is module (actual: ' + $Manifest.type + ')')

    $dshEngine = $null
    if ($null -ne $Manifest.engines) { $dshEngine = $Manifest.engines.dsh }
    Test-Check ($dshEngine -eq '0.2.1-rc.2') ($Label + ': engines.dsh is 0.2.1-rc.2 (actual: ' + $dshEngine + ')')

    $bundlePatch = $null
    $clientPlatform = $null
    if ($null -ne $Manifest.dsh) {
        if ($null -ne $Manifest.dsh.bundle) { $bundlePatch = $Manifest.dsh.bundle.patch }
        if ($null -ne $Manifest.dsh.client) { $clientPlatform = $Manifest.dsh.client.platform }
    }
    Test-Check ($bundlePatch -eq './cordis.patch.yml') ($Label + ': dsh.bundle.patch is ./cordis.patch.yml (actual: ' + $bundlePatch + ')')
    Test-Check ($clientPlatform -eq 'web') ($Label + ': dsh.client.platform is web (actual: ' + $clientPlatform + ')')
}

function Test-LauncherBytes([byte[]]$Bytes, [string]$Label) {
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { Write-Fail ($Label + ': launcher is empty'); return }
    $nonAscii = @($Bytes | Where-Object { $_ -gt 127 }).Count
    Test-Check ($nonAscii -eq 0) ($Label + ': ASCII-only bytes')
    $text = [Text.Encoding]::ASCII.GetString($Bytes)
    Test-Check (-not $text.Replace("`r`n", '').Contains("`n")) ($Label + ': CRLF line endings')
    Test-Check ($text.Contains('portable.ps1')) ($Label + ': invokes tools\portable.ps1')
}

function Test-LauncherFile([string]$Path, [string]$Label) {
    Test-LauncherBytes ([IO.File]::ReadAllBytes($Path)) $Label
}

function Get-ZipEntryBytes($Archive, [string]$Name) {
    $entry = $Archive.GetEntry($Name)
    if ($null -eq $entry) { return $null }
    $stream = $entry.Open()
    $memory = New-Object IO.MemoryStream
    try {
        $stream.CopyTo($memory)
        $bytes = $memory.ToArray()
        return ,$bytes
    } finally {
        $stream.Dispose()
        $memory.Dispose()
    }
}

function Read-ZipEntryText($Archive, [string]$Name) {
    $entry = $Archive.GetEntry($Name)
    if ($null -eq $entry) { return $null }
    $stream = $entry.Open()
    $reader = New-Object IO.StreamReader($stream, $script:Utf8Strict)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose(); $stream.Dispose() }
}

function Get-ZipEntryHash($Archive, [string]$Name) {
    $entry = $Archive.GetEntry($Name)
    if ($null -eq $entry) { return $null }
    $stream = $entry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

function Test-PackageDirectory([string]$Root) {
    Write-Host ('[directory] ' + $Root)
    $requiredRelative = @(
        'package.json',
        'cordis.patch.yml',
        'lib\index.js',
        'lib\client.js',
        'icon.svg',
        'README.md',
        'LICENSE',
        'locale\en.json',
        'locale\zh.json',
        'tools\portable.ps1',
        'tools\package.ps1',
        ('delivery\' + $script:InstructionsTxt),
        ('delivery\' + $script:InstallCmd),
        ('delivery\' + $script:UninstallCmd),
        ('delivery\' + $script:CheckCmd)
    )
    foreach ($relative in $requiredRelative) {
        Test-Check (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf) ('directory: required file exists: ' + $relative)
    }

    $manifestPath = Join-Path $Root 'package.json'
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        try { Assert-Manifest (Read-Manifest $manifestPath) 'directory package.json' }
        catch { Write-Fail ('directory package.json: unreadable/invalid JSON: ' + $_.Exception.Message) }
    }

    $patchPath = Join-Path $Root 'cordis.patch.yml'
    if (Test-Path -LiteralPath $patchPath -PathType Leaf) {
        try {
            $patchText = Read-Utf8Text $patchPath
            Test-Check ($patchText.Trim().Length -gt 0) 'directory cordis.patch.yml: non-empty'
            Test-Check ($patchText.Contains('insert')) 'directory cordis.patch.yml: declares an insert row'
            Test-Check ($patchText.Contains('dsh-multi-workspace')) 'directory cordis.patch.yml: names dsh-multi-workspace'
        } catch { Write-Fail ('directory cordis.patch.yml: unreadable UTF-8: ' + $_.Exception.Message) }
    }

    foreach ($localeName in @('en', 'zh')) {
        $localePath = Join-Path $Root ('locale\' + $localeName + '.json')
        if (Test-Path -LiteralPath $localePath -PathType Leaf) {
            try {
                $locale = Read-Manifest $localePath
                $hasMeta = $null -ne $locale.meta
                Test-Check $hasMeta ('directory locale/' + $localeName + '.json: has meta metadata')
                if ($hasMeta) {
                    Test-Check ($locale.meta.title -is [string] -and $locale.meta.title.Length -gt 0) ('directory locale/' + $localeName + '.json: meta.title is non-empty')
                }
            } catch { Write-Fail ('directory locale/' + $localeName + '.json: unreadable/invalid JSON: ' + $_.Exception.Message) }
        }
    }

    foreach ($launcher in @($script:InstallCmd, $script:UninstallCmd, $script:CheckCmd)) {
        $launcherPath = Join-Path $Root ('delivery\' + $launcher)
        if (Test-Path -LiteralPath $launcherPath -PathType Leaf) { Test-LauncherFile $launcherPath ('directory delivery/' + $launcher) }
    }

    $instructionsPath = Join-Path $Root ('delivery\' + $script:InstructionsTxt)
    if (Test-Path -LiteralPath $instructionsPath -PathType Leaf) {
        try {
            $instructions = Read-Utf8Text $instructionsPath
            Test-Check ($instructions.Length -gt 500) 'directory instructions: substantial content (> 500 chars)'
            Test-Check ($instructions.Contains('dsh-multi-workspace')) 'directory instructions: names dsh-multi-workspace'
        } catch { Write-Fail ('directory instructions: not valid UTF-8: ' + $_.Exception.Message) }
    }

    $iconPath = Join-Path $Root 'icon.svg'
    if (Test-Path -LiteralPath $iconPath -PathType Leaf) {
        $iconText = Read-Utf8Text $iconPath
        Test-Check ($iconText.Contains('<svg')) 'directory icon.svg: contains an <svg> root'
    }

    $clientPath = Join-Path $Root 'lib\client.js'
    if (Test-Path -LiteralPath $clientPath -PathType Leaf) {
        $clientText = Read-Utf8Text $clientPath
        Test-Check ($clientText.Contains('window.__ModuleLoader__.load')) 'directory lib/client.js: uses window.__ModuleLoader__.load'
        Test-Check ($clientText.Contains('dsh-multi-workspace')) 'directory lib/client.js: declares the plugin id'
        Test-NodeSyntax $clientPath 'directory lib/client.js'
    }
}

function Test-PackageZip([string]$Path) {
    Write-Host ('[zip] ' + $Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Write-Fail ('zip: file not found: ' + $Path); return }

    $sidecarPath = $Path + '.sha256.txt'
    Test-Check (Test-Path -LiteralPath $sidecarPath -PathType Leaf) 'zip: adjacent .sha256.txt exists'
    if (Test-Path -LiteralPath $sidecarPath -PathType Leaf) {
        $sidecarText = (Read-Utf8Text $sidecarPath).Trim()
        $actualHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        Test-Check ($sidecarText.StartsWith($actualHash)) 'zip: adjacent .sha256.txt hash matches the archive'
        Test-Check ($sidecarText.Contains([IO.Path]::GetFileName($Path))) 'zip: adjacent .sha256.txt names the archive'
    }

    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entries = @($archive.Entries)
        $names = @($entries | ForEach-Object { $_.FullName })

        Test-Check (@($names | Where-Object { $_.Contains('\') }).Count -eq 0) 'zip: entry names use forward slashes only'
        $duplicateGroups = @($names | Group-Object | Where-Object { $_.Count -gt 1 })
        $duplicateNames = @($duplicateGroups | ForEach-Object { $_.Name })
        Test-Check ($duplicateGroups.Count -eq 0) ('zip: no duplicate entries: ' + ($duplicateNames -join ', '))

        $requiredEntries = @(
            $script:InstructionsTxt,
            $script:InstallCmd,
            $script:UninstallCmd,
            $script:CheckCmd,
            'tools/portable.ps1',
            'SHA256SUMS.txt',
            'plugin/package.json',
            'plugin/cordis.patch.yml',
            'plugin/lib/index.js',
            'plugin/lib/client.js',
            'plugin/icon.svg',
            'plugin/README.md',
            'plugin/LICENSE',
            'plugin/locale/en.json',
            'plugin/locale/zh.json'
        )
        foreach ($required in $requiredEntries) {
            Test-Check ($names -contains $required) ('zip: required entry present: ' + $required)
        }

        # No unexpected entries: only the documented portable layout is allowed.
        $allowedRoot = @('SHA256SUMS.txt', $script:InstructionsTxt, $script:InstallCmd, $script:UninstallCmd, $script:CheckCmd, 'tools/portable.ps1')
        $allowedPluginRoot = @('package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE')
        foreach ($name in $names) {
            $allowed = $allowedRoot -contains $name
            if (-not $allowed -and $name.StartsWith('plugin/')) {
                $relative = $name.Substring('plugin/'.Length)
                if ($allowedPluginRoot -contains $relative) { $allowed = $true }
                elseif ($relative.StartsWith('lib/') -or $relative.StartsWith('locale/')) { $allowed = $true }
            }
            Test-Check $allowed ('zip: entry belongs to the portable layout: ' + $name)
        }

        # Manifest inside the ZIP.
        $manifestText = Read-ZipEntryText $archive 'plugin/package.json'
        if ($null -ne $manifestText) {
            try { Assert-Manifest ($manifestText | ConvertFrom-Json) 'zip plugin/package.json' }
            catch { Write-Fail ('zip plugin/package.json: unreadable/invalid JSON: ' + $_.Exception.Message) }
        }

        # Launchers: ASCII + CRLF, read from the archive.
        foreach ($launcher in @($script:InstallCmd, $script:UninstallCmd, $script:CheckCmd)) {
            $bytes = Get-ZipEntryBytes $archive $launcher
            if ($null -ne $bytes) { Test-LauncherBytes ([byte[]]$bytes) ('zip ' + $launcher) }
        }

        # Instructions: valid UTF-8, names the plugin.
        $instructionsText = $null
        try { $instructionsText = Read-ZipEntryText $archive $script:InstructionsTxt }
        catch { Write-Fail ('zip instructions: not valid UTF-8: ' + $_.Exception.Message) }
        if ($null -ne $instructionsText) {
            Test-Check ($instructionsText.Length -gt 500) 'zip instructions: substantial content (> 500 chars)'
            Test-Check ($instructionsText.Contains('dsh-multi-workspace')) 'zip instructions: names dsh-multi-workspace'
        }

        # lib/client.js must be syntactically valid JavaScript.
        $clientBytes = Get-ZipEntryBytes $archive 'plugin/lib/client.js'
        if ($null -ne $clientBytes) {
            $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('mw-package-check-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
            try {
                $tempClient = Join-Path $tempRoot 'client.js'
                [IO.File]::WriteAllBytes($tempClient, [byte[]]$clientBytes)
                Test-NodeSyntax $tempClient 'zip plugin/lib/client.js (extracted)'
            } finally {
                Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        # SHA256SUMS.txt must list every entry (except itself) with a matching hash.
        $sumsText = $null
        try { $sumsText = Read-ZipEntryText $archive 'SHA256SUMS.txt' }
        catch { Write-Fail ('zip SHA256SUMS.txt: not valid UTF-8: ' + $_.Exception.Message) }
        if ($null -ne $sumsText) {
            Test-Check ($sumsText.Trim().Length -gt 0) 'zip SHA256SUMS.txt: non-empty'
            $sumMap = @{}
            foreach ($line in @($sumsText -split "`n")) {
                $trimmed = $line.Trim()
                if ($trimmed.Length -eq 0) { continue }
                if ($trimmed.Length -le 66) { Write-Fail ('zip SHA256SUMS.txt: malformed line: ' + $trimmed); continue }
                $hash = $trimmed.Substring(0, 64)
                $name = $trimmed.Substring(66).Trim()
                if ($name.StartsWith('*')) { $name = $name.Substring(1) }
                if ($hash -notmatch '^[0-9a-f]{64}$') { Write-Fail ('zip SHA256SUMS.txt: not a lowercase SHA256: ' + $name); continue }
                $sumMap[$name] = $hash
            }
            foreach ($name in $names) {
                if ($name -eq 'SHA256SUMS.txt') { continue }
                Test-Check ($sumMap.ContainsKey($name)) ('zip SHA256SUMS.txt: lists ' + $name)
                if ($sumMap.ContainsKey($name)) {
                    $actual = Get-ZipEntryHash $archive $name
                    Test-Check ($actual -eq $sumMap[$name]) ('zip SHA256SUMS.txt: hash matches ' + $name)
                }
            }
            Test-Check (-not $sumMap.ContainsKey('SHA256SUMS.txt')) 'zip SHA256SUMS.txt: does not list itself'
            foreach ($extra in @($sumMap.Keys)) {
                if ($names -notcontains $extra) { Write-Fail ('zip SHA256SUMS.txt: names a missing entry: ' + $extra) }
            }
        }
    } finally {
        $archive.Dispose()
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

try {
    if ([string]::IsNullOrWhiteSpace($PackageRoot)) { $PackageRoot = Join-Path $PSScriptRoot '..' }
    if (-not (Test-Path -LiteralPath $PackageRoot -PathType Container)) {
        Write-Fail ('package root does not exist: ' + $PackageRoot)
    } else {
        $PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
        try {
            $sourceManifest = Read-Manifest (Join-Path $PackageRoot 'package.json')
            $script:ExpectedVersion = [string]$sourceManifest.version
        } catch {
            # Test-PackageDirectory reports an unreadable source manifest.
        }
        Test-PackageDirectory $PackageRoot

        $zipToCheck = $ZipPath
        $zipExplicit = -not [string]::IsNullOrWhiteSpace($ZipPath)
        if (-not $zipExplicit -and -not [string]::IsNullOrWhiteSpace($script:ExpectedVersion)) {
            $versionForZip = $script:ExpectedVersion
            $candidate = Join-Path (Split-Path -Parent $PackageRoot) ('dsh-multi-workspace-' + $versionForZip + '-win-x64.zip')
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                Write-Host ('[zip] auto-detected ' + $candidate)
                $zipToCheck = $candidate
            } else {
                Write-Host ('[zip] SKIP: no release zip next to the package root yet (' + $candidate + '); pass -ZipPath after packaging')
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($zipToCheck)) {
            Test-PackageZip ([IO.Path]::GetFullPath($zipToCheck))
        }
    }
} catch {
    Write-Fail ('unexpected error: ' + $_.Exception.Message)
}

Write-Host ''
if ($script:Failures.Count -gt 0) {
    Write-Host ('PACKAGE CHECK FAILED: ' + $script:PassCount + ' passed, ' + $script:Failures.Count + ' failed')
    foreach ($failure in $script:Failures) { Write-Host ('  - ' + $failure) }
    exit 1
}
Write-Host ('PACKAGE CHECK PASSED: ' + $script:PassCount + ' checks')
exit 0
