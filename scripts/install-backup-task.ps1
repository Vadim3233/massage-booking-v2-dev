# Sets up the daily database backup on this PC (see docs/SAFETY_NET.md). Needs no administrator rights.
#   powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1             install or update
#   powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1 -Remove     take the two scheduled tasks away (backups already made are kept)
# -ToolDir  where the tool is copied to (default: VadMassage-Backups\tool in your user folder)
# -Time     when the daily backup runs (default 21:30)
# -NoTask   copy the tool and write the launchers, but create no scheduled tasks
# -WhatIf   show what would happen without doing any of it
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$ToolDir = (Join-Path $env:USERPROFILE 'VadMassage-Backups\tool'),
  [string]$Time = '21:30',
  [switch]$NoTask,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$backupTask = 'Vad Massage - database backup'
$checkTask = 'Vad Massage - backup check'

# The scheduled-task commands ignore -WhatIf by themselves, so every use of them is gated here.
if ($Remove) {
  if ($PSCmdlet.ShouldProcess('Windows Task Scheduler', 'Remove the two Vad Massage backup tasks')) {
    foreach ($name in $backupTask, $checkTask) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue }
    Write-Output 'Both scheduled tasks were removed. The backups already made, and the tool folder, were left alone.'
  }
  return
}

# The tool runs the Supabase command that is already installed in this project's node_modules.
$repo = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repo 'node_modules\supabase\dist\supabase.js'
if (-not (Test-Path -LiteralPath $cli)) { throw "Cannot find $cli. Run this from the project folder that has node_modules." }
$node = (Get-Command node -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $ToolDir | Out-Null
foreach ($file in 'backup-database.mjs', 'backup-lib.mjs') {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $ToolDir -Force
}

# run-backup.cmd is what the scheduled tasks call; "Back up now.cmd" is the same thing for double-clicking.
$run = Join-Path $ToolDir 'run-backup.cmd'
Set-Content -LiteralPath $run -Encoding ASCII -Value @(
  '@echo off',
  ('set "SUPABASE_CLI_JS={0}"' -f $cli),
  ('"{0}" "%~dp0backup-database.mjs" %*' -f $node)
)
Set-Content -LiteralPath (Join-Path $ToolDir 'Back up now.cmd') -Encoding ASCII -Value @(
  '@echo off',
  'call "%~dp0run-backup.cmd" %*',
  'echo.',
  'pause'
)

if ($NoTask) {
  Write-Output "The tool was copied to $ToolDir. No scheduled tasks were created."
  return
}

if (-not $PSCmdlet.ShouldProcess('Windows Task Scheduler', "Create the daily backup at $Time and the check after sign-in")) { return }

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$backupAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -Command "& ''{0}''"' -f $run)
$checkAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -Command "& ''{0}'' --check --popup"' -f $run)

# Daily at $Time; if the PC was off then, it runs as soon as it can.
Register-ScheduledTask -TaskName $backupTask -Action $backupAction -Trigger (New-ScheduledTaskTrigger -Daily -At $Time) -Settings $settings `
  -Description 'Saves a copy of the booking database to this PC. See docs/SAFETY_NET.md in the project.' -Force | Out-Null

# Ten minutes after you sign in: warns with a pop-up if there has been no good backup for three days.
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$atLogon.Delay = 'PT10M'
Register-ScheduledTask -TaskName $checkTask -Action $checkAction -Trigger $atLogon -Settings $settings `
  -Description 'Warns if the booking database has not been backed up for three days. See docs/SAFETY_NET.md in the project.' -Force | Out-Null

Write-Output "Done. The backup runs every day at $Time (or as soon as the PC is on), and a warning appears after you sign in if it has not worked for three days."
Write-Output "Next: save the connection string (docs/SAFETY_NET.md, step 2), then double-click 'Back up now.cmd' in $ToolDir to try it."
