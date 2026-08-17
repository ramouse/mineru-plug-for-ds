<#
MinerU DSH plugin - one-click installer (Windows).

DEFAULT MODE - GLOBAL PLUGIN (no preset):
  Writes one `insert` entry into the user patch layer of the DSH profile
  (DSH_HOME\profiles\*\cordis.patch.yml - the official user extension point,
  applied after every bundle layer, hot-reloaded transactionally by the app).
  The plugin then loads process-wide: every session on every preset gets the
  tools and the panel. Also junctions packages/mineru-plugin into every
  detected package-resolution root.

-PresetMode: legacy per-preset install (creates a user preset from the
  shipped "standard" preset and appends the plugin row).

Usage:
  pwsh -File tools\install.ps1                       # global plugin install
  pwsh -File tools\install.ps1 -InstallDir 'E:\ds harness\deepseek-harness'
  pwsh -File tools\install.ps1 -Uninstall
  pwsh -File tools\install.ps1 -Uninstall -RemovePreset
  pwsh -File tools\install.ps1 -PresetMode           # legacy preset install

NOTE: this script is intentionally ASCII-only so Windows PowerShell 5.1
parses it under any system codepage.
#>
param(
  [switch]$Uninstall,
  [string]$InstallDir = '',
  [switch]$PresetMode,
  [string]$PresetId = 'mineru',
  [string]$PresetName = 'MinerU Plugin',
  [switch]$RemovePreset
)

$ErrorActionPreference = 'Stop'
$RepoDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PkgDir = Join-Path $RepoDir 'packages\mineru-plugin'

$PatchBlock = @"
# MinerU document parsing plugin (installed by tools\install.ps1)
- insert:
    - id: mineru-plugin
      name: mineru-plugin
      config:
        projectDir: $RepoDir
"@

$RowBlock = @"

# --- MinerU document parsing (installed by tools\install.ps1 -PresetMode) --
- id: mineru-plugin
  name: mineru-plugin
  config:
    projectDir: $RepoDir
"@

function Write-Step([string]$text) { Write-Host "== $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "   [OK] $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "   [WARN] $text" -ForegroundColor Yellow }
function Write-Fail([string]$text) { Write-Host "   [FAIL] $text" -ForegroundColor Red }

function Get-DshHome {
  $d = $env:DSH_HOME
  if (-not $d) { $d = Join-Path $env:USERPROFILE '.dsh' }
  return $d
}

# ------------------------------------------------------------- detect roots
function Find-Roots {
  $roots = New-Object System.Collections.Generic.List[string]
  $dshHome = Get-DshHome
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($InstallDir) {
    $candidates.Add($InstallDir)
    $candidates.Add((Join-Path $InstallDir 'node_modules'))
  }
  $candidates.Add((Join-Path $dshHome 'profiles\node_modules'))
  $candidates.Add((Join-Path $dshHome 'profiles\web\node_modules'))
  $candidates.Add('E:\ds harness\deepseek-harness\node_modules')
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
      if ($p.CommandLine -match '([A-Za-z]:[\\/][^"]*?node_modules)') {
        $candidates.Add((Split-Path $Matches[1] -Parent))
      }
    }
  } catch {}
  foreach ($c in $candidates) {
    if (-not $c) { continue }
    $norm = [System.IO.Path]::GetFullPath($c)
    if ($roots.Contains($norm)) { continue }
    if (Test-Path (Join-Path $norm '@deepseek-ai')) { $roots.Add($norm) }
  }
  return $roots
}

# ---------------------------------------------------- profile patch layers
function Find-PatchFiles {
  $files = New-Object System.Collections.Generic.List[string]
  $dshHome = Get-DshHome
  $profiles = Join-Path $dshHome 'profiles'
  if (Test-Path $profiles) {
    Get-ChildItem $profiles -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Join-Path $_.FullName 'cordis.patch.yml'
      if (Test-Path $p) { $files.Add($p) }
    }
  }
  return $files
}

function Add-PatchEntry([string]$file) {
  $raw = [System.IO.File]::ReadAllText($file)
  if ($raw -match 'mineru-plugin') { return $false }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  if ($raw.Trim() -eq '[]' -or $raw.Trim() -eq '') {
    [System.IO.File]::WriteAllText($file, $PatchBlock.TrimEnd() + [Environment]::NewLine, $utf8)
  } else {
    [System.IO.File]::WriteAllText($file, $raw.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $PatchBlock, $utf8)
  }
  return $true
}

function Remove-PatchEntry([string]$file) {
  if (-not (Test-Path $file)) { return }
  $raw = [System.IO.File]::ReadAllText($file)
  if ($raw -notmatch 'mineru-plugin') { return }
  $block = [regex]::Escape($PatchBlock.Trim())
  $clean = $raw -replace "# MinerU document parsing plugin \(installed by tools\\install\.ps1\)\s*\r?\n", ''
  $clean = $clean -replace '- insert:\s*\r?\n(\s+- id: mineru-plugin\s*\r?\n(\s+name: mineru-plugin\s*\r?\n)?(\s+config:\s*\r?\n(\s+projectDir:[^\r\n]*\s*\r?\n)?)?)+', ''
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  if ($clean.Trim() -eq '') { $clean = '[]' }
  [System.IO.File]::WriteAllText($file, $clean.TrimEnd() + [Environment]::NewLine, $utf8)
}

# ------------------------------------------------------------- junction utils
function Ensure-Junction([string]$link, [string]$target) {
  if (Test-Path $link) {
    $item = Get-Item $link -Force -ErrorAction SilentlyContinue
    if ($item.LinkType -eq 'Junction') { return $false }
    Write-Fail "$link exists but is not a junction; handle it manually"
    exit 1
  }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  return $true
}

function Remove-Junction([string]$link) {
  if (-not (Test-Path $link)) { return }
  $item = Get-Item $link -Force -ErrorAction SilentlyContinue
  if ($item.LinkType -eq 'Junction') {
    Remove-Item -LiteralPath $link -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $link) { Write-Warn ('could not remove ' + $link + '; run: rmdir ' + $link) }
  } else {
    Write-Warn "$link is not a junction; skipping (no real files touched)"
  }
}

# --------------------------------------------------- locate shipped standard
function Find-StandardPreset {
  $paths = New-Object System.Collections.Generic.List[string]
  if ($InstallDir) { $paths.Add((Join-Path $InstallDir 'apps\cli\config\agent-presets\standard')) }
  $paths.Add('E:\ds harness\deepseek-harness\apps\cli\config\agent-presets\standard')
  $dshHome = Get-DshHome
  try {
    $found = Get-ChildItem -Path $dshHome -Recurse -Depth 6 -Filter 'agent.cordis.yml' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'agent-presets[\\/]standard[\\/]' } |
      Select-Object -First 1
    if ($found) { $paths.Add((Split-Path $found.FullName -Parent)) }
  } catch {}
  try {
    $npxCache = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
    if (Test-Path $npxCache) {
      Get-ChildItem $npxCache -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $p = Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\config\agent-presets\standard'
        if (Test-Path $p) { $paths.Add($p) }
      }
    }
  } catch {}
  foreach ($p in $paths) {
    if ($p -and (Test-Path (Join-Path $p 'agent.cordis.yml'))) { return [System.IO.Path]::GetFullPath($p) }
  }
  return $null
}

# ------------------------------------------------------------------- main
if (-not (Test-Path (Join-Path $PkgDir 'package.json'))) {
  Write-Fail "plugin package not found: $PkgDir (run this script from the repo root)"
  exit 1
}

$roots = Find-Roots
$dshHome = Get-DshHome

if ($Uninstall) {
  Write-Step 'uninstalling mineru-plugin'
  $patchFiles = Find-PatchFiles
  foreach ($f in $patchFiles) { Remove-PatchEntry $f; Write-Ok "patch entry removed: $f" }
  if ($roots.Count -eq 0) { Write-Warn 'no DSH resolution root detected (junctions may already be gone)' }
  foreach ($r in $roots) {
    Remove-Junction (Join-Path $r 'mineru-plugin')
    Write-Ok "junction removed: $r\mineru-plugin"
  }
  $presetDir = Join-Path $dshHome ".agent-presets\$PresetId"
  if ($RemovePreset -and (Test-Path $presetDir)) {
    Remove-Item $presetDir -Recurse -Force
    Write-Ok "preset directory removed: $presetDir"
  } elseif (Test-Path $presetDir) {
    Write-Warn "preset directory kept: $presetDir (add -RemovePreset to delete it too)"
  }
  Write-Ok 'uninstall complete'
  exit 0
}

Write-Step 'installing mineru-plugin (global plugin mode)'
if ($roots.Count -eq 0) {
  Write-Fail 'no DSH install detected (no node_modules with @deepseek-ai). Use -InstallDir to point at the install root (e.g. E:\ds harness\deepseek-harness).'
  exit 1
}
Write-Ok "detected $($roots.Count) resolution root(s)"

foreach ($r in $roots) {
  $link = Join-Path $r 'mineru-plugin'
  if (Ensure-Junction $link $PkgDir) { Write-Ok "junction created: $link" }
  else { Write-Ok "junction already present: $link" }
  $check = "console.log(require.resolve('mineru-plugin/package.json', { paths: ['" + $r.Replace('\', '\\') + "'] }))"
  $resolved = node -e $check 2>&1
  if ($LASTEXITCODE -eq 0) { Write-Ok "package resolves: $resolved" }
  else { Write-Fail "package resolution failed: $resolved" }
}

if ($PresetMode) {
  Write-Step 'legacy preset mode'
  $presetRoot = Join-Path $dshHome '.agent-presets'
  $presetDir = Join-Path $presetRoot $PresetId
  if (-not (Test-Path (Join-Path $presetDir 'agent.cordis.yml'))) {
    $standard = Find-StandardPreset
    if (-not $standard) {
      Write-Fail 'shipped "standard" preset not found; it is the required base. Install DSH first or copy it manually.'
      exit 1
    }
    New-Item -ItemType Directory -Path $presetDir -Force | Out-Null
    Copy-Item (Join-Path $standard '*') $presetDir -Recurse -Force
    Write-Ok "preset created (base: $standard)"
    $meta = "name: $PresetName`ndescription: Full coding agent based on standard, plus the MinerU document parsing plugin.`n"
    Set-Content -Path (Join-Path $presetDir 'preset.yml') -Value $meta -Encoding UTF8 -NoNewline
  } else {
    Write-Ok "preset already exists: $presetDir (only appending the plugin row)"
  }
  $cordisFile = Join-Path $presetDir 'agent.cordis.yml'
  $current = Get-Content $cordisFile -Raw -Encoding UTF8
  if ($current -match 'name:\s*mineru-plugin') { Write-Ok 'plugin row already present, skipped' }
  else {
    Add-Content -Path $cordisFile -Value $RowBlock -Encoding UTF8
    Write-Ok 'plugin row appended (projectDir auto-configured)'
  }
  Write-Host "  1. Restart DSH, open a new session and pick the preset: $PresetName"
} else {
  Write-Step 'writing global patch entry (user patch layer)'
  $patchFiles = Find-PatchFiles
  if ($patchFiles.Count -eq 0) {
    Write-Fail 'no DSH profile found under ' + $dshHome + '\profiles (no cordis.patch.yml). Is DSH installed?'
    exit 1
  }
  foreach ($f in $patchFiles) {
    if (Add-PatchEntry $f) { Write-Ok "patch entry added: $f" }
    else { Write-Ok "patch entry already present: $f" }
  }
  Write-Host '  The app hot-reloads the patch layer transactionally; the plugin'
  Write-Host '  loads process-wide (every session, every preset).'
  Write-Host '  1. New sessions get parse_document / mineru_status / mineru_doctor at once.'
  Write-Host '  2. For the browser panel, restart DSH once (the boot graph is composed at startup), then refresh the page.'
}

Write-Step 'install complete'
Write-Host '  3. Set an API key in the panel to unlock the precision mode (free token: https://mineru.net/apiManage/token)'
Write-Host '  4. Uninstall: pwsh -File tools\install.ps1 -Uninstall'
exit 0
