using System.Text.Json;

namespace ArchPad;

/// <summary>
/// Window size and position, kept in %APPDATA%\ArchPad\settings.json.
/// Everything the editor itself remembers (recent files, theme, word wrap)
/// lives in the page's own storage; this is only what the page cannot know.
/// </summary>
internal sealed class WindowSettings
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; } = 1200;
    public int Height { get; set; } = 800;
    public bool Maximized { get; set; }
    public bool HasPosition { get; set; }

    private static string FilePath => Path.Combine(Paths.RoamingData, "settings.json");

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public static WindowSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<WindowSettings>(File.ReadAllText(FilePath)) ?? new WindowSettings();
        }
        catch
        {
            // A damaged settings file costs the user their window position,
            // never the ability to start.
        }
        return new WindowSettings();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Paths.RoamingData);
            var temp = FilePath + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(this, Json));
            File.Move(temp, FilePath, overwrite: true);
        }
        catch
        {
        }
    }

    /// <summary>Put the form where it was, unless that spot is off every screen now (a monitor was unplugged).</summary>
    public void ApplyTo(Form form)
    {
        var size = new Size(Math.Max(Width, 400), Math.Max(Height, 300));
        if (HasPosition)
        {
            var bounds = new Rectangle(new Point(X, Y), size);
            // At least a grab-able strip of the title bar must be on a screen.
            var titleBar = new Rectangle(bounds.X + 40, bounds.Y, Math.Max(bounds.Width - 80, 40), 30);
            if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(titleBar)))
            {
                form.StartPosition = FormStartPosition.Manual;
                form.Bounds = bounds;
            }
            else
            {
                form.StartPosition = FormStartPosition.CenterScreen;
                form.Size = size;
            }
        }
        else
        {
            form.StartPosition = FormStartPosition.CenterScreen;
            form.Size = size;
        }
        if (Maximized) form.WindowState = FormWindowState.Maximized;
    }

    /// <summary>Record the normal (un-maximized) bounds, so restoring after a maximized session goes back to the right size.</summary>
    public void CaptureFrom(Form form, Rectangle normalBounds)
    {
        Maximized = form.WindowState == FormWindowState.Maximized;
        X = normalBounds.X;
        Y = normalBounds.Y;
        Width = normalBounds.Width;
        Height = normalBounds.Height;
        HasPosition = true;
    }
}
