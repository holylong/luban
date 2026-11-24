; Inno Setup 6 script for the luban desktop app on Windows x64.
; scripts/package-windows.mjs passes /DAppVersion, /DPayload and /DReleaseDir.
; The payload is the same tree the portable ZIP ships, so an installed copy
; behaves exactly like an extracted one: the launcher, node.exe, app/ (the CLI
; bundle) and electron/ all sit together in {app}.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Payload
  #define Payload "."
#endif
#ifndef ReleaseDir
  #define ReleaseDir "."
#endif

[Setup]
; A fixed AppId is what makes a newer setup reuse the installed directory
; instead of stacking a second copy under a different name.
AppId={{7C6A2A10-3E6B-4B4E-9B25-4F5E1C2A8D31}
AppName=luban
AppVerName=luban {#AppVersion}
AppVersion={#AppVersion}
AppPublisher=luban
AppPublisherURL=https://github.com/holylong/luban
AppSupportURL=https://github.com/holylong/luban/issues
DefaultDirName={localappdata}\Programs\luban
DefaultGroupName=luban
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#ReleaseDir}
OutputBaseFilename=luban-desktop-{#AppVersion}-win-x64-setup
SetupIconFile={#Payload}\luban.ico
UninstallDisplayIcon={app}\luban.ico
UninstallDisplayName=luban {#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
AllowNoIcons=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; The desktop shell keeps a tray icon and a local backend alive. Do not restart
; or close a running instance: an upgrade is a plain file overwrite while the
; user has already quit, and a silent install must not launch anything.
CloseApplications=no
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式(&D)"; GroupDescription: "附加任务:"; Flags: unchecked

[Files]
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\luban 工作台"; Filename: "{app}\luban-desktop.cmd"; IconFilename: "{app}\luban.ico"; Comment: "打开 luban 桌面工作台"
Name: "{group}\luban 命令行"; Filename: "{app}\luban.cmd"; IconFilename: "{app}\luban.ico"; Comment: "在终端里运行 luban"
Name: "{group}\卸载 luban"; Filename: "{uninstallexe}"
Name: "{autodesktop}\luban"; Filename: "{app}\luban-desktop.cmd"; IconFilename: "{app}\luban.ico"; Tasks: desktopicon
