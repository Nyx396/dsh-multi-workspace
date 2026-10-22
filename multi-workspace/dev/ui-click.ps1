# Dev-only UI driver: focus the DSH window, optionally click at window-relative
# coordinates, then capture a screenshot. Not part of the delivered plugin.
param(
  [int]$X = -1,
  [int]$Y = -1,
  [string]$Shot = 'F:\AIwork\DSH custom plugin\_shot-dsh.png',
  [switch]$NoClick
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Win32UI {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[Win32UI]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing
$proc = Get-Process | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw 'DSH window not found' }
$h = $proc.MainWindowHandle
[Win32UI]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 250
$rect = New-Object Win32UI+RECT
[Win32UI]::GetWindowRect($h, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if (-not $NoClick -and $X -ge 0 -and $Y -ge 0) {
  $sx = $rect.Left + $X
  $sy = $rect.Top + $Y
  [Win32UI]::SetCursorPos($sx, $sy) | Out-Null
  Start-Sleep -Milliseconds 120
  [Win32UI]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [Win32UI]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 700
}
$bmp = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
"clicked=$(-not $NoClick) at=$X,$Y window=$($rect.Left),$($rect.Top),$width x $height shot=$Shot"
