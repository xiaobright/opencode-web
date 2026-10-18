#Requires -Version 5.1
#
# opencode-web tray icon.
#
# One resident icon: it shows the running service when there is one, and stays as the
# entry point when the service is away (auto-sleep stops it after the web UI has been idle),
# so a click opens the gateway and the next page open starts the service again. It can also
# start/stop the local web UI and the service on demand.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tray\tray.ps1 [-Port 53123] [-NoBrowser] [-NoService]
#
# -NoBrowser  do not open the browser on start (used when spawned by the opencode hook)
# -NoService  do not start the opencode service, only follow one that is already running
# -Lazy       keep the tray and gateway resident; no browser or backend until page open

param(
  [int]$Port = 0,
  [switch]$NoBrowser,
  [switch]$NoService,
  [switch]$Lazy
)

$Root = Split-Path -Parent $PSScriptRoot
# Next to the pid file rather than in TEMP: the icon is often started from a hidden process, and a log
# nobody can find is worse than no log.
$LogFile = Join-Path $Root ".tray.log"

function Write-Log([string]$Message) {
  try { Add-Content -Path $LogFile -Value ("{0} {1}" -f (Get-Date -Format "HH:mm:ss"), $Message) } catch { }
}

Write-Log "starting (pid $PID, powershell $($PSVersionTable.PSVersion), root $Root)"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

if ($Port -le 0) {
  $Port = if ($env:OPENCODE_WEB_PORT) { [int]$env:OPENCODE_WEB_PORT } else { 53123 }
}
$WebUrl = "http://127.0.0.1:$Port/"
$PidFile = Join-Path $Root ".tray.pid"
$CliPath =
  if ($env:OPENCODE_BIN) { $env:OPENCODE_BIN }
  else { Join-Path $env:APPDATA "npm\node_modules\@opencode\cli\bin\opencode.exe" }

$state = @{
  Icon = $null
  Web = $null
  Failures = 0
  StopService = $false
  KeepWeb = $false
}

# Only one icon at a time; a second launch (another location activating, or a double click on start.vbs)
# just leaves. An abandoned mutex means the previous icon was killed, which counts as free.
$mutex = New-Object System.Threading.Mutex($false, "Global\opencode-web-tray")
$owner = $false
try { $owner = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owner = $true }
if (-not $owner) {
  Write-Log "another icon is already running; leaving"
  exit 0
}

Set-Content -Path $PidFile -Value $PID -Encoding ascii

function Get-Authorization([object]$Info) {
  $bytes = [Text.Encoding]::UTF8.GetBytes("opencode:" + $Info.password)
  return "Basic " + [Convert]::ToBase64String($bytes)
}

function Test-Service([object]$Info) {
  try {
    $info = Invoke-RestMethod -Uri "$($Info.url)/api/info" -Headers @{ Authorization = Get-Authorization $Info } -TimeoutSec 3
    if ($info.version) { return $info }
  } catch { }
  return $null
}

function Find-Service {
  $directory =
    if ($env:XDG_STATE_HOME) { Join-Path $env:XDG_STATE_HOME "opencode" }
    else { Join-Path $env:USERPROFILE ".local\state\opencode" }
  if (-not (Test-Path $directory)) { return $null }

  $files = Get-ChildItem -Path $directory -Filter "service*.json" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending

  foreach ($file in $files) {
    $info = $null
    try { $info = Get-Content $file.FullName -Raw | ConvertFrom-Json } catch { continue }
    if (-not $info.url -or -not $info.password) { continue }
    $health = Test-Service $info
    if ($health) { return @{ Info = $info; Health = $health } }
  }
  return $null
}

function Invoke-Cli([string[]]$Arguments) {
  if (-not (Test-Path $CliPath)) { return }
  $process = Start-Process -FilePath $CliPath -ArgumentList $Arguments -PassThru -WindowStyle Hidden
  $process | Wait-Process -Timeout 90 -ErrorAction SilentlyContinue
}

function Test-Web {
  try {
    $info = Invoke-RestMethod -Uri "${WebUrl}__opencode-web" -TimeoutSec 2
    if ($info.ok) { return $true }
  } catch { }
  return $false
}

function Resolve-Bun {
  $command = Get-Command bun -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidate = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
  if (Test-Path $candidate) { return $candidate }
  return $null
}

# Started hidden and owned by this icon: it is killed again on exit, but a web server started by hand is
# left alone.
function Start-Web {
  if (Test-Web) { return }
  $bun = Resolve-Bun
  if (-not $bun) { Write-Log "bun not found; leaving the web UI alone"; return }

  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $bun
  $info.Arguments = "run `"$Root\src\start.mjs`" --no-open --port $Port"
  if ($Lazy -or $NoService) { $info.Arguments += " --lazy" }
  $info.WorkingDirectory = $Root
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $state.Web = [System.Diagnostics.Process]::Start($info)
  Write-Log "started the web UI (pid $($state.Web.Id))"
  # Wait for the gateway listener only; the backend is never needed here.
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if (Test-Web) { return }
    if ($state.Web.HasExited) { Write-Log "the web UI exited before listening"; return }
    Start-Sleep -Milliseconds 100
  }
}

function Stop-Web {
  if ($state.Web -and -not $state.Web.HasExited) {
    Stop-Process -Id $state.Web.Id -Force -ErrorAction SilentlyContinue
    Write-Log "stopped the web UI (pid $($state.Web.Id))"
  }
  $state.Web = $null
}

function Open-Web {
  Start-Web
  Start-Process $WebUrl
}

function Restart-Service {
  Invoke-Cli @("service", "restart")
  $state.Failures = 0
}

function New-TrayIcon {
  # The opencode app icon (dark rounded square with the white frame glyph), the same artwork the desktop
  # app and the browser tab use. Not ExtractAssociatedIcon($CliPath): the CLI binary carries the Bun
  # mascot, which says nothing about opencode.
  $file = Join-Path $Root "icons\opencode.ico"
  # Ask for the system small icon size so the frame matches the tray at the current DPI instead of being
  # scaled down from 32x32.
  $size = [System.Windows.Forms.SystemInformation]::SmallIconSize
  if (Test-Path $file) {
    try { return New-Object System.Drawing.Icon($file, $size) } catch { }
    try { return New-Object System.Drawing.Icon($file) } catch { }
  }
  return [System.Drawing.SystemIcons]::Application
}

function Close-Tray([bool]$StopService, [bool]$KeepWeb = $false) {
  $state.StopService = $StopService
  $state.KeepWeb = $KeepWeb
  [System.Windows.Forms.Application]::ExitThread()
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = New-TrayIcon
$icon.Text = "OpenCode"
$icon.Visible = $false

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add("打开 WebUI").add_Click({ Open-Web })
$menu.Items.Add("重启后台服务").add_Click({ Restart-Service })
$menu.Items.Add("-") | Out-Null
$menu.Items.Add("仅关闭图标（服务和 Web 继续运行）").add_Click({ Close-Tray $false $true })
$menu.Items.Add("退出（同时停止 Web 和后台服务）").add_Click({ Close-Tray $true })
$icon.ContextMenuStrip = $menu
$icon.add_MouseClick({
    param($sender, $event)
    if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Web }
  })

function Update-Tray {
  if ($Lazy) {
    # The gateway is the resident process in standby mode, so a stopped backend
    # must not remove its entry point. Read gateway metadata, without a probe
    # that starts or connects to the backend.
    try {
      $gateway = Invoke-RestMethod -Uri "${WebUrl}__opencode-web" -TimeoutSec 2
      $icon.Text = switch ($gateway.backend) {
        "starting" { "OpenCode · 正在启动" }
        "ready" { "OpenCode · 点击打开网页" }
        "error" { "OpenCode · 启动失败，点击重试" }
        default { "OpenCode · 待用，点击启动" }
      }
    } catch {
      $icon.Text = "OpenCode · 待用，点击打开"
    }
    $icon.Visible = $true
    return
  }
  $found = Find-Service
  if ($found) {
    if ($state.Failures -gt 2) { Write-Log "the service is back at $($found.Info.url)" }
    $state.Failures = 0
    $icon.Text = "OpenCode $($found.Health.version) · $($found.Info.url)"
    if (-not $icon.Visible) { $icon.Visible = $true }
    return
  }

  $state.Failures++
  # The service being away is a normal state now: auto-sleep stops it once the web UI has
  # been idle, and a click brings it back through the gateway. The icon therefore stays as
  # the entry point instead of exiting with the service.
  if ($state.Failures -eq 2) { Write-Log "no service running; the icon stays as the entry point" }
  $icon.Text = "OpenCode · 待用，点击启动"
  if (-not $icon.Visible) { $icon.Visible = $true }
}

# --- start ------------------------------------------------------------------

Write-Log "starting (port $Port, service-start $(-not $NoService))"

if (-not $Lazy -and -not (Find-Service) -and -not $NoService) {
  Write-Log "no service running; starting one"
  Invoke-Cli @("service", "start")
  for ($attempt = 0; $attempt -lt 30 -and -not (Find-Service); $attempt++) { Start-Sleep -Milliseconds 500 }
}

Update-Tray

if ($Lazy -or $NoBrowser) { Start-Web } else { Open-Web }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ Update-Tray })
$timer.Start()

# Blocks until Close-Tray, then falls through to cleanup.
[System.Windows.Forms.Application]::Run()

# --- cleanup ----------------------------------------------------------------

$timer.Stop()
if ($state.StopService) {
  Invoke-Cli @("service", "stop")
  Write-Log "stopped the opencode service"
}
# "Only close the icon" leaves the web UI running for open tabs; every other exit takes it along.
if (-not $state.KeepWeb) { Stop-Web }
$icon.Visible = $false
$icon.Dispose()
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
$mutex.ReleaseMutex()
$mutex.Dispose()
Write-Log "exited"
