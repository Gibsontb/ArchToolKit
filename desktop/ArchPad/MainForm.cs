using System.Diagnostics;
using System.Reflection;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ArchPad;

/// <summary>
/// The window: a plain frame with a WebView2 filling it. There is no native
/// menu, toolbar or status bar; the page draws all of those, so the exe and
/// the toolkit page look and behave the same.
/// </summary>
internal sealed class MainForm : Form
{
    public const string HostName = "archpad.local";
    public const string Origin = "https://" + HostName + "/";
    private const string StartUrl = Origin + "archpad/index.html";

    /// <summary>The toolkit's --bg, so the window is not a white flash before the page paints.</summary>
    private static readonly Color Background = Color.FromArgb(0x0b, 0x0f, 0x17);

    /// <summary>How long an unanswered close question blocks a second close attempt.</summary>
    private static readonly TimeSpan CloseAnswerPatience = TimeSpan.FromSeconds(8);

    private readonly string _contentFolder;
    private readonly bool _devTools;
    private readonly WebView2 _web;
    private readonly Bridge _bridge;
    private readonly WindowSettings _settings;

    private Rectangle _normalBounds;
    private bool _allowClose;
    private int _closeQuestionId;
    private int? _pendingCloseQuestion;
    private DateTime _closeAskedAt;
    private int _lastCloseId;

    private bool _fullScreen;
    private FormBorderStyle _savedBorder;
    private FormWindowState _savedState;
    private Rectangle _savedBounds;

    public MainForm(string contentFolder, IReadOnlyList<string> initialFiles, bool devTools)
    {
        _contentFolder = contentFolder;
        _devTools = devTools;

        Text = Program.AppName;
        BackColor = Background;
        KeyPreview = false;
        MinimumSize = new Size(400, 300);
        using (var icon = Assembly.GetExecutingAssembly().GetManifestResourceStream("ArchPad.ico"))
        {
            if (icon is not null) Icon = new Icon(icon);
        }

        _settings = WindowSettings.Load();
        _settings.ApplyTo(this);
        _normalBounds = Bounds;

        _web = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Background,
        };
        Controls.Add(_web);

        _bridge = new Bridge(this);
        _bridge.CloseAnswered += OnCloseAnswered;
        _bridge.OpenPaths(initialFiles);

        Load += async (_, _) => await InitializeWebViewAsync();
        Move += (_, _) => RememberNormalBounds();
        Resize += (_, _) => RememberNormalBounds();
        FormClosing += OnFormClosing;
    }

    /// <summary>Files forwarded by a second ArchPad.exe. Called on the pipe thread.</summary>
    public void OpenPathsFromOutside(IReadOnlyList<string> paths)
    {
        if (IsDisposed) return;
        BeginInvoke(() =>
        {
            _bridge.OpenPaths(paths);
            BringToFront();
            if (WindowState == FormWindowState.Minimized) WindowState = _settings.Maximized ? FormWindowState.Maximized : FormWindowState.Normal;
            Activate();
        });
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            // The profile (the page's localStorage: recent files, theme,
            // options) lives in %LOCALAPPDATA%, not next to the exe, so a
            // copy of ArchPad.exe on a USB stick or in Program Files works.
            var userData = Path.Combine(Paths.LocalData, "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            await _web.EnsureCoreWebView2Async(environment);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"ArchPad could not start its web view:\n\n{ex.Message}\n\n" +
                $"If the WebView2 Runtime is missing or damaged, reinstall it from {Program.WebView2DownloadPage}",
                Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            _allowClose = true;
            Close();
            return;
        }

        var core = _web.CoreWebView2;
        var settings = core.Settings;
        // Browser shortcuts (Ctrl+F find bar, Ctrl+P print, F5 reload, Ctrl+G)
        // belong to the editor here; only a developer asks for them back.
        settings.AreBrowserAcceleratorKeysEnabled = _devTools;
        settings.AreDevToolsEnabled = _devTools;
        settings.IsStatusBarEnabled = false;
        settings.IsGeneralAutofillEnabled = false;
        settings.IsPasswordAutosaveEnabled = false;
        settings.IsZoomControlEnabled = true;
        settings.AreDefaultContextMenusEnabled = true;

        core.SetVirtualHostNameToFolderMapping(HostName, _contentFolder, CoreWebView2HostResourceAccessKind.Allow);

        _bridge.Attach(core);
        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.ContainsFullScreenElementChanged += (_, _) => SetFullScreen(core.ContainsFullScreenElement);
        core.ProcessFailed += OnProcessFailed;
        core.NavigationCompleted += (_, _) => _web.Focus();

        // The web files change with every build but keep their URLs; drop
        // the HTTP cache so a new exe never runs yesterday's scripts.
        try
        {
            await core.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache);
        }
        catch (Exception ex)
        {
            Debug.WriteLine(ex);
        }

        core.Navigate(StartUrl);
    }

    // -----------------------------------------------------------------------
    // Navigation: the editor stays on archpad.local; links go to the browser.
    // -----------------------------------------------------------------------

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        var uri = e.Uri;
        if (uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase) || uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase))
            return;

        e.Cancel = true;
        if (Uri.TryCreate(uri, UriKind.Absolute, out var parsed))
        {
            if (parsed.IsFile)
            {
                // A file dropped on the window before the page could catch it:
                // WebView2 would navigate to it. Open it as a document instead.
                _bridge.OpenPaths([parsed.LocalPath]);
            }
            else if (parsed.Scheme is "http" or "https" or "mailto")
            {
                Shell.OpenExternal(uri);
            }
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        var uri = e.Uri;
        // Pages of our own (a print view, a blob preview) may open as popups;
        // anything else is a link for the user's browser.
        if (uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)
            || uri.StartsWith("blob:" + Origin, StringComparison.OrdinalIgnoreCase)
            || uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase))
            return;

        e.Handled = true;
        if (Uri.TryCreate(uri, UriKind.Absolute, out var parsed) && parsed.Scheme is "http" or "https" or "mailto")
            Shell.OpenExternal(uri);
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        if (e.ProcessFailedKind is not (CoreWebView2ProcessFailedKind.RenderProcessExited
            or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive
            or CoreWebView2ProcessFailedKind.BrowserProcessExited))
            return;

        _bridge.PageLost();
        BeginInvoke(() =>
        {
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                MessageBox.Show(this, "The editor's web view stopped. ArchPad will close; reopen it to continue.",
                    Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                _allowClose = true;
                Close();
                return;
            }
            var answer = MessageBox.Show(this,
                "The editor page stopped responding.\n\nReload it? Changes not yet saved in the page may be lost.",
                Program.AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (answer == DialogResult.Yes) _web.CoreWebView2?.Reload();
        });
    }

    // -----------------------------------------------------------------------
    // Closing: the page decides (it knows which tabs are unsaved).
    // -----------------------------------------------------------------------

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        // Every close reason asks, shutdown and Task Manager included: WinForms
        // reports any WM_CLOSE not sent through the system menu as
        // TaskManagerClosing, and unsaved work deserves the question either
        // way. Windows itself still ends a process that does not answer.
        if (_allowClose || !_bridge.HasPage)
        {
            SaveWindowSettings();
            return;
        }

        e.Cancel = true;

        if (_pendingCloseQuestion is not null)
        {
            // Still waiting; usually the page's own "Save changes?" dialog is
            // up. A page that never answers (broken handler) must not trap the
            // user, so a later close offers the way out, but asks first.
            if (DateTime.UtcNow - _closeAskedAt > CloseAnswerPatience)
            {
                var answer = MessageBox.Show(this,
                    "The editor has not answered the close request.\n\nClose ArchPad anyway? Unsaved changes will be lost.",
                    Program.AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                if (answer == DialogResult.Yes)
                {
                    _allowClose = true;
                    BeginInvoke(Close);
                }
            }
            return;
        }

        _lastCloseId = ++_closeQuestionId;
        _pendingCloseQuestion = _lastCloseId;
        _closeAskedAt = DateTime.UtcNow;
        _bridge.AskBeforeClose(_lastCloseId);
    }

    private void OnCloseAnswered(int id, bool close)
    {
        if (_pendingCloseQuestion != id) return;
        _pendingCloseQuestion = null;
        if (!close) return;
        _allowClose = true;
        BeginInvoke(Close);
    }

    // -----------------------------------------------------------------------
    // Window state
    // -----------------------------------------------------------------------

    private void RememberNormalBounds()
    {
        if (WindowState == FormWindowState.Normal && !_fullScreen) _normalBounds = Bounds;
    }

    private void SaveWindowSettings()
    {
        if (_fullScreen)
        {
            // Save what the window was before F11, not the full-screen frame.
            _settings.CaptureFrom(this, _savedBounds);
            _settings.Maximized = _savedState == FormWindowState.Maximized;
        }
        else
        {
            _settings.CaptureFrom(this, _normalBounds);
        }
        _settings.Save();
    }

    /// <summary>
    /// The page asks for full screen with requestFullscreen() (F11); WebView2
    /// only reports it, so the frame itself goes borderless and covers the
    /// taskbar, and comes back exactly as it was.
    /// </summary>
    private void SetFullScreen(bool on)
    {
        if (on == _fullScreen) return;
        if (on)
        {
            _savedBorder = FormBorderStyle;
            _savedState = WindowState;
            // The un-maximized size, so leaving full screen and then
            // restoring down lands where the user last had the window.
            _savedBounds = WindowState == FormWindowState.Normal ? Bounds : _normalBounds;
            _fullScreen = true;
            // Normal first: a maximized window does not re-cover the taskbar
            // when the border is removed.
            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.None;
            Bounds = Screen.FromControl(this).Bounds;
        }
        else
        {
            _fullScreen = false;
            FormBorderStyle = _savedBorder;
            WindowState = FormWindowState.Normal;
            Bounds = _savedBounds;
            WindowState = _savedState;
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _web.Dispose();
        base.Dispose(disposing);
    }
}
