# ArchPad.exe

ArchPad as a Windows desktop app. It is the same editor as the ArchPad page in
ArchToolKit: a WinForms window with a WebView2 control that fills it and runs
the toolkit's web code. The web UI draws the menus, tabs and status bar, so the
window has no native menu. The C# side handles only what a page can't:
file dialogs, reading and writing files by path, the window, and Explorer
integration.

```
desktop/ArchPad/
  Program.cs          entry point: switches, single instance, WebView2 runtime check
  MainForm.cs         the window, WebView2 setup, navigation, close handshake, F11 full screen
  Bridge.cs           the page <-> exe message protocol (C# half)
  SingleInstance.cs   named mutex + named pipe, so a second launch opens its files in the first window
  AppContent.cs       unpacks the embedded web files to %LOCALAPPDATA%\ArchPad\app\<hash>
  WindowSettings.cs   window size/position in %APPDATA%\ArchPad\settings.json
  Registration.cs     --register / --unregister (per-user "Open with")
  ArchPad.ico         app icon; tools/make-icon.ps1 redraws it
  build.ps1           toolkit build + single-file publish
```

The page's half of the protocol is `src/archpad/host-exe.ts`, which exports
`createExeHost()` (the `Host` from `src/archpad/types.ts`). Its header comment
lists every message.

## Build

Requirements: .NET 10 SDK, Node 22.6+ (for the toolkit build), and network
access to nuget.org the first time (for `Microsoft.Web.WebView2` and the
win-x64 runtime pack). `nuget.config` in this folder points at nuget.org.

```powershell
pwsh desktop/ArchPad/build.ps1            # node tools/build.mjs, then dotnet publish
pwsh desktop/ArchPad/build.ps1 -SkipWeb   # web/lib is already current
pwsh desktop/ArchPad/build.ps1 -Runtime win-arm64
```

The result is `desktop/ArchPad/publish/ArchPad.exe`, about 50 MB. It is
self-contained (it doesn't need a .NET install) and single-file, and it
already holds the web files, so you can copy that one file anywhere.

`build.ps1` runs:

```powershell
node tools/build.mjs
dotnet publish desktop/ArchPad/ArchPad.csproj -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o desktop/ArchPad/publish
```

Any build of the project (`dotnet build` too) runs the `ArchPadStageWeb`
target. The target copies `web/archpad`, `web/lib` (all of it) and
`web/styles` into `obj/webstage`, zips them, and embeds the zip. If
`web/archpad/index.html` is missing, the exe still builds and shows a
placeholder page.

## Run

```powershell
ArchPad.exe                          # empty editor
ArchPad.exe notes.txt C:\logs\a.log  # open files; a path that doesn't exist opens empty and saves there
ArchPad.exe --devtools               # F12 DevTools and browser shortcuts (F5 reload, etc.)
ArchPad.exe --content E:\Repos\ArchToolKit\web   # serve the repo's web/ directly (edit, rebuild toolkit, F5)
```

- On first run, the embedded web files are unpacked to
  `%LOCALAPPDATA%\ArchPad\app\<hash>`, which the page serves as
  `https://archpad.local/`. A rebuilt exe unpacks to a new folder, and old
  folders are removed. If an `app` folder with `archpad\index.html` sits
  next to the exe, ArchPad serves that folder instead. This is the folder
  layout for development.
- The WebView2 profile, which holds the page's localStorage (recent files,
  options), is in `%LOCALAPPDATA%\ArchPad\WebView2`. The window position is in
  `%APPDATA%\ArchPad\settings.json`.
- Only one window runs per user session. Launching ArchPad again, for example
  "Open with" on more files, sends the files to the running window and
  exits.
- Files dragged from Explorer onto the window open with their full paths,
  so Save writes back to the same file.
- Closing the window asks the page first. The page can keep the window open
  when it has unsaved changes. If the page never answers, a later close
  offers to close anyway.
- F11 full screen: the page calls `requestFullscreen()`, and the window goes
  borderless to cover the taskbar.
- Links to other sites open in the default browser. The WebView2 never
  leaves `archpad.local`.

### WebView2 runtime

WebView2 is part of Windows 11. On Windows 10 without it, ArchPad says so and
offers to open the download page:
<https://developer.microsoft.com/microsoft-edge/webview2/> (the Evergreen
Bootstrapper or Standalone Installer).

### Limits

- Opening a file: 100 MB. Each file travels to the page as base64 in one
  WebView2 message.
- Open Folder (Find in Files): up to 2000 files, 5 MB each, 256 MB total.
  Binary types (images, archives, executables, Office files and similar) are
  skipped, as are `.git`, `node_modules` and similar folders, hidden folders,
  and links.

## Explorer integration (optional, per user)

```powershell
ArchPad.exe --register     # adds "Edit with ArchPad" to every file's context menu and lists ArchPad under "Open with"
ArchPad.exe --unregister   # removes all of it
```

The switches write only under `HKCU\Software\Classes`, so they need no
administrator rights and change nothing for other users:

- `*\shell\ArchPad`: the "Edit with ArchPad" verb, with its command.
- `Applications\ArchPad.exe`: the name, icon and open command that "Open
  with" uses.
- `.txt`, `.log`, `.json`, `.yaml`, ... `\OpenWithList\ArchPad.exe`:
  lists ArchPad under "Open with" for common text types.

ArchPad never becomes the default program for a type. The registry stores the
exe's current path, so run `--register` again after you move the exe.
