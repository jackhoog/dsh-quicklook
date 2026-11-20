# Quicklook shell: global hotkeys, clipboard capture and the always-on-top window.
# Started by the DSH plugin with QK_ORIGIN / QK_TOKEN / QK_HOTKEYS in the environment.
# Runs under: powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File quicklook.ps1

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Origin = $env:QK_ORIGIN
$script:Token = $env:QK_TOKEN
$script:Hotkeys = if ($env:QK_HOTKEYS) { $env:QK_HOTKEYS | ConvertFrom-Json } else { $null }
$script:Browser = $env:QK_BROWSER
$script:WindowTitle = 'QL · 划词小窗'
$script:WindowSize = @{ Width = 256; Height = 341 }
if ($env:QK_WINDOW -match '^(\d{2,4})x(\d{2,4})$') {
  $script:WindowSize = @{ Width = [int]$Matches[1]; Height = [int]$Matches[2] }
}
$script:TestMarker = $env:QK_TEST
$script:HideFrame = ($env:QK_FRAME -ne '0')
if ($env:QK_WINDOW -match '^(\d{2,4})x(\d{2,4})$') {
  $script:WindowSize = @{ Width = [int]$Matches[1]; Height = [int]$Matches[2] }
}
$script:Hwnd = [IntPtr]::Zero
$script:capturing = $false
$script:pendingAction = ''
$script:pendingTimer = $null
$script:clipboardText = ''
$script:clipboardSuppressedUntil = [DateTime]::MinValue
$script:clipboardTimer = $null
$script:startupResizeDone = $false
$script:sizeApplied = $false
$script:ocrReady = $false
$script:ocrEngine = $null
$script:asTask = $null
$script:LogFile = Join-Path $env:TEMP 'quicklook.log'

function Write-Log {
  param([string]$Message)
  try {
    if ((Test-Path $script:LogFile) -and ((Get-Item $script:LogFile).Length -gt 200KB)) {
      Remove-Item $script:LogFile -Force
    }
    '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message | Add-Content -Path $script:LogFile -Encoding UTF8
  } catch { }
}

$native = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class QkShell
{
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindow(string className, string windowName);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    public static string WindowSize(IntPtr hWnd)
    {
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) return "unknown";
        return (rect.Right - rect.Left) + "x" + (rect.Bottom - rect.Top);
    }
    public static int WindowWidth(IntPtr hWnd) { RECT rect; if (!GetWindowRect(hWnd, out rect)) return 0; return rect.Right - rect.Left; }
    public static int WindowHeight(IntPtr hWnd) { RECT rect; if (!GetWindowRect(hWnd, out rect)) return 0; return rect.Bottom - rect.Top; }

    // Strip the native caption (minimize/maximize/close) while keeping the
    // resizable frame, so the window stays draggable by its edges.
    public static void HideCaption(IntPtr handle)
    {
        const int GWL_STYLE = -16;
        const int WS_CAPTION = 0x00C00000;
        int style = GetWindowLong(handle, GWL_STYLE);
        if ((style & WS_CAPTION) == 0) return;
        SetWindowLong(handle, GWL_STYLE, style & ~WS_CAPTION);
        SetWindowPos(handle, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020);
    }
    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);
    [DllImport("user32.dll")]
    static extern IntPtr GetFocus();
    [DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")]
    static extern int SetWindowLong(IntPtr hWnd, int index, int value);

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    static extern int GetWindowTextLength(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    public static Action<int> OnHotkey;

    class HotkeyWindow : NativeWindow
    {
        public void EnsureHandle()
        {
            if (this.Handle == IntPtr.Zero) this.CreateHandle(new CreateParams());
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0312)
            {
                Action<int> callback = OnHotkey;
                if (callback != null) callback(m.WParam.ToInt32());
                return;
            }
            base.WndProc(ref m);
        }
    }

    static HotkeyWindow window;

    public static bool Init(int[] ids, int[] modifiers, int[] virtualKeys)
    {
        window = new HotkeyWindow();
        window.EnsureHandle();
        bool all = true;
        for (int i = 0; i < ids.Length; i++)
        {
            if (!RegisterHotKey(window.Handle, ids[i], (uint)modifiers[i], (uint)virtualKeys[i])) all = false;
        }
        return all;
    }

    public static void Run() { Application.Run(); }

    // Region selection and screen capture are wrong under DPI virtualization.
    public static void EnableDpi() { try { SetProcessDPIAware(); } catch { } }

    public static int CursorX() { POINT point; GetCursorPos(out point); return point.X; }
    public static int CursorY() { POINT point; GetCursorPos(out point); return point.Y; }

    // The hotkey arrives while its modifiers are still held; sending Ctrl+C then
    // would be read as Alt+Shift+Ctrl+C and the copy never happens.
    public static bool ModifierDown()
    {
        int[] keys = { 0x10, 0x11, 0x12, 0x5B, 0x5C }; // shift, control, menu, lwin, rwin
        for (int i = 0; i < keys.Length; i++)
        {
            if ((GetAsyncKeyState(keys[i]) & 0x8000) != 0) return true;
        }
        return false;
    }

    public static string ForegroundTitle()
    {
        IntPtr handle = GetForegroundWindow();
        int length = GetWindowTextLength(handle);
        if (length <= 0) return "";
        StringBuilder buffer = new StringBuilder(length + 2);
        GetWindowText(handle, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    // Message-level copy: works where synthesized Ctrl+C is refused, because it
    // needs no input injection at all.
    public static bool CopyFocusedControl()
    {
        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) return false;
        uint processId;
        uint targetThread = GetWindowThreadProcessId(foreground, out processId);
        uint ownThread = GetCurrentThreadId();
        IntPtr focused = IntPtr.Zero;
        bool attached = false;
        try
        {
            if (targetThread != ownThread) attached = AttachThreadInput(ownThread, targetThread, true);
            focused = GetFocus();
            if (focused == IntPtr.Zero) return false;
            SendMessage(focused, 0x0301, IntPtr.Zero, IntPtr.Zero); // WM_COPY
            return true;
        }
        catch
        {
            return false;
        }
        finally
        {
            if (attached) AttachThreadInput(ownThread, targetThread, false);
        }
    }

    // FindWindow can miss Edge's app window; enumerate every top-level window instead.
    public static IntPtr Find(string title)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((handle, param) =>
        {
            if (!IsWindowVisible(handle)) return true;
            int length = GetWindowTextLength(handle);
            if (length <= 0) return true;
            StringBuilder buffer = new StringBuilder(length + 2);
            GetWindowText(handle, buffer, buffer.Capacity);
            if (buffer.ToString() == title) { found = handle; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static void Place(IntPtr handle, int x, int y, int width, int height)
    {
        ShowWindow(handle, 4); // SW_SHOWNOACTIVATE
        // HWND_TOPMOST with SWP_NOACTIVATE | SWP_SHOWWINDOW
        SetWindowPos(handle, new IntPtr(-1), x, y, width, height, 0x0010 | 0x0040);
    }

    // Move and show without touching the size, so a user-dragged height survives.
    public static void MoveTopmost(IntPtr handle, int x, int y)
    {
        ShowWindow(handle, 4); // SW_SHOWNOACTIVATE
        SetWindowPos(handle, new IntPtr(-1), x, y, 0, 0, 0x0001 | 0x0010 | 0x0040);
    }

    // Resize only: no move, no z-order change, no activation, no show.
    public static void Resize(IntPtr handle, int width, int height)
    {
        SetWindowPos(handle, IntPtr.Zero, 0, 0, width, height, 0x0002 | 0x0004 | 0x0010);
    }
}
'@

Add-Type -TypeDefinition $native -ReferencedAssemblies System.Windows.Forms, System.Drawing
[QkShell]::EnableDpi()

function ConvertTo-HotkeySpec {
  param([string]$Spec)
  $modifiers = 0
  $virtualKey = 0
  if ([string]::IsNullOrWhiteSpace($Spec)) { return $null }
  foreach ($token in ($Spec -split '\+')) {
    $part = $token.Trim()
    switch ($part.ToUpperInvariant()) {
      'CTRL' { $modifiers = $modifiers -bor 0x0002; continue }
      'ALT' { $modifiers = $modifiers -bor 0x0001; continue }
      'SHIFT' { $modifiers = $modifiers -bor 0x0004; continue }
      'WIN' { $modifiers = $modifiers -bor 0x0008; continue }
    }
    if ($part.Length -eq 1) {
      $character = [char]::ToUpperInvariant($part[0])
      if (($character -ge 'A' -and $character -le 'Z') -or ($character -ge '0' -and $character -le '9')) {
        $virtualKey = [int][char]$character
      }
    } elseif ($part -match '^F(\d{1,2})$') {
      $virtualKey = 0x70 + ([int]$Matches[1]) - 1
    } elseif ($part -eq 'Space') {
      $virtualKey = 0x20
    }
  }
  if ($virtualKey -eq 0 -or $modifiers -eq 0) { return $null }
  return @{ modifiers = $modifiers; virtualKey = $virtualKey }
}

function Wait-ModifiersReleased {
  param([int]$TimeoutMs = 900)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      if (-not [QkShell]::ModifierDown()) { Start-Sleep -Milliseconds 40; return $true }
    } catch { return $false }
    Start-Sleep -Milliseconds 15
  }
  return $false
}

function Get-Selection {
  $previous = $null
  $dataObject = $null
  try {
    if ([System.Windows.Forms.Clipboard]::ContainsText()) { $previous = [System.Windows.Forms.Clipboard]::GetText() }
    $dataObject = [System.Windows.Forms.Clipboard]::GetDataObject()
  } catch { }

  Write-Log ("capture: focus='" + ([QkShell]::ForegroundTitle()) + "' previous=" + $(if ($null -eq $previous) { 'null' } else { $previous.Length.ToString() + ' chars' }))

  # Wait for the hotkey's own modifiers to be released first.
  $released = Wait-ModifiersReleased
  if (-not $released) { Write-Log 'capture: modifiers still held after timeout' }

  # Keep the clipboard watcher quiet while we borrow the clipboard.
  $script:clipboardSuppressedUntil = [DateTime]::UtcNow.AddSeconds(4)

  $captured = $null
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $method = 'message'
    if ($attempt -eq 1) {
      try {
        if (-not [QkShell]::CopyFocusedControl()) { $method = 'keys' }
      } catch { $method = 'keys' }
    } else {
      $method = 'keys'
    }
    if ($method -eq 'keys') {
      try {
        # Send, not SendWait: SendWait waits for the target to process the keys,
        # which it cannot do while this timer callback owns the thread.
        [System.Windows.Forms.SendKeys]::Send('^c')
      } catch {
        Write-Log ("capture: SendKeys failed: " + $_.Exception.Message)
      }
    }

    $deadline = [DateTime]::UtcNow.AddMilliseconds(650)
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 30
      try {
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
          $candidate = [System.Windows.Forms.Clipboard]::GetText()
          if ($candidate -ne $previous -and -not [string]::IsNullOrWhiteSpace($candidate)) {
            $captured = $candidate
            break
          }
        }
      } catch { }
    }

    if ($null -ne $captured) {
      Write-Log ("capture: ok via $method, " + $captured.Length + ' chars')
      break
    }
    $current = ''
    try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $current = [System.Windows.Forms.Clipboard]::GetText() } } catch { }
    Write-Log ("capture: attempt $attempt via $method empty, clipboard now " + $current.Length + ' chars, unchanged=' + ($current -eq $previous))
    Start-Sleep -Milliseconds 150
  }

  if ($null -ne $dataObject) {
    try { [System.Windows.Forms.Clipboard]::SetDataObject($dataObject, $true) } catch { }
  }
  try {
    $script:clipboardText = if ([System.Windows.Forms.Clipboard]::ContainsText()) { [System.Windows.Forms.Clipboard]::GetText() } else { '' }
  } catch { $script:clipboardText = '' }
  return $captured
}

function Start-ClipboardWatcher {
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 700
  $timer.Add_Tick({
      if ($script:TestMarker -and (Test-Path $script:TestMarker)) {
        Remove-Item $script:TestMarker -Force -ErrorAction SilentlyContinue
        Write-Log 'test window requested'
        try { Invoke-Pick -Action 'translate' -SkipCapture } catch { Write-Log ('test window failed: ' + $_.Exception.Message) }
      }
      # Track the window even when the shell restarted with one already open, and keep
      # the caption stripped: Chromium restores its frame shortly after creation.
      if ($script:Hwnd -eq [IntPtr]::Zero -or -not [QkShell]::IsWindow($script:Hwnd)) {
        $script:Hwnd = [QkShell]::Find($script:WindowTitle)
      }
      if ($script:Hwnd -ne [IntPtr]::Zero) {
        # Apply the configured size once per shell generation; after that the window
        # size belongs to the user, so a differing size means they dragged it.
        if (-not $script:sizeApplied) {
          try {
            [QkShell]::Resize($script:Hwnd, $script:WindowSize.Width, $script:WindowSize.Height)
            $script:sizeApplied = $true
            Write-Log ('applied size -> ' + [QkShell]::WindowSize($script:Hwnd))
          } catch {
            Write-Log ('apply size failed: ' + $_.Exception.Message)
          }
        } else {
          $actualWidth = [QkShell]::WindowWidth($script:Hwnd)
          $actualHeight = [QkShell]::WindowHeight($script:Hwnd)
          if ($actualWidth -gt 0 -and $actualHeight -gt 0 -and
              ($actualWidth -ne $script:WindowSize.Width -or $actualHeight -ne $script:WindowSize.Height)) {
            try {
              $resizeBody = @{ width = $actualWidth; height = $actualHeight } | ConvertTo-Json -Compress
              Invoke-RestMethod -Uri "$($script:Origin)/qk/window" -Method Post `
                -Headers @{ 'x-qk-token' = $script:Token } -ContentType 'application/json; charset=utf-8' `
                -Body ([System.Text.Encoding]::UTF8.GetBytes($resizeBody)) -TimeoutSec 5 | Out-Null
              $script:WindowSize = @{ Width = $actualWidth; Height = $actualHeight }
              Write-Log ('user resized -> ' + $actualWidth + 'x' + $actualHeight)
            } catch { }
          }
        }
        if ($script:HideFrame) {
          try { [QkShell]::HideCaption($script:Hwnd) } catch { }
        }
      }
      if ([DateTime]::UtcNow -lt $script:clipboardSuppressedUntil) { return }
      try {
        if (-not [System.Windows.Forms.Clipboard]::ContainsText()) { return }
        $text = [System.Windows.Forms.Clipboard]::GetText()
        if ([string]::IsNullOrWhiteSpace($text)) { return }
        if ($text -eq $script:clipboardText) { return }
        $script:clipboardText = $text
        $body = @{ text = $text } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "$($script:Origin)/qk/clipboard" -Method Post `
          -Headers @{ 'x-qk-token' = $script:Token } -ContentType 'application/json; charset=utf-8' `
          -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 5 | Out-Null
      } catch { }
    })
  $timer.Start()
  return $timer
}

function Resolve-Browser {
  if (-not [string]::IsNullOrWhiteSpace($script:Browser) -and (Test-Path $script:Browser)) { return $script:Browser }
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

function Show-Picker {
  param([string]$Url, [string]$Action)

  $url = $Url
  if ([string]::IsNullOrWhiteSpace($url)) { Write-Log 'pick returned no url'; return }

  $freshlyLaunched = $false
  if ($script:Hwnd -ne [IntPtr]::Zero -and [QkShell]::IsWindow($script:Hwnd)) {
    Write-Log 'reusing window'
  } else {
    $freshlyLaunched = $true
    $browser = Resolve-Browser
    if (-not $browser) { Write-Log 'no Edge found'; return }
    # A dedicated profile keeps the window inside a process this shell can see:
    # with the default profile Edge merges the app window into the user's instance.
    $profileDir = Join-Path $env:LOCALAPPDATA 'quicklook-edge'
    $arguments = @(
      "--app=$url",
      "--user-data-dir=$profileDir",
      "--window-size=$($script:WindowSize.Width),$($script:WindowSize.Height)",
      '--no-first-run',
      '--no-default-browser-check'
    )
    $launched = Start-Process -FilePath $browser -ArgumentList $arguments -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 150
      if ($null -ne $launched) {
        try {
          $launched.Refresh()
          if ($launched.MainWindowHandle -ne [IntPtr]::Zero) {
            $script:Hwnd = $launched.MainWindowHandle
            break
          }
        } catch { }
      }
      $handle = [QkShell]::Find($script:WindowTitle)
      if ($handle -ne [IntPtr]::Zero) { $script:Hwnd = $handle; break }
    }
  }

  if ($script:Hwnd -eq [IntPtr]::Zero -or -not [QkShell]::IsWindow($script:Hwnd)) {
    Write-Log ('window not found; open manually: ' + $url)
    return
  }

  $x = [QkShell]::CursorX() + 18
  $y = [QkShell]::CursorY() + 18
  $screen = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($x, $y)))
  if ($null -eq $screen) { $screen = [System.Windows.Forms.Screen]::PrimaryScreen }
  $bounds = $screen.WorkingArea
  if (($x + $script:WindowSize.Width) -gt $bounds.Right) { $x = [Math]::Max($bounds.Left, $bounds.Right - $script:WindowSize.Width - 8) }
  if (($y + $script:WindowSize.Height) -gt $bounds.Bottom) { $y = [Math]::Max($bounds.Top, $bounds.Bottom - $script:WindowSize.Height - 8) }
  # A freshly created Chromium window applies its own bounds a moment later, so
  # resizing once right after creation gets overwritten. A reused window keeps the
  # size the user dragged it to: only the position follows the cursor.
  if ($freshlyLaunched) {
    Start-Sleep -Milliseconds 1000
    [QkShell]::Place($script:Hwnd, $x, $y, $script:WindowSize.Width, $script:WindowSize.Height)
    Start-Sleep -Milliseconds 250
    [QkShell]::Place($script:Hwnd, $x, $y, $script:WindowSize.Width, $script:WindowSize.Height)
    Start-Sleep -Milliseconds 600
    [QkShell]::Place($script:Hwnd, $x, $y, $script:WindowSize.Width, $script:WindowSize.Height)
    $script:sizeApplied = $true
    if ($script:HideFrame) { try { [QkShell]::HideCaption($script:Hwnd) } catch { } }
    Write-Log ('window size requested=' + $script:WindowSize.Width + 'x' + $script:WindowSize.Height + ' actual=' + [QkShell]::WindowSize($script:Hwnd) + ' frame=' + $(if ($script:HideFrame) { 'hidden' } else { 'native' }))
  } else {
    if ($script:HideFrame) { try { [QkShell]::HideCaption($script:Hwnd) } catch { } }
    [QkShell]::MoveTopmost($script:Hwnd, $x, $y)
    Write-Log ('window moved, kept size ' + [QkShell]::WindowSize($script:Hwnd))
  }
}

function Invoke-Pick {
  param([string]$Action, [switch]$SkipCapture)

  $title = ''
  try { $title = [QkShell]::ForegroundTitle() } catch { }
  $text = if ($SkipCapture) { '' } else { Get-Selection }
  $notice = ''
  if ([string]::IsNullOrWhiteSpace($text)) {
    Write-Log 'nothing captured; opening the window for manual paste'
    $notice = 'capture-failed'
    $text = ''
  }

  $body = @{ text = $text; title = $title; action = $Action; notice = $notice } | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  try {
    $response = Invoke-RestMethod -Uri "$($script:Origin)/qk/pick" -Method Post `
      -Headers @{ 'x-qk-token' = $script:Token } -ContentType 'application/json; charset=utf-8' `
      -Body $bytes -TimeoutSec 10
    Show-Picker -Url $response.url -Action $Action
  } catch {
    Write-Log ("pick failed: " + $_.Exception.Message)
  }
}

function Select-Region {
  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Bounds = $virtual
  $form.TopMost = $true
  $form.BackColor = [System.Drawing.Color]::Black
  $form.Opacity = 0.35
  $form.Cursor = [System.Windows.Forms.Cursors]::Cross
  $form.ShowInTaskbar = $false

  $script:selStart = $null
  $script:selRect = $null
  $script:selDone = $false

  $form.Add_MouseDown({ param($sender, $eventArgs) $script:selStart = $eventArgs.Location })
  $form.Add_MouseMove({
      param($sender, $eventArgs)
      if ($null -eq $script:selStart) { return }
      $x = [Math]::Min($script:selStart.X, $eventArgs.X)
      $y = [Math]::Min($script:selStart.Y, $eventArgs.Y)
      $w = [Math]::Abs($eventArgs.X - $script:selStart.X)
      $h = [Math]::Abs($eventArgs.Y - $script:selStart.Y)
      $script:selRect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
      $sender.Invalidate()
    })
  $form.Add_Paint({
      param($sender, $eventArgs)
      if ($null -eq $script:selRect) { return }
      $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::DodgerBlue, 2)
      $eventArgs.Graphics.DrawRectangle($pen, $script:selRect)
      $pen.Dispose()
      $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 255, 255, 255))
      $eventArgs.Graphics.FillRectangle($brush, $script:selRect)
      $brush.Dispose()
    })
  $form.Add_MouseUp({ param($sender, $eventArgs) $script:selDone = $true; $sender.Close() })
  $form.Add_KeyDown({
      param($sender, $eventArgs)
      if ($eventArgs.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $script:selDone = $false; $sender.Close() }
    })

  [void]$form.ShowDialog()
  $result = $null
  if ($script:selDone -and $null -ne $script:selRect) {
    $result = New-Object System.Drawing.Rectangle(
      ($script:selRect.X + $virtual.X), ($script:selRect.Y + $virtual.Y),
      $script:selRect.Width, $script:selRect.Height)
  }
  $form.Dispose()
  return $result
}

function Get-OcrText {
  param([string]$Path)
  if (-not $script:ocrReady) {
    try {
      Add-Type -AssemblyName System.Runtime.WindowsRuntime
      $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
      $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
      $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
      $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
          $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
          $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
      $script:ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      $script:ocrReady = $true
    } catch {
      Write-Log ('local ocr unavailable: ' + $_.Exception.Message)
      $script:ocrReady = $true
      $script:ocrEngine = $null
    }
  }
  if ($null -eq $script:ocrEngine) { return '' }

  $await = {
    param($operation, $type)
    $script:asTask.MakeGenericMethod($type).Invoke($null, @($operation)).GetAwaiter().GetResult()
  }
  $file = & $await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = & $await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = & $await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = & $await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = & $await ($script:ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    return $result.Text
  } finally {
    $stream.Dispose()
  }
}

function Invoke-Capture {
  if ($script:capturing) { return }
  $script:capturing = $true
  try {
    $title = ''
    try { $title = [QkShell]::ForegroundTitle() } catch { }
    $rect = Select-Region
    if ($null -eq $rect) { Write-Log 'capture cancelled'; return }
    if ($rect.Width -lt 8 -or $rect.Height -lt 8) { Write-Log 'capture region too small'; return }
    Start-Sleep -Milliseconds 170

    $stream = New-Object System.IO.MemoryStream
    $tempPath = Join-Path $env:TEMP ('qk-' + [Guid]::NewGuid().ToString('N') + '.png')
    $ocrText = ''
    try {
      $bitmap = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($rect.X, $rect.Y, 0, 0, $bitmap.Size)
      $graphics.Dispose()
      $bitmap.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $bitmap.Dispose()
      $base64 = [Convert]::ToBase64String($stream.ToArray())
    } finally {
      $stream.Dispose()
    }

    # Local OCR first: instant, free, and independent of the configured model.
    try {
      if (Test-Path $tempPath) { $ocrText = Get-OcrText -Path $tempPath }
    } catch {
      Write-Log ('local ocr failed: ' + $_.Exception.Message)
    }
    try { if (Test-Path $tempPath) { Remove-Item $tempPath -Force } } catch { }
    Write-Log ('local ocr chars=' + $ocrText.Length)

    $body = @{ pngBase64 = $base64; title = $title; action = 'translate'; ocrText = $ocrText } | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $response = Invoke-RestMethod -Uri "$($script:Origin)/qk/capture" -Method Post `
      -Headers @{ 'x-qk-token' = $script:Token } -ContentType 'application/json; charset=utf-8' `
      -Body $bytes -TimeoutSec 30
    Write-Log ("capture sent: " + $rect.Width + 'x' + $rect.Height)
    Show-Picker -Url $response.url -Action 'translate'
  } catch {
    Write-Log ("capture failed: " + $_.Exception.Message)
  } finally {
    $script:capturing = $false
  }
}

if (-not $script:Hotkeys -or -not $script:Origin -or -not $script:Token) {
  Write-Log 'missing environment, exiting'
  exit 1
}

$specs = @()
$translate = ConvertTo-HotkeySpec $script:Hotkeys.translate
if ($null -ne $translate) { $specs += @{ id = 1; action = 'translate'; spec = $translate } }
$ask = ConvertTo-HotkeySpec $script:Hotkeys.ask
if ($null -ne $ask) { $specs += @{ id = 2; action = 'ask'; spec = $ask } }
$capture = ConvertTo-HotkeySpec $script:Hotkeys.capture
if ($null -ne $capture) { $specs += @{ id = 3; action = 'capture'; spec = $capture } }

$ids = @(); $mods = @(); $keys = @()
foreach ($item in $specs) { $ids += $item.id; $mods += $item.spec.modifiers; $keys += $item.spec.virtualKey }

$registered = [QkShell]::Init([int[]]$ids, [int[]]$mods, [int[]]$keys)
if (-not $registered) { Write-Log 'one or more hotkeys could not be registered (already taken?)' }

$script:Actions = @{}
foreach ($item in $specs) { $script:Actions[$item.id] = $item.action }

[QkShell]::OnHotkey = [Action[int]]{
  param($id)
  try {
    $action = $script:Actions[$id]
    if (-not $action) { return }
    $script:pendingAction = $action
    # Do the work on a timer tick: sending keys from inside a WM_HOTKEY dispatch
    # is unreliable, and the hotkey's own keys may still be held.
    if ($null -eq $script:pendingTimer) {
      $script:pendingTimer = New-Object System.Windows.Forms.Timer
      $script:pendingTimer.Interval = 130
      $script:pendingTimer.Add_Tick({
          $script:pendingTimer.Stop()
          $queued = $script:pendingAction
          $script:pendingAction = ''
          if (-not $queued) { return }
          try {
            if ($queued -eq 'capture') { Invoke-Capture } else { Invoke-Pick -Action $queued }
          } catch {
            Write-Log ("deferred action failed: " + $_.Exception.Message)
          }
        })
    }
    $script:pendingTimer.Stop()
    $script:pendingTimer.Start()
  } catch {
    Write-Log ("hotkey handler failed: " + $_.Exception.Message)
  }
}

Write-Log ("shell started for " + $script:Origin + ' window=' + $script:WindowSize.Width + 'x' + $script:WindowSize.Height)
# A window left over from the previous shell keeps its old size; fix it now so a
# settings change takes effect without waiting for the next pick.
try {
  $existing = [QkShell]::Find($script:WindowTitle)
  if ($existing -ne [IntPtr]::Zero -and [QkShell]::IsWindow($existing)) {
    [QkShell]::Resize($existing, $script:WindowSize.Width, $script:WindowSize.Height)
    $script:Hwnd = $existing
    Write-Log ('existing window resized to ' + [QkShell]::WindowSize($existing))
  }
} catch {
  Write-Log ('startup resize failed: ' + $_.Exception.Message)
}
$script:clipboardTimer = Start-ClipboardWatcher
[QkShell]::Run()