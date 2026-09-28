param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Message
)

$ErrorActionPreference = "Stop"
$appId = "LifeOS.Pulse"
$safeTitle = [Security.SecurityElement]::Escape($Title)
$safeMessage = [Security.SecurityElement]::Escape($Message)
$xml = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>$safeTitle</text>
      <text>$safeMessage</text>
    </binding>
  </visual>
</toast>
"@

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$document = New-Object Windows.Data.Xml.Dom.XmlDocument
$document.LoadXml($xml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($document)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
