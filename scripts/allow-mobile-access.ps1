$ErrorActionPreference = "Stop"

$ruleName = "无聊英语 局域网下载 4173"
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($existingRule) {
  Set-NetFirewallRule `
    -DisplayName $ruleName `
    -Enabled True `
    -Direction Inbound `
    -Action Allow `
    -Profile Private
} else {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 4173 `
    -Profile Private `
    -RemoteAddress LocalSubnet | Out-Null
}

Write-Host "已允许同一专用网络中的手机和平板访问 TCP 4173。"
