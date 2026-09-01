[CmdletBinding()]
param(
  [string]$ArkBaseUrl = "https://ark.cn-beijing.volces.com/api/v3",
  [string]$HostAddress = "127.0.0.1",
  [ValidateRange(1, 65535)]
  [int]$Port = 3000,
  [switch]$SkipBuild,
  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-CommandPath {
  param([Parameter(Mandatory = $true)][string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { return $null }
  return $command.Source
}

function Resolve-GitExecutable {
  if ($env:GIT_BIN -and (Test-Path -LiteralPath $env:GIT_BIN -PathType Leaf)) {
    return [IO.Path]::GetFullPath($env:GIT_BIN)
  }
  $resolved = Resolve-CommandPath "git.exe"
  if (-not $resolved) { $resolved = Resolve-CommandPath "git" }
  if (-not $resolved) {
    $candidates = @()
    if ($env:LOCALAPPDATA) {
      $localPrograms = Join-Path $env:LOCALAPPDATA "Programs"
      $candidates += Join-Path $localPrograms "Git\cmd\git.exe"
      if (Test-Path -LiteralPath $localPrograms -PathType Container) {
        $candidates += Get-ChildItem -LiteralPath $localPrograms -Directory -Filter "MinGit-*" |
          Sort-Object LastWriteTime -Descending |
          ForEach-Object { Join-Path $_.FullName "cmd\git.exe" }
      }
    }
    if ($env:ProgramFiles) {
      $candidates += Join-Path $env:ProgramFiles "Git\cmd\git.exe"
    }
    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    if ($programFilesX86) {
      $candidates += Join-Path $programFilesX86 "Git\cmd\git.exe"
    }
    $resolved = $candidates |
      Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
      Select-Object -First 1
  }
  if (-not $resolved) {
    throw "Git was not found. Install Git 2.29+ or set GIT_BIN to git.exe."
  }
  return [IO.Path]::GetFullPath($resolved)
}

function Resolve-CodexExecutable {
  if ($env:CODEX_BIN -and (Test-Path -LiteralPath $env:CODEX_BIN -PathType Leaf)) {
    $candidate = [IO.Path]::GetFullPath($env:CODEX_BIN)
    if ([IO.Path]::GetExtension($candidate) -ieq ".exe") { return $candidate }
  }

  $direct = Resolve-CommandPath "codex.exe"
  if ($direct) { return [IO.Path]::GetFullPath($direct) }

  $npmCommand = Resolve-CommandPath "npm.cmd"
  if (-not $npmCommand) { throw "npm.cmd was not found in PATH." }
  $npmRoot = (& $npmCommand root --global).Trim()
  $codexPackage = Join-Path $npmRoot "@openai\codex"
  if (Test-Path -LiteralPath $codexPackage -PathType Container) {
    $native = Get-ChildItem -LiteralPath $codexPackage -Filter "codex.exe" -File -Recurse |
      Select-Object -First 1
    if ($native) { return $native.FullName }
  }

  throw "The native Codex executable was not found. Install Codex CLI with npm first."
}

function Read-SecretEnvironmentValue {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Prompt
  )

  $current = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ($current -and $current.Trim()) { return $current.Trim() }

  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
  if (-not $value -or -not $value.Trim()) { throw "$Name is required." }
  return $value.Trim()
}

function New-UrlSafeToken {
  param([ValidateRange(16, 128)][int]$Bytes = 24)

  $buffer = New-Object byte[] $Bytes
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($buffer)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($buffer).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Assert-GitCapabilities {
  param([Parameter(Mandatory = $true)][string]$GitExecutable)

  $version = (& $GitExecutable --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^git version (\d+)\.(\d+)') {
    throw "Unable to read the Git version from $GitExecutable."
  }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  if ($major -lt 2 -or ($major -eq 2 -and $minor -lt 29)) {
    throw "Git 2.29 or newer is required; found $version."
  }

  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $probeRoot = [IO.Path]::GetFullPath(
    (Join-Path $tempRoot ("launchpad-git-probe-" + [Guid]::NewGuid().ToString("N")))
  )
  if (-not $probeRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to create a Git probe outside the system temp directory."
  }
  try {
    $probeRepository = Join-Path $probeRoot "repository.git"
    New-Item -ItemType Directory -Path $probeRoot | Out-Null
    & $GitExecutable init --bare --object-format=sha256 --quiet $probeRepository
    if ($LASTEXITCODE -ne 0) { throw "Git cannot create a SHA-256 bare repository." }
    $format = (& $GitExecutable "--git-dir=$probeRepository" rev-parse --show-object-format=storage).Trim()
    if ($LASTEXITCODE -ne 0 -or $format -ne "sha256") {
      throw "Git SHA-256 capability probe failed; storage format was '$format'."
    }
  } finally {
    if (Test-Path -LiteralPath $probeRoot) {
      Remove-Item -LiteralPath $probeRoot -Recurse -Force
    }
  }
  return $version
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location $repositoryRoot

$nodeCommand = Resolve-CommandPath "node.exe"
if (-not $nodeCommand) { $nodeCommand = Resolve-CommandPath "node" }
if (-not $nodeCommand) { throw "Node.js 22 or newer was not found." }
$nodeVersion = (& $nodeCommand --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
  throw "Node.js 22 or newer is required; found $nodeVersion."
}

$npmCommand = Resolve-CommandPath "npm.cmd"
if (-not $npmCommand) { throw "npm.cmd was not found in PATH." }
$gitExecutable = Resolve-GitExecutable
$gitVersion = Assert-GitCapabilities $gitExecutable
$codexExecutable = Resolve-CodexExecutable
$codexVersion = (& $codexExecutable --version).Trim()
if ($LASTEXITCODE -ne 0) { throw "Codex CLI failed its version check." }

$env:ARK_API_KEY = Read-SecretEnvironmentValue "ARK_API_KEY" "ARK_API_KEY"
if (-not $env:ARK_MODEL -or -not $env:ARK_MODEL.Trim()) {
  $env:ARK_MODEL = (Read-Host "ARK_MODEL (Endpoint or model ID, for example ep-xxxxxxxx)").Trim()
}
if (-not $env:ARK_MODEL) { throw "ARK_MODEL is required." }
if ($env:ARK_MODEL -match '^(?i:ark|apikey)-') {
  throw "ARK_MODEL looks like an API key. Use an Ark endpoint/model ID, for example ep-xxxxxxxx."
}

$env:ARK_BASE_URL = $ArkBaseUrl.TrimEnd("/")
$env:HOST = $HostAddress
$env:PORT = [string]$Port
$env:NODE_ENV = "production"
$env:RUNTIME_PROVIDER = "local-process"
$env:GIT_BIN = $gitExecutable
$env:CODEX_BIN = $codexExecutable
if (-not $env:APP_DATA_DIR) { $env:APP_DATA_DIR = Join-Path $repositoryRoot ".local\data" }
if (-not $env:AGENT_WORKSPACE_ROOT) {
  $env:AGENT_WORKSPACE_ROOT = Join-Path $repositoryRoot ".local\workspaces"
}
if (-not $env:CODEX_HOME) { $env:CODEX_HOME = Join-Path $repositoryRoot ".local\codex-home" }
if (-not $env:TRACE_VIEWER_TOKEN) { $env:TRACE_VIEWER_TOKEN = New-UrlSafeToken 18 }
if (-not $env:RECOVERY_OPERATOR_TOKEN) { $env:RECOVERY_OPERATOR_TOKEN = New-UrlSafeToken 24 }
if (-not $env:RECOVERY_OPERATOR_ID) { $env:RECOVERY_OPERATOR_ID = "local-windows-operator" }

Write-Host "Node: $nodeVersion"
Write-Host "Git: $gitVersion ($gitExecutable)"
Write-Host "Codex: $codexVersion ($codexExecutable)"
Write-Host "Ark model: $($env:ARK_MODEL)"
Write-Host "Ark base URL: $($env:ARK_BASE_URL)"

if ($ValidateOnly) {
  Write-Host "Windows local configuration is valid."
  exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot "node_modules") -PathType Container)) {
  & $npmCommand ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
}
if (-not $SkipBuild) {
  & $npmCommand run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
}

Write-Host ""
Write-Host "Agent workspace: http://$HostAddress`:$Port"
Write-Host "Developer console: http://$HostAddress`:$Port/developer"
Write-Host "Trace viewer token: $($env:TRACE_VIEWER_TOKEN)"
Write-Host "Recovery operator token: $($env:RECOVERY_OPERATOR_TOKEN)"
Write-Host "Press Ctrl+C to stop the server."
& $npmCommand start
exit $LASTEXITCODE
