param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$OwnedProcessId,
  [Parameter(Mandatory = $true)][string]$ExpectedExecutable
)
$ErrorActionPreference = 'Stop'
if ($env:APP_ENV -ne 'development' -or $env:CI -ne 'true') { throw 'Native close automation is restricted to isolated development CI.' }
$expectedPath = [IO.Path]::GetFullPath($ExpectedExecutable)
$ownedProcess = Get-Process -Id $OwnedProcessId -ErrorAction Stop
if (-not [String]::Equals($ownedProcess.Path, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The target process is not the owned candidate executable.' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PackProofNativeClose {
  private delegate bool EnumWindowCallback(IntPtr window, IntPtr argument);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr argument);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static IntPtr[] VisibleApplicationWindows(int expectedProcessId) {
    var windows = new List<IntPtr>();
    bool enumerated = EnumWindows(delegate(IntPtr window, IntPtr argument) {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (processId != expectedProcessId || !IsWindowVisible(window) || !IsWindowEnabled(window)) return true;
      var className = new StringBuilder(256);
      GetClassName(window, className, className.Capacity);
      // Hidden notification/tray windows and other applications are not close targets.
      if (className.ToString() == "Chrome_WidgetWin_1" || className.ToString() == "Chrome_WidgetWin_0") windows.Add(window);
      return true;
    }, IntPtr.Zero);
    if (!enumerated) throw new InvalidOperationException("Top-level window enumeration failed.");
    return windows.ToArray();
  }
  public static bool RequestClose(IntPtr window, int expectedProcessId) {
    uint processId;
    GetWindowThreadProcessId(window, out processId);
    if (processId != expectedProcessId || !IsWindowVisible(window) || !IsWindowEnabled(window)) return false;
    // WM_CLOSE reaches Electron's existing close event and its capture/queue guards.
    // Posting the request does not require a foreground desktop or synthesize keyboard input.
    return PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
}
'@
$windows = @([PackProofNativeClose]::VisibleApplicationWindows($OwnedProcessId))
if ($windows.Count -ne 1) {
  @{ method = 'owned-visible-window-wm-close'; processId = $OwnedProcessId; matchedWindows = $windows.Count; delivered = $false; failureCode = 'NO_UNIQUE_OWNED_WINDOW' } | ConvertTo-Json -Compress
  exit 1
}
$ownedProcess.Refresh()
if ($ownedProcess.HasExited -or -not [String]::Equals($ownedProcess.Path, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The owned candidate exited or changed before the close request.' }
$delivered = [PackProofNativeClose]::RequestClose($windows[0], $OwnedProcessId)
if (-not $delivered) {
  @{ method = 'owned-visible-window-wm-close'; processId = $OwnedProcessId; matchedWindows = $windows.Count; delivered = $false; failureCode = 'WINDOW_CLOSE_POST_FAILED' } | ConvertTo-Json -Compress
  exit 1
}
@{ method = 'owned-visible-window-wm-close'; processId = $OwnedProcessId; matchedWindows = $windows.Count; delivered = $true } | ConvertTo-Json -Compress
