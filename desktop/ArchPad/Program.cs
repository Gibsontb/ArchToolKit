using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;

namespace ArchPad;

/// <summary>
/// Entry point. Order matters: registration switches never open a window,
/// a second instance hands its files to the first and leaves before any
/// WebView2 work, and the runtime check comes before the form so a missing
/// WebView2 is a clear message rather than a blank window.
/// </summary>
internal static class Program
{
    public const string AppName = "ArchPad";
    public const string WebView2DownloadPage = "https://developer.microsoft.com/microsoft-edge/webview2/";

    [STAThread]
    private static int Main(string[] args)
    {
        var options = CommandLine.Parse(args);

        if (options.Register || options.Unregister)
        {
            return Registration.Run(options.Register);
        }

        ApplicationConfiguration.Initialize();

        using var instance = new SingleInstance();
        if (!instance.IsFirst)
        {
            // Let the first instance come to the front: only the process the
            // user just started has the right to change the foreground window.
            AllowSetForegroundWindow(ASFW_ANY);
            if (instance.Forward(options.Files)) return 0;
            // The first instance did not answer (hung or closing); fall
            // through and run as a window of our own rather than lose the files.
        }

        if (!WebView2RuntimeAvailable()) return 1;

        string contentFolder;
        try
        {
            contentFolder = options.ContentFolder ?? AppContent.Prepare();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"ArchPad could not unpack its editor files:\n\n{ex.Message}", AppName,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        using var form = new MainForm(contentFolder, options.Files, options.DevTools);
        if (instance.IsFirst) instance.Listen(form.OpenPathsFromOutside);
        Application.Run(form);
        return 0;
    }

    /// <summary>
    /// Windows 11 ships the Evergreen WebView2 runtime; older or stripped
    /// installs may not have it, and without it there is nothing to show.
    /// </summary>
    private static bool WebView2RuntimeAvailable()
    {
        try
        {
            var version = CoreWebView2Environment.GetAvailableBrowserVersionString();
            if (!string.IsNullOrEmpty(version)) return true;
        }
        catch (WebView2RuntimeNotFoundException)
        {
        }
        catch (Exception ex)
        {
            Debug.WriteLine(ex);
        }

        var answer = MessageBox.Show(
            "ArchPad needs the Microsoft Edge WebView2 Runtime, which is not installed on this computer.\n\n" +
            "It is part of Windows 11 and a free download for Windows 10 (the \"Evergreen Bootstrapper\" or " +
            "\"Evergreen Standalone Installer\").\n\n" +
            $"Open the download page now?\n{WebView2DownloadPage}",
            AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (answer == DialogResult.Yes) Shell.OpenExternal(WebView2DownloadPage);
        return false;
    }

    private const int ASFW_ANY = -1;

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(int processId);
}

/// <summary>The switches ArchPad understands; everything else is a file to open.</summary>
internal sealed record CommandLine(
    IReadOnlyList<string> Files,
    bool Register,
    bool Unregister,
    bool DevTools,
    string? ContentFolder)
{
    public static CommandLine Parse(string[] args)
    {
        var files = new List<string>();
        bool register = false, unregister = false, devTools = false;
        string? content = null;

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            switch (arg.ToLowerInvariant())
            {
                case "--register": register = true; continue;
                case "--unregister": unregister = true; continue;
                case "--devtools": devTools = true; continue;
                case "--content" when i + 1 < args.Length:
                    // Developer switch: serve the repo's web/ folder directly so a
                    // toolkit rebuild shows up on F5 without rebuilding the exe.
                    content = Path.GetFullPath(args[++i]);
                    continue;
                case "--":
                    files.AddRange(args.Skip(i + 1).Select(ToFullPath));
                    i = args.Length;
                    continue;
            }
            files.Add(ToFullPath(arg));
        }

        return new CommandLine(files, register, unregister, devTools, content);
    }

    // Relative paths are resolved here, in the process whose current
    // directory they are relative to, before they are forwarded anywhere.
    private static string ToFullPath(string path)
    {
        try
        {
            return Path.GetFullPath(path.Trim('"'));
        }
        catch
        {
            return path;
        }
    }
}

internal static class Shell
{
    /// <summary>Open a URL or document with its default handler (the user's browser for links).</summary>
    public static void OpenExternal(string target)
    {
        try
        {
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Debug.WriteLine(ex);
        }
    }
}
