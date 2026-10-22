# Dev-only: capture the DSH window through PrintWindow so verification never
# steals focus or clicks the user's desktop. Not part of the delivered plugin.
param(
  [string]$Shot = 'F:\AIwork\DSH custom plugin\_shot-print.png'
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinPrint {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[WinPrint]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing
$proc = Get-Process | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw 'DSH window not found' }
$h = $proc.MainWindowHandle
$rect = New-Object WinPrint+RECT
[WinPrint]::GetWindowRect($h, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw 'DSH window has no area' }
$bmp = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $graphics.GetHdc()
$ok = [WinPrint]::PrintWindow($h, $hdc, 2)
if (-not $ok) { $ok = [WinPrint]::PrintWindow($h, $hdc, 0) }
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()
$bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"printwindow=$ok visible=$([WinPrint]::IsWindowVisible($h)) minimized=$([WinPrint]::IsIconic($h)) size=${width}x${height} shot=$Shot"
