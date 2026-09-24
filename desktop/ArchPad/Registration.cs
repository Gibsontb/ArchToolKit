using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace ArchPad;

/// <summary>
/// ArchPad.exe --register / --unregister: per-user Explorer integration.
///
/// Everything goes under HKCU\Software\Classes, so no administrator rights are
/// needed and nothing changes for other users. ArchPad never takes over a
/// file type's default program; it only adds itself where the user can pick
/// it:
///   *\shell\ArchPad                       "Edit with ArchPad" on every file's context menu
///   Applications\ArchPad.exe              how Windows names and starts it in "Open with"
///   .ext\OpenWithList\ArchPad.exe         listed under "Open with" for common text types
///
/// The paths written are this exe's current location, so run --register
/// again after moving the exe.
/// </summary>
internal static class Registration
{
    private const string Classes = @"Software\Classes";
    private const string VerbKey = @"Software\Classes\*\shell\ArchPad";
    private const string AppKey = @"Software\Classes\Applications\ArchPad.exe";

    /// <summary>Types that get ArchPad in their "Open with" list. Everything else still has the context-menu verb.</summary>
    private static readonly string[] TextExtensions =
    [
        ".txt", ".log", ".md", ".markdown", ".ini", ".cfg", ".conf", ".config", ".json", ".jsonc", ".xml", ".yaml", ".yml",
        ".toml", ".csv", ".tsv", ".properties", ".env", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".scss",
        ".html", ".htm", ".py", ".ps1", ".psm1", ".psd1", ".sh", ".bash", ".bat", ".cmd", ".sql", ".cs", ".java", ".go",
        ".rs", ".c", ".h", ".cpp", ".hpp", ".php", ".rb", ".pl", ".lua", ".tf", ".tfvars", ".hcl", ".j2", ".diff", ".patch",
        ".nginx", ".dockerfile", ".gitignore", ".gitattributes", ".editorconfig", ".reg", ".vbs",
    ];

    public static int Run(bool register)
    {
        var console = AttachConsole(ATTACH_PARENT_PROCESS);
        try
        {
            var exe = Environment.ProcessPath ?? throw new InvalidOperationException("Cannot tell where ArchPad.exe is.");
            if (register) Register(exe); else Unregister();
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, IntPtr.Zero, IntPtr.Zero);
            Report(console, register
                ? $"ArchPad is registered for this user.\n\"Edit with ArchPad\" is on the context menu of every file, and ArchPad is listed under Open with.\n\nExe: {exe}"
                : "ArchPad's Explorer entries were removed for this user.", error: false);
            return 0;
        }
        catch (Exception ex)
        {
            Report(console, $"ArchPad could not {(register ? "register" : "unregister")}: {ex.Message}", error: true);
            return 1;
        }
    }

    private static void Register(string exe)
    {
        var command = $"\"{exe}\" \"%1\"";
        var icon = $"\"{exe}\",0";

        using (var verb = Registry.CurrentUser.CreateSubKey(VerbKey))
        {
            verb.SetValue("", "Edit with ArchPad");
            verb.SetValue("Icon", icon);
        }
        using (var cmd = Registry.CurrentUser.CreateSubKey(VerbKey + @"\command"))
        {
            cmd.SetValue("", command);
        }

        using (var app = Registry.CurrentUser.CreateSubKey(AppKey))
        {
            app.SetValue("FriendlyAppName", "ArchPad");
        }
        using (var defaultIcon = Registry.CurrentUser.CreateSubKey(AppKey + @"\DefaultIcon"))
        {
            defaultIcon.SetValue("", icon);
        }
        using (var open = Registry.CurrentUser.CreateSubKey(AppKey + @"\shell\open\command"))
        {
            open.SetValue("", command);
        }
        using (var types = Registry.CurrentUser.CreateSubKey(AppKey + @"\SupportedTypes"))
        {
            foreach (var ext in TextExtensions) types.SetValue(ext, "");
        }

        foreach (var ext in TextExtensions)
        {
            using var list = Registry.CurrentUser.CreateSubKey($@"{Classes}\{ext}\OpenWithList\ArchPad.exe");
        }
    }

    private static void Unregister()
    {
        Registry.CurrentUser.DeleteSubKeyTree(VerbKey, throwOnMissingSubKey: false);
        Registry.CurrentUser.DeleteSubKeyTree(AppKey, throwOnMissingSubKey: false);
        foreach (var ext in TextExtensions)
        {
            var listKey = $@"{Classes}\{ext}\OpenWithList";
            Registry.CurrentUser.DeleteSubKeyTree($@"{listKey}\ArchPad.exe", throwOnMissingSubKey: false);
            // Remove only what --register created: an OpenWithList (and the
            // extension key above it) that is now empty. Anything another
            // program put there stays.
            DeleteIfEmpty(listKey);
            DeleteIfEmpty($@"{Classes}\{ext}");
        }
    }

    private static void DeleteIfEmpty(string path)
    {
        using (var key = Registry.CurrentUser.OpenSubKey(path))
        {
            if (key is null || key.SubKeyCount > 0 || key.ValueCount > 0) return;
        }
        Registry.CurrentUser.DeleteSubKey(path, throwOnMissingSubKey: false);
    }

    /// <summary>ArchPad is a GUI exe: print to the terminal that started it, or show a box when started from Explorer.</summary>
    private static void Report(bool console, string message, bool error)
    {
        if (console)
        {
            var writer = error ? Console.Error : Console.Out;
            writer.WriteLine();
            writer.WriteLine(message);
            return;
        }
        MessageBox.Show(message, Program.AppName, MessageBoxButtons.OK, error ? MessageBoxIcon.Error : MessageBoxIcon.Information);
    }

    private const int ATTACH_PARENT_PROCESS = -1;
    private const int SHCNE_ASSOCCHANGED = 0x08000000;
    private const uint SHCNF_IDLIST = 0x0000;

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachConsole(int processId);

    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
}
