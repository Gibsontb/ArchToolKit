using System.Buffers;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace ArchPad;

/// <summary>
/// The exe's half of the page/exe protocol; the page's half, and the full
/// message list, is src/archpad/host-exe.ts. In short: the page sends
/// requests (openFiles, save, saveAs, openFolder, reload) with an id and gets
/// one response per id; the exe pushes openRequest (files from outside) and
/// beforeClose (the window wants to close). File bytes travel as base64.
///
/// Everything here runs on the UI thread: WebView2 raises WebMessageReceived
/// there, PostWebMessageAsJson must be called there, and the file dialogs
/// need it. Disk reads are awaited, so a large file does not freeze the window.
/// </summary>
internal sealed class Bridge
{
    /// <summary>
    /// One file per message has to fit in one JSON string, and System.Text.Json
    /// caps a single base64 value at about 125 MB of input. 100 MB leaves room
    /// and is far past anything a text editor is pleasant to use on.
    /// </summary>
    public const long MaxOpenBytes = 100L * 1024 * 1024;

    // Find in Files limits: enough for a real project tree, small enough that
    // pointing it at C:\ by mistake comes back in seconds, not never.
    private const int FolderMaxFiles = 2000;
    private const long FolderMaxFileBytes = 5L * 1024 * 1024;
    private const long FolderMaxTotalBytes = 256L * 1024 * 1024;
    /// <summary>Folder results go out in batches of about this much, ahead of the final response.</summary>
    private const long BatchBytes = 8L * 1024 * 1024;

    private static readonly HashSet<string> SkippedFolders = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", ".svn", ".hg", ".vs", "node_modules", "__pycache__", ".terraform",
    };

    /// <summary>Extensions Find in Files never reads: they are binary, and matching inside them is noise.</summary>
    private static readonly HashSet<string> BinaryExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".dll", ".pdb", ".obj", ".o", ".a", ".lib", ".so", ".dylib", ".sys", ".msi", ".msix", ".cab", ".bin",
        ".class", ".jar", ".war", ".pyc", ".pyd", ".wasm", ".node",
        ".zip", ".7z", ".rar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".tar", ".iso", ".img", ".vhd", ".vhdx", ".vmdk", ".ova", ".ovf",
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".icns", ".tif", ".tiff", ".webp", ".heic", ".psd", ".ai",
        ".mp3", ".mp4", ".m4a", ".wav", ".flac", ".ogg", ".avi", ".mov", ".mkv", ".wmv", ".webm",
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".vsdx", ".odt", ".ods", ".pst", ".ost",
        ".ttf", ".otf", ".woff", ".woff2", ".eot", ".db", ".sqlite", ".mdb", ".accdb", ".ldf", ".mdf", ".bak",
    };

    private readonly Form _owner;
    private readonly Queue<string> _queuedOpens = new();
    private CoreWebView2? _core;
    private bool _flushing;

    /// <summary>The page's host bridge is loaded, so the page can be asked before the window closes.</summary>
    public bool HasPage { get; private set; }

    /// <summary>The page has an open-request handler; files can be delivered.</summary>
    public bool Ready { get; private set; }

    /// <summary>The page answered a beforeClose question: (id, close?).</summary>
    public event Action<int, bool>? CloseAnswered;

    public Bridge(Form owner) => _owner = owner;

    public void Attach(CoreWebView2 core)
    {
        _core = core;
        core.WebMessageReceived += OnWebMessage;
        // A reload (F5 with devtools, or after a crash) starts the handshake over.
        core.NavigationStarting += (_, _) => { HasPage = false; Ready = false; };
    }

    /// <summary>A lost renderer cannot answer anything; let the window close without asking.</summary>
    public void PageLost()
    {
        HasPage = false;
        Ready = false;
    }

    // -----------------------------------------------------------------------
    // exe -> page
    // -----------------------------------------------------------------------

    public void AskBeforeClose(int id) => Post(w =>
    {
        w.WriteString("kind", "beforeClose");
        w.WriteNumber("id", id);
    });

    /// <summary>
    /// Files from outside the page: the command line, a second instance, an
    /// Explorer drop. Held until the page says it is ready for them.
    /// </summary>
    public void OpenPaths(IEnumerable<string> paths)
    {
        foreach (var path in paths) _queuedOpens.Enqueue(path);
        if (Ready) _ = FlushOpensAsync();
    }

    private async Task FlushOpensAsync()
    {
        // One flush at a time, so files open in the order they were asked for.
        if (_flushing) return;
        _flushing = true;
        try
        {
            await FlushOpensCoreAsync();
        }
        finally
        {
            _flushing = false;
        }
    }

    private async Task FlushOpensCoreAsync()
    {
        var problems = new List<string>();
        while (Ready && _queuedOpens.Count > 0)
        {
            var path = _queuedOpens.Dequeue();
            if (Directory.Exists(path)) continue;
            try
            {
                // A path that does not exist yet opens as an empty document
                // that saves there, like "notepad new.txt".
                var bytes = File.Exists(path) ? await ReadFileAsync(path, MaxOpenBytes) : [];
                Post(w =>
                {
                    w.WriteString("kind", "openRequest");
                    w.WriteStartArray("files");
                    WriteFile(w, path, bytes);
                    w.WriteEndArray();
                });
            }
            catch (Exception ex)
            {
                problems.Add($"{path}\n    {Describe(ex)}");
            }
        }
        if (problems.Count > 0) ShowProblems("ArchPad could not open:", problems);
    }

    // -----------------------------------------------------------------------
    // page -> exe
    // -----------------------------------------------------------------------

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Only the page ArchPad serves may drive the disk.
        if (!e.Source.StartsWith(MainForm.Origin, StringComparison.OrdinalIgnoreCase)) return;

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(e.WebMessageAsJson);
        }
        catch (JsonException)
        {
            return;
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            switch (Str(root, "kind"))
            {
                case "hello":
                    HasPage = true;
                    break;
                case "ready":
                    HasPage = true;
                    Ready = true;
                    _ = FlushOpensAsync();
                    break;
                case "setTitle":
                    var title = Str(root, "title") ?? Program.AppName;
                    _owner.Text = title.Length > 260 ? title[..260] : title;
                    break;
                case "closeAnswer":
                    if (root.TryGetProperty("id", out var cid) && cid.TryGetInt32(out var closeId))
                        CloseAnswered?.Invoke(closeId, root.TryGetProperty("close", out var c) && c.ValueKind != JsonValueKind.False);
                    break;
                case "drop":
                    OpenPaths(DroppedPaths(e));
                    break;
                case "request":
                    if (!root.TryGetProperty("id", out var rid) || !rid.TryGetInt32(out var id)) return;
                    var op = Str(root, "op") ?? "";
                    var args = root.Clone();
                    // Out of the event handler first: a modal dialog opened
                    // inside WebMessageReceived re-enters WebView2.
                    _owner.BeginInvoke(async () => await HandleRequestAsync(id, op, args));
                    break;
            }
        }
    }

    private static IEnumerable<string> DroppedPaths(CoreWebView2WebMessageReceivedEventArgs e)
    {
        var objects = e.AdditionalObjects;
        if (objects is null) yield break;
        foreach (var item in objects)
        {
            if (item is CoreWebView2File file && !string.IsNullOrEmpty(file.Path)) yield return file.Path;
        }
    }

    private async Task HandleRequestAsync(int id, string op, JsonElement args)
    {
        try
        {
            switch (op)
            {
                case "openFiles": await OpenFilesAsync(id); break;
                case "save": await SaveAsync(id, args, forceDialog: false); break;
                case "saveAs": await SaveAsync(id, args, forceDialog: true); break;
                case "openFolder": await OpenFolderAsync(id); break;
                case "reload": await ReloadAsync(id, Str(args, "path")); break;
                default: RespondError(id, $"Unknown request '{op}'."); break;
            }
        }
        catch (Exception ex)
        {
            RespondError(id, Describe(ex));
        }
    }

    private async Task OpenFilesAsync(int id)
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Open",
            Multiselect = true,
            Filter = FileFilters,
            RestoreDirectory = false,
        };
        if (dialog.ShowDialog(_owner) != DialogResult.OK)
        {
            RespondNull(id);
            return;
        }

        // Each file goes out in its own message, so ten 50 MB logs never
        // have to fit in one string.
        var problems = new List<string>();
        foreach (var path in dialog.FileNames)
        {
            try
            {
                var bytes = await ReadFileAsync(path, MaxOpenBytes);
                Post(w =>
                {
                    w.WriteString("kind", "partial");
                    w.WriteNumber("id", id);
                    w.WriteStartArray("files");
                    WriteFile(w, path, bytes);
                    w.WriteEndArray();
                });
            }
            catch (Exception ex)
            {
                problems.Add($"{path}\n    {Describe(ex)}");
            }
        }
        Respond(id, w =>
        {
            w.WriteStartObject("result");
            w.WriteStartArray("files");
            w.WriteEndArray();
            w.WriteEndObject();
        });
        if (problems.Count > 0) ShowProblems("ArchPad could not open:", problems);
    }

    private async Task SaveAsync(int id, JsonElement args, bool forceDialog)
    {
        var name = Str(args, "name") ?? "new 1";
        var path = Str(args, "path");
        var data = args.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.String ? d.GetBytesFromBase64() : [];

        if (forceDialog || string.IsNullOrWhiteSpace(path))
        {
            path = AskSavePath(name, path);
            if (path is null)
            {
                RespondNull(id);
                return;
            }
        }

        await WriteFileAsync(path, data);
        Respond(id, w =>
        {
            w.WriteStartObject("result");
            w.WriteString("name", Path.GetFileName(path));
            w.WriteString("path", path);
            w.WriteEndObject();
        });
    }

    private string? AskSavePath(string name, string? currentPath)
    {
        using var dialog = new SaveFileDialog
        {
            Title = "Save As",
            Filter = FileFilters,
            FileName = SafeFileName(name),
            OverwritePrompt = true,
            AddExtension = false,
            CheckPathExists = true,
        };
        if (!string.IsNullOrWhiteSpace(currentPath))
        {
            var dir = Path.GetDirectoryName(currentPath);
            if (dir is not null && Directory.Exists(dir)) dialog.InitialDirectory = dir;
        }
        return dialog.ShowDialog(_owner) == DialogResult.OK ? dialog.FileName : null;
    }

    private async Task ReloadAsync(int id, string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            RespondNull(id);
            return;
        }
        var bytes = await ReadFileAsync(path, MaxOpenBytes);
        Respond(id, w =>
        {
            w.WritePropertyName("result");
            WriteFile(w, path, bytes);
        });
    }

    private async Task OpenFolderAsync(int id)
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Folder to search",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = false,
        };
        if (dialog.ShowDialog(_owner) != DialogResult.OK)
        {
            RespondNull(id);
            return;
        }

        var folder = dialog.SelectedPath;
        var (paths, skipped) = await Task.Run(() => ListFolder(folder));

        var batch = new List<(string Path, byte[] Bytes)>();
        long batchBytes = 0, total = 0;
        var sent = 0;
        var truncated = paths.Count >= FolderMaxFiles;

        void Flush()
        {
            if (batch.Count == 0) return;
            var files = batch.ToArray();
            batch.Clear();
            batchBytes = 0;
            Post(w =>
            {
                w.WriteString("kind", "partial");
                w.WriteNumber("id", id);
                w.WriteStartArray("files");
                foreach (var (p, b) in files) WriteFile(w, p, b);
                w.WriteEndArray();
            });
        }

        foreach (var path in paths)
        {
            byte[] bytes;
            try
            {
                bytes = await ReadFileAsync(path, FolderMaxFileBytes);
            }
            catch
            {
                skipped++;
                continue;
            }
            if (total + bytes.Length > FolderMaxTotalBytes)
            {
                truncated = true;
                break;
            }
            total += bytes.Length;
            batch.Add((path, bytes));
            batchBytes += bytes.Length;
            sent++;
            if (batchBytes >= BatchBytes) Flush();
        }
        Flush();

        Respond(id, w =>
        {
            w.WriteStartObject("result");
            w.WriteString("name", Path.GetFileName(folder.TrimEnd('\\')) is { Length: > 0 } n ? n : folder);
            w.WriteString("path", folder);
            // Not in the Host contract; there for a page that wants to say
            // "first 2000 files" instead of implying it searched everything.
            w.WriteNumber("count", sent);
            w.WriteNumber("skipped", skipped);
            w.WriteBoolean("truncated", truncated);
            w.WriteEndObject();
        });
    }

    /// <summary>
    /// Walk the folder breadth-first, so a cap cuts off the deepest files
    /// rather than whole top-level folders. Links are not followed (a junction
    /// loop would never end) and hidden/system folders are left out.
    /// </summary>
    private static (List<string> Paths, int Skipped) ListFolder(string folder)
    {
        var paths = new List<string>();
        var skipped = 0;
        var options = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint | FileAttributes.System,
            RecurseSubdirectories = false,
        };
        var pending = new Queue<string>();
        pending.Enqueue(folder);
        while (pending.Count > 0 && paths.Count < FolderMaxFiles)
        {
            var dir = pending.Dequeue();
            try
            {
                foreach (var file in Directory.EnumerateFiles(dir, "*", options).Order(StringComparer.OrdinalIgnoreCase))
                {
                    if (BinaryExtensions.Contains(Path.GetExtension(file)))
                    {
                        skipped++;
                        continue;
                    }
                    FileInfo info;
                    try { info = new FileInfo(file); } catch { skipped++; continue; }
                    if (info.Length > FolderMaxFileBytes)
                    {
                        skipped++;
                        continue;
                    }
                    paths.Add(file);
                    if (paths.Count >= FolderMaxFiles) break;
                }
                foreach (var sub in Directory.EnumerateDirectories(dir, "*", options).Order(StringComparer.OrdinalIgnoreCase))
                {
                    var name = Path.GetFileName(sub);
                    if (SkippedFolders.Contains(name)) continue;
                    if ((File.GetAttributes(sub) & FileAttributes.Hidden) != 0) continue;
                    pending.Enqueue(sub);
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        return (paths, skipped);
    }

    // -----------------------------------------------------------------------
    // Disk
    // -----------------------------------------------------------------------

    /// <summary>
    /// Read a whole file, sharing it with whoever else has it open: the log
    /// a service is still writing is exactly the file people open in an editor.
    /// </summary>
    public static async Task<byte[]> ReadFileAsync(string path, long maxBytes)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete, bufferSize: 1, useAsync: true);
        if (stream.Length > maxBytes)
            throw new IOException($"The file is {stream.Length / (1024.0 * 1024.0):0.#} MB; ArchPad opens files up to {maxBytes / (1024 * 1024)} MB.");
        var bytes = new byte[stream.Length];
        var read = 0;
        while (read < bytes.Length)
        {
            var n = await stream.ReadAsync(bytes.AsMemory(read));
            if (n == 0) break;
            read += n;
        }
        // The file shrank while we read it (a rotating log); keep what exists.
        return read == bytes.Length ? bytes : bytes[..read];
    }

    /// <summary>
    /// Write in place, like Notepad++: the file keeps its identity, ACLs,
    /// hard links and creation time. OpenOrCreate rather than Create because
    /// Create refuses to overwrite a hidden file.
    /// </summary>
    private static async Task WriteFileAsync(string path, byte[] bytes)
    {
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReadOnly) != 0)
            throw new IOException($"{path} is read-only. Clear the read-only attribute or use Save As.");
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        await using var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read,
            bufferSize: 1, useAsync: true);
        await stream.WriteAsync(bytes);
        stream.SetLength(bytes.Length);
        await stream.FlushAsync();
    }

    private static string Describe(Exception ex) => ex switch
    {
        UnauthorizedAccessException => $"{ex.Message} (ArchPad runs without administrator rights; save elsewhere, or start it as administrator.)",
        _ => ex.Message,
    };

    private static string SafeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var clean = new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray()).Trim();
        return clean.Length > 0 ? clean : "new 1";
    }

    private const string FileFilters =
        "All files (*.*)|*.*|" +
        "Text (*.txt;*.log;*.md)|*.txt;*.log;*.md;*.markdown|" +
        "Config (*.json;*.yaml;*.xml;*.ini;*.toml;*.conf)|*.json;*.jsonc;*.yaml;*.yml;*.xml;*.ini;*.cfg;*.conf;*.config;*.toml;*.properties;*.env|" +
        "Scripts (*.ps1;*.sh;*.py;*.bat;*.cmd)|*.ps1;*.psm1;*.psd1;*.sh;*.bash;*.py;*.bat;*.cmd;*.vbs|" +
        "Web (*.html;*.css;*.js;*.ts)|*.html;*.htm;*.css;*.scss;*.js;*.mjs;*.cjs;*.ts;*.tsx;*.jsx|" +
        "Code (*.c;*.cpp;*.cs;*.java;*.go;*.rs;*.sql)|*.c;*.h;*.cpp;*.hpp;*.cs;*.java;*.go;*.rs;*.sql;*.php;*.rb;*.pl;*.lua|" +
        "Infrastructure (*.tf;*.hcl;*.j2;Dockerfile)|*.tf;*.tfvars;*.hcl;*.j2;Dockerfile;*.dockerfile;*.nginx";

    private void ShowProblems(string heading, List<string> problems)
    {
        var shown = problems.Take(10).ToList();
        var more = problems.Count - shown.Count;
        var text = heading + "\n\n" + string.Join("\n\n", shown) + (more > 0 ? $"\n\n...and {more} more." : "");
        MessageBox.Show(_owner, text, Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    // -----------------------------------------------------------------------
    // JSON
    // -----------------------------------------------------------------------

    private static string? Str(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static void WriteFile(Utf8JsonWriter w, string path, byte[] bytes)
    {
        w.WriteStartObject();
        w.WriteString("name", Path.GetFileName(path));
        w.WriteString("path", path);
        // WriteBase64String emits the base64 alphabet as-is (no \u002B for
        // '+'), which keeps a big file's message as small as base64 allows.
        w.WriteBase64String("data", bytes);
        if (File.Exists(path))
            w.WriteNumber("lastModified", new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds());
        w.WriteEndObject();
    }

    private void Respond(int id, Action<Utf8JsonWriter> body) => Post(w =>
    {
        w.WriteString("kind", "response");
        w.WriteNumber("id", id);
        w.WriteBoolean("ok", true);
        body(w);
    });

    private void RespondNull(int id) => Respond(id, w => w.WriteNull("result"));

    private void RespondError(int id, string error) => Post(w =>
    {
        w.WriteString("kind", "response");
        w.WriteNumber("id", id);
        w.WriteBoolean("ok", false);
        w.WriteString("error", error);
    });

    private void Post(Action<Utf8JsonWriter> body)
    {
        if (_core is null) return;
        var buffer = new ArrayBufferWriter<byte>();
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            body(w);
            w.WriteEndObject();
        }
        try
        {
            _core.PostWebMessageAsJson(Encoding.UTF8.GetString(buffer.WrittenSpan));
        }
        catch (Exception ex)
        {
            // The renderer went away between the request and the answer.
            System.Diagnostics.Debug.WriteLine(ex);
        }
    }
}
