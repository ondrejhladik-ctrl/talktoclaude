# Sleduje oznameni Windows (Centrum akci) a kazde nove vypise jako jeden radek JSON.
# Pouziva oficialni rozhrani UserNotificationListener. Spousti ho lib/winnotify.js.
# (Soubor je schvalne jen v ASCII - Windows PowerShell 5.1 cte skripty bez BOM v ANSI.)
param([int]$IntervalSec = 4)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)) }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $task.Wait(20000)) { throw 'timeout' }
    $task.Result
  }
  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $status = Await ($listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
  if ("$status" -ne 'Allowed') {
    Emit @{ error = 'denied'; status = "$status" }
    exit 2
  }
  Emit @{ ready = $true }
} catch {
  Emit @{ error = 'init'; message = "$($_.Exception.Message)" }
  exit 3
}

$listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$first = $true
$fails = 0

while ($true) {
  try {
    $list = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $listType
    $current = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($n in $list) {
      $id = "$($n.Id)"
      [void]$current.Add($id)
      if ($seen.Contains($id) -or $first) { continue }
      $app = ''
      $aumid = ''
      try { $app = "$($n.AppInfo.DisplayInfo.DisplayName)" } catch {}
      try { $aumid = "$($n.AppInfo.AppUserModelId)" } catch {}
      $texts = New-Object System.Collections.ArrayList
      try {
        $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
        if ($binding) { foreach ($t in $binding.GetTextElements()) { if ($t.Text) { [void]$texts.Add("$($t.Text)") } } }
      } catch {}
      if ($texts.Count -eq 0) { continue }
      Emit @{ id = $id; app = $app; aumid = $aumid; time = $n.CreationTime.ToUnixTimeMilliseconds(); texts = @($texts) }
    }
    $seen = $current
    $first = $false
    $fails = 0
  } catch {
    $fails++
    if ($fails -ge 5) { Emit @{ error = 'loop'; message = "$($_.Exception.Message)" }; exit 4 }
  }
  Start-Sleep -Seconds $IntervalSec
}
