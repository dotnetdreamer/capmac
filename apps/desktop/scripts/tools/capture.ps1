# Captures the CapMac Studio window exactly as it appears on screen (Mica, caption buttons included).
# usage: powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/tools/capture.ps1 -Out shot.png [-Title "CapMac Studio"] [-NoActivate]
# Brings the window to the front for a moment (topmost while capturing), then restores its z-order.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Title = 'CapMac Studio',
  [switch]$NoActivate
)
# .NET resolves relative paths against the process directory, not Set-Location.
if (-not [System.IO.Path]::IsPathRooted($Out)) { $Out = Join-Path (Get-Location).Path $Out }
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
# Physical pixels at any display scaling.
[void][Win]::SetThreadDpiAwarenessContext([IntPtr](-4))
$h = [Win]::Find($Title)
if ($h -eq [IntPtr]::Zero) { Write-Error "No visible window titled '$Title'"; exit 1 }
if (-not $NoActivate) {
  $HWND_TOPMOST = [IntPtr](-1); $HWND_NOTOPMOST = [IntPtr](-2)
  [void][Win]::ShowWindow($h, 9)
  [void][Win]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, 0x0003)
  [void][Win]::BringWindowToTop($h)
  [void][Win]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 700
}
$r = New-Object Win+RECT
[void][Win]::DwmGetWindowAttribute($h, 9, [ref]$r, 16)
$w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $hgt))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
if (-not $NoActivate) { [void][Win]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003) }
Write-Output "$Out ${w}x${hgt} at $($r.Left),$($r.Top)"
