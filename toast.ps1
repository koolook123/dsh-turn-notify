# dsh-turn-notify — 桌面右下角弹窗渲染器
#
# 由 dsh-turn-notify 插件以子进程方式调用，在桌面右下角绘制一个淡入淡出的
# 提示卡片，停留 N 秒后自动消失。
#
# 为什么不用 Windows Toast：
#   未打包的 Win32 进程没有注册 AppUserModelId 快捷方式，ToastNotifier.Show()
#   会返回成功但系统静默丢弃通知，无法可靠工作。
#
# 为什么不用 Electron BrowserWindow：
#   DSH 的插件宿主是独立的 node 子进程（dsh-desktop-host 由 spawn 启动），
#   不在 Electron 主进程内，require('electron') 拿不到 BrowserWindow。
#
# 坐标系说明（重要）：
#   WPF 的 Left/Top/Width/Height 使用 DIP（设备无关像素）。高 DPI 缩放下
#   （本机 2560x1600 物理 / 1280x800 逻辑 = 200%）必须用
#   SystemParameters.WorkArea（已经是 DIP），混用
#   System.Windows.Forms.Screen（物理像素）会把窗口放到屏幕外两倍远。

param(
  [string]$Title = 'DeepSeek Harness',
  [string]$Body = 'Turn finished',
  [int]$Seconds = 6,
  [double]$CardWidth = 380,
  [double]$BottomMargin = 24,
  [double]$RightMargin = 24,
  [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'

# 声明 DPI 感知。
# 不做这一步时，未声明感知的进程会被系统按缩放比例虚拟化：
# SystemParameters.WorkArea 返回被二次缩放的值（本机 200% 下 Right 只有 476），
# 算出的 Left 变成负数、窗口飞到屏幕外。必须在任何 WPF 尺寸计算之前调用。
try {
  Add-Type -Namespace Win32 -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -ErrorAction SilentlyContinue
  [Win32.Dpi]::SetProcessDPIAware() | Out-Null
} catch {
  # 类型已存在或调用失败都不阻断，退回默认缩放行为
}

function Write-Log([string]$Message) {
  if ([string]::IsNullOrWhiteSpace($LogPath)) { return }
  try {
    $line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fff') [wpf] $Message"
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
  } catch { }
}

try {
  Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

  Write-Log "start title=$Title seconds=$Seconds"

  $xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True"
        SizeToContent="Height" Width="$CardWidth"
        ResizeMode="NoResize" ShowActivated="False">
  <Border CornerRadius="10" Background="#F01E1E28" BorderBrush="#33FFFFFF" BorderThickness="1" Padding="18,14">
    <Border.Effect>
      <DropShadowEffect BlurRadius="22" ShadowDepth="3" Opacity="0.55" Color="Black"/>
    </Border.Effect>
    <StackPanel>
      <TextBlock x:Name="TitleText" Foreground="#FFFFFFFF" FontSize="15" FontWeight="SemiBold"
                 FontFamily="Microsoft YaHei UI" TextWrapping="Wrap"/>
      <TextBlock x:Name="BodyText" Foreground="#CCFFFFFF" FontSize="13" Margin="0,6,0,0"
                 FontFamily="Microsoft YaHei UI" TextWrapping="Wrap"/>
    </StackPanel>
  </Border>
</Window>
"@

  $reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
  $window = [Windows.Markup.XamlReader]::Load($reader)
  $window.FindName('TitleText').Text = $Title
  $window.FindName('BodyText').Text = $Body

  # WorkArea 是 DIP，和 WPF 同一坐标系
  $area = [System.Windows.SystemParameters]::WorkArea
  $window.WindowStartupLocation = 'Manual'
  $window.Left = $area.Right - $CardWidth - $RightMargin - $area.Left
  $window.Top = $area.Bottom - 96 - $BottomMargin - $area.Top

  $window.Show()
  $window.UpdateLayout()

  # 内容测量完再贴底，避免高度未定时定位偏移
  $window.Top = $area.Bottom - $window.ActualHeight - $BottomMargin - $area.Top
  Write-Log ("shown left={0} top={1} actual={2}x{3}" -f [int]$window.Left, [int]$window.Top, [int]$window.ActualWidth, [int]$window.ActualHeight)

  $window.Opacity = 0
  for ($i = 1; $i -le 8; $i++) {
    $window.Opacity = $i / 8
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 20
  }

  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
  }

  for ($i = 8; $i -ge 1; $i--) {
    $window.Opacity = $i / 8
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 20
  }

  $window.Close()
  Write-Log 'closed'
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
  Write-Log $_.ScriptStackTrace
  exit 1
}
