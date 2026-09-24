using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;

namespace ArchPad;

/// <summary>
/// The editor's web files (web/archpad, web/lib, web/styles) travel inside
/// the exe as one zip resource so ArchPad.exe can be copied anywhere on its
/// own. WebView2 serves from a folder, so the zip is unpacked once per build
/// into %LOCALAPPDATA%\ArchPad\app\&lt;hash of the zip&gt;.
///
/// Keying the folder on the content hash (not the exe version) means a
/// rebuilt exe with new web files never serves stale ones, an unchanged one
/// never unpacks twice, and a newer exe never has to delete a folder an older
/// running copy might still be serving from.
/// </summary>
internal static class AppContent
{
    private const string ResourceName = "ArchPad.app.zip";

    /// <summary>The folder to map to https://archpad.local/.</summary>
    public static string Prepare()
    {
        // Developer layout: an 'app' folder next to the exe wins, so the web
        // files can be swapped without rebuilding.
        var beside = Path.Combine(AppContext.BaseDirectory, "app");
        if (File.Exists(Path.Combine(beside, "archpad", "index.html"))) return beside;

        using var zip = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException("The exe was built without its web files (resource ArchPad.app.zip).");

        var hash = Convert.ToHexString(SHA256.HashData(zip))[..16].ToLowerInvariant();
        zip.Position = 0;

        var root = Path.Combine(Paths.LocalData, "app");
        var target = Path.Combine(root, hash);
        var marker = Path.Combine(target, ".complete");
        if (File.Exists(marker)) return target;

        // Unpack beside the target and rename into place, so a crash or a
        // full disk halfway through never leaves a folder that looks finished.
        Directory.CreateDirectory(root);
        var staging = Path.Combine(root, $"{hash}.{Environment.ProcessId}.tmp");
        if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
        ZipFile.ExtractToDirectory(zip, staging);
        File.WriteAllText(Path.Combine(staging, ".complete"), DateTime.UtcNow.ToString("O"));

        if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
        Directory.Move(staging, target);

        CleanUpOldVersions(root, hash);
        return target;
    }

    /// <summary>Best effort: earlier builds' folders go, unless something still has them open.</summary>
    private static void CleanUpOldVersions(string root, string keep)
    {
        foreach (var dir in Directory.EnumerateDirectories(root))
        {
            if (string.Equals(Path.GetFileName(dir), keep, StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                Directory.Delete(dir, recursive: true);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}

/// <summary>Where ArchPad keeps things per user.</summary>
internal static class Paths
{
    /// <summary>%LOCALAPPDATA%\ArchPad: unpacked web files and the WebView2 profile (machine-local, can be large).</summary>
    public static string LocalData => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Program.AppName);

    /// <summary>%APPDATA%\ArchPad: settings that roam with the user.</summary>
    public static string RoamingData => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Program.AppName);
}
