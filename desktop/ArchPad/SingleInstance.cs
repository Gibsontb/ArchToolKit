using System.IO.Pipes;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace ArchPad;

/// <summary>
/// One ArchPad window per user session, like Notepad++: opening a file from
/// Explorer while ArchPad is running adds a tab instead of a second window.
///
/// A named mutex decides who is first; the first instance then listens on a
/// named pipe, and later instances write their (already absolute) file paths
/// to it as a JSON array and exit. A pipe rather than WM_COPYDATA because it
/// needs no window handle to find and survives the first window being hidden
/// or mid-startup: the client simply waits for the server to come up.
/// </summary>
internal sealed class SingleInstance : IDisposable
{
    private readonly Mutex _mutex;
    private readonly string _pipeName;
    private readonly CancellationTokenSource _stop = new();

    public bool IsFirst { get; }

    public SingleInstance()
    {
        // Per user and per logon session: two users on one machine (or one
        // user over RDP and at the console) each get their own ArchPad.
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
        var session = System.Diagnostics.Process.GetCurrentProcess().SessionId;
        var name = $"ArchPad-{sid}-{session}";
        _pipeName = name;
        _mutex = new Mutex(initiallyOwned: true, $"Local\\{name}", out var createdNew);
        IsFirst = createdNew;
    }

    /// <summary>Second instance: hand the files to the first. False when it did not answer.</summary>
    public bool Forward(IReadOnlyList<string> files)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", _pipeName, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            // The first instance may still be starting (unpacking, creating
            // WebView2) when Explorer launches a second one for a multi-file open.
            client.Connect(TimeSpan.FromSeconds(10));
            var payload = JsonSerializer.SerializeToUtf8Bytes(files);
            client.Write(payload);
            client.Flush();
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>First instance: accept forwarded paths for as long as the app runs.</summary>
    public void Listen(Action<IReadOnlyList<string>> onFiles)
    {
        var token = _stop.Token;
        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    await using var server = new NamedPipeServerStream(_pipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await server.WaitForConnectionAsync(token);
                    using var buffer = new MemoryStream();
                    await server.CopyToAsync(buffer, token);
                    var files = JsonSerializer.Deserialize<string[]>(Encoding.UTF8.GetString(buffer.ToArray())) ?? [];
                    onFiles(files);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (Exception ex)
                {
                    // A malformed message from a crashed client must not end
                    // the listener; the next launch still needs somewhere to go.
                    System.Diagnostics.Debug.WriteLine(ex);
                    await Task.Delay(200, CancellationToken.None);
                }
            }
        }, token);
    }

    public void Dispose()
    {
        _stop.Cancel();
        if (IsFirst)
        {
            try { _mutex.ReleaseMutex(); } catch (ApplicationException) { }
        }
        _mutex.Dispose();
    }
}
