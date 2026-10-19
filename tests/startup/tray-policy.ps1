$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$trayPath = Join-Path $PSScriptRoot '..\..\tray\tray.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($trayPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw $parseErrors[0] }
$update = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Update-Tray' }, $true)
$item = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Update-BackgroundItem' }, $true)
if (-not $item) { throw 'Update-BackgroundItem is missing from tray.ps1' }
# Load the actual tray policy without creating an icon or starting services.
. ([scriptblock]::Create($update.Extent.Text))
. ([scriptblock]::Create($item.Extent.Text))
$Lazy = $true
$WebUrl = 'http://fixture/'
$icon = [pscustomobject]@{ Text = ''; Visible = $false }
$bgItem = [pscustomobject]@{ Text = '' }
$state = @{ Failures = 0; BackgroundCache = @{} }
$script:FindCalls = 0
$script:CloseCalls = 0
$script:GatewayPhase = 'idle'
$script:BackgroundCount = 0
function Find-Service { $script:FindCalls++; return $null }
function Close-Tray { $script:CloseCalls++ }
function Write-Log { }
function Invoke-RestMethod { return @{ backend = $script:GatewayPhase } }
function Get-BackgroundCount { return $script:BackgroundCount }
foreach ($phase in @('idle', 'starting', 'ready', 'error')) {
  $script:GatewayPhase = $phase
  1..8 | ForEach-Object { Update-Tray }
  if (-not $icon.Visible) { throw "Standby icon disappeared in $phase" }
}
if ($script:FindCalls -ne 0 -or $script:CloseCalls -ne 0) { throw 'Standby followed or exited with the backend' }
$Lazy = $false
1..8 | ForEach-Object { Update-Tray }
if ($script:FindCalls -lt 8) { throw 'Normal tray no longer probes the service' }
if ($script:CloseCalls -ne 0) { throw 'Normal tray exited with the service; auto-sleep needs it resident' }
if (-not $icon.Visible) { throw 'Normal tray hid itself while the service was merely sleeping' }
if ($icon.Text -notlike '*待用*') { throw "Normal tray lost its entry-point text: $($icon.Text)" }
if ($bgItem.Text -notlike '*无正在运行*') { throw "Background item lost its idle text: $($bgItem.Text)" }

# A live service with delegated work: the menu counts running background sessions.
function Find-Service { return @{ Info = @{ url = 'http://fixture'; password = 'x' }; Health = @{ version = '9.9.9' } } }
$script:BackgroundCount = 2
Update-Tray
if ($icon.Text -notlike '*2 个后台任务*') { throw "Tray tooltip lost the background count: $($icon.Text)" }
if ($bgItem.Text -notlike '*2 个在跑*') { throw "Background menu item lost the count: $($bgItem.Text)" }
$script:BackgroundCount = 0
Update-Tray
if ($bgItem.Text -notlike '*无正在运行*') { throw "Background menu item kept a stale count: $($bgItem.Text)" }
Write-Output 'Tray policy passed: standby stays visible without backend probes; a sleeping service keeps the icon; the menu counts running background sessions.'

# --- background counting: only sessions stamped by the MCP bridge count ---
$countFn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-BackgroundCount' }, $true)
if (-not $countFn) { throw 'Get-BackgroundCount is missing from tray.ps1' }
. ([scriptblock]::Create($countFn.Extent.Text))
$state.BackgroundCache = @{}
$script:ActiveIds = @('ses_bg', 'ses_fg')
$script:SessionMeta = @{
  ses_bg = @{ origin = 'opencode-delegate' }
  ses_fg = @{ origin = $null }
}
function Find-Service { return @{ Info = @{ url = 'http://fixture'; password = 'x' }; Health = @{ version = '9.9.9' } } }
function Get-Authorization { return 'Basic fixture' }
function Invoke-RestMethod {
  param($Uri, $Headers, $TimeoutSec)
  if ($Uri -like '*/api/session/active') {
    $data = [pscustomobject]@{}
    foreach ($id in $script:ActiveIds) { $data | Add-Member -NotePropertyName $id -NotePropertyValue @{ type = 'running' } }
    return [pscustomobject]@{ data = $data }
  }
  $id = ($Uri -split '/')[-1]
  return [pscustomobject]@{ data = [pscustomobject]@{ metadata = [pscustomobject]$script:SessionMeta[$id] } }
}
if ((Get-BackgroundCount) -ne 1) { throw 'background count should be 1 (only the stamped session)' }
$script:ActiveIds = @('ses_fg')
if ((Get-BackgroundCount) -ne 0) { throw 'foreground-only active set should count 0' }
Write-Output 'Background count passed: only metadata.origin=opencode-delegate sessions count.'
