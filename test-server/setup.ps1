# Test stand for MineBlaze Bot Panel: Paper server + GrimAC anticheat on this PC.
# Downloads (or updates) the server and the anticheat into test-server\server, checks their checksums
# and writes test settings on the first run. Starting the server is done by start-test-server.bat.
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files without BOM in the ANSI code page.
param(
  [string]$McVersion = '1.21.11',
  [switch]$AcceptEula
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads in PowerShell 5.1 very slow
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$root = Join-Path $PSScriptRoot 'server'
$plugins = Join-Path $root 'plugins'
$stateFile = Join-Path $root 'stand.json'
$paperJar = Join-Path $root 'paper.jar'
$grimJar = Join-Path $plugins 'grimac.jar'
$headers = @{ 'User-Agent' = 'mineblaze-bot-panel-teststand/1.0' }
New-Item -ItemType Directory -Force -Path $plugins | Out-Null

function Get-JavaMajor {
  if (-not (Get-Command java -ErrorAction SilentlyContinue)) { return 0 }
  # java -version writes to stderr; cmd merges it so PowerShell 5.1 does not turn it into errors.
  $text = (cmd /c 'java -version 2>&1') -join "`n"
  if ($text -match 'version "(\d+)(?:\.(\d+))?') {
    $major = [int]$Matches[1]
    if ($major -eq 1) { $major = [int]$Matches[2] } # Java 8 and older report "1.8.0_xxx"
    return $major
  }
  return 0
}

function Save-Verified([string]$Url, [string]$Target, [string]$Algorithm, [string]$Expected) {
  $tmp = "$Target.download"
  Invoke-WebRequest -Uri $Url -OutFile $tmp -Headers $headers -UseBasicParsing
  $actual = (Get-FileHash -Path $tmp -Algorithm $Algorithm).Hash
  if ($actual -ne $Expected) { # string -ne ignores case: APIs give lowercase hex, Get-FileHash uppercase
    Remove-Item $tmp -Force
    throw "Checksum mismatch for $Url"
  }
  Move-Item -Path $tmp -Destination $Target -Force
}

function Write-Warn([string]$Text) { Write-Host "[WARN] $Text" -ForegroundColor Yellow }

# Remembers what is installed right after each download, so a later failure does not force a re-download.
function Save-State { $state | ConvertTo-Json | Set-Content -Path $stateFile -Encoding ASCII }

# ---------- Java ----------
$javaMajor = Get-JavaMajor
if ($javaMajor -lt 21) {
  if ($javaMajor -eq 0) { Write-Host '[ERROR] Java not found.' -ForegroundColor Red }
  else { Write-Host "[ERROR] Java $javaMajor is too old: Paper $McVersion needs Java 21 or newer." -ForegroundColor Red }
  Write-Host 'Install Java 21 or newer, for example: winget install EclipseAdoptium.Temurin.21.JRE'
  exit 1
}
Write-Host "Java $javaMajor found."

# ---------- what is installed ----------
$state = @{}
if (Test-Path $stateFile) {
  try {
    (Get-Content $stateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value }
  } catch {
    $state = @{}
  }
}

# ---------- Paper ----------
try {
  $build = Invoke-RestMethod -Uri "https://fill.papermc.io/v3/projects/paper/versions/$McVersion/builds/latest" -Headers $headers
  $paperId = "$McVersion-$($build.id)"
  if ($state.paper -ne $paperId -or -not (Test-Path $paperJar)) {
    $file = $build.downloads.'server:default'
    Write-Host "Downloading Paper $McVersion build $($build.id)..."
    Save-Verified $file.url $paperJar 'SHA256' $file.checksums.sha256
    $state.paper = $paperId
    Save-State
  } else {
    Write-Host "Paper $McVersion build $($build.id): up to date."
  }
} catch {
  if (-not (Test-Path $paperJar)) { throw }
  Write-Warn "Could not check Paper updates ($($_.Exception.Message)), using the installed one."
}

# ---------- GrimAC (newest release for this version; beta or alpha only if there is no release) ----------
try {
  $loaders = [uri]::EscapeDataString('["paper"]')
  $versions = [uri]::EscapeDataString("[`"$McVersion`"]")
  # No @() around the call: PowerShell 5.1 returns a JSON array as one object, and @() would wrap it again.
  $list = Invoke-RestMethod -Uri "https://api.modrinth.com/v2/project/grimac/version?loaders=$loaders&game_versions=$versions" -Headers $headers
  $list = @($list | Sort-Object { [datetime]$_.date_published } -Descending)
  $pick = $null
  foreach ($type in 'release', 'beta', 'alpha') {
    $pick = $list | Where-Object { $_.version_type -eq $type } | Select-Object -First 1
    if ($pick) { break }
  }
  if (-not $pick) { throw "GrimAC has no build for Minecraft $McVersion" }
  if ($state.grim -ne $pick.version_number -or -not (Test-Path $grimJar)) {
    $file = $pick.files | Where-Object { $_.primary } | Select-Object -First 1
    if (-not $file) { $file = $pick.files | Select-Object -First 1 }
    Write-Host "Downloading GrimAC $($pick.version_number) ($($pick.version_type))..."
    Save-Verified $file.url $grimJar 'SHA512' $file.hashes.sha512
    $state.grim = $pick.version_number
    Save-State
  } else {
    Write-Host "GrimAC $($pick.version_number): up to date."
  }
} catch {
  if (-not (Test-Path $grimJar)) { throw }
  Write-Warn "Could not check GrimAC updates ($($_.Exception.Message)), using the installed one."
}

$state.mcVersion = $McVersion
Save-State

# ---------- settings for the first run (later edits in server.properties are kept) ----------
$props = Join-Path $root 'server.properties'
if (-not (Test-Path $props)) {
  @(
    'server-ip=127.0.0.1'
    'server-port=25565'
    'online-mode=false'
    'enforce-secure-profile=false'
    'motd=MineBlaze Bot Panel test stand'
    'level-seed=mineblaze-test'
    'gamemode=survival'
    'difficulty=normal'
    'spawn-protection=0'
    'view-distance=8'
    'simulation-distance=6'
    'max-players=100'
    'allow-flight=false'
  ) | Set-Content -Path $props -Encoding ASCII
  Write-Host 'Test settings written: 127.0.0.1:25565, offline mode (any nickname can join).'
}

# ---------- Minecraft EULA ----------
$eula = Join-Path $root 'eula.txt'
$accepted = (Test-Path $eula) -and ((Get-Content $eula -Raw) -match 'eula\s*=\s*true')
if (-not $accepted) {
  if (-not $AcceptEula) {
    Write-Host ''
    Write-Host 'A Minecraft server can only be started after accepting the Minecraft EULA:'
    Write-Host '  https://aka.ms/MinecraftEULA'
    $answer = Read-Host 'Do you accept it? Type Y and press Enter'
    if ($answer -notmatch '^\s*[Yy]') {
      Write-Host 'EULA not accepted: the test server will not start.'
      exit 1
    }
  }
  'eula=true' | Set-Content -Path $eula -Encoding ASCII
}

Write-Host 'Test stand is ready.'
