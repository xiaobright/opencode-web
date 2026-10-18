$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$trayPath = Join-Path $PSScriptRoot '..\..\tray\tray.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($trayPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw $parseErrors[0] }
$update = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Update-Tray' }, $true)
# Load the actual tray policy without creating an icon or starting services.
. ([scriptblock]::Create($update.Extent.Text))
$Lazy = $true
$WebUrl = 'http://fixture/'
$icon = [pscustomobject]@{ Text = ''; Visible = $false }
$state = @{ Failures = 0 }
$script:FindCalls = 0
$script:CloseCalls = 0
$script:GatewayPhase = 'idle'
function Find-Service { $script:FindCalls++; return $null }
function Close-Tray { $script:CloseCalls++ }
function Write-Log { }
function Invoke-RestMethod { return @{ backend = $script:GatewayPhase } }
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
Write-Output 'Tray policy passed: standby remains visible without backend probes; a sleeping service keeps the icon as the entry point.'
