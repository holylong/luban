; Inno Setup 6 script for every luban Windows x64 package.
;
; scripts/package-windows.mjs passes /DAppVersion, /DPayload, /DReleaseDir and
; /DKind=cli|desktop|creator. All three install the same portable payload into
; their own per-user directory with their own AppId, so a machine can hold the
; CLI, the desktop workspace and Creator side by side, and a newer setup
; upgrades in place instead of stacking a second copy.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Payload
  #define Payload "."
#endif
#ifndef ReleaseDir
  #define ReleaseDir "."
#endif
#ifndef Kind
  #define Kind "desktop"
#endif

#if Kind == "cli"
  #define AppId "{{5D2B9C40-9A31-4C6E-8F2B-1C7E4A6D0B21}"
  #define DirName "luban-cli"
  #define Title "luban CLI"
  #define SetupBase "luban-cli-" + AppVersion + "-win-x64-setup"
  #define Launcher "luban.cmd"
  #define LauncherDesc "在终端里运行 luban"
  #define OnPath "yes"
#elif Kind == "creator"
  #define AppId "{{5D2B9C40-9A31-4C6E-8F2B-1C7E4A6D0B22}"
  #define DirName "luban-creator"
  #define Title "luban Creator"
  #define SetupBase "luban-creator-" + AppVersion + "-win-x64-setup"
  #define Launcher "luban-creator.cmd"
  #define LauncherDesc "打开 luban Creator"
  #define OnPath "no"
#else
  #define AppId "{{7C6A2A10-3E6B-4B4E-9B25-4F5E1C2A8D31}"
  #define DirName "luban"
  #define Title "luban"
  #define SetupBase "luban-desktop-" + AppVersion + "-win-x64-setup"
  #define Launcher "luban-desktop.cmd"
  #define LauncherDesc "打开 luban 桌面工作台"
  #define OnPath "no"
#endif

[Setup]
; A fixed AppId is what makes a newer setup reuse the installed directory
; instead of creating a second copy under a different name.
AppId={#AppId}
AppName={#Title}
AppVerName={#Title} {#AppVersion}
AppVersion={#AppVersion}
AppPublisher=luban
AppPublisherURL=https://github.com/holylong/luban
AppSupportURL=https://github.com/holylong/luban/issues
DefaultDirName={localappdata}\Programs\{#DirName}
DefaultGroupName={#Title}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#ReleaseDir}
OutputBaseFilename={#SetupBase}
SetupIconFile={#Payload}\luban.ico
UninstallDisplayIcon={app}\luban.ico
UninstallDisplayName={#Title} {#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
AllowNoIcons=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; The CLI registers its directory on PATH; the GUI variants do not.
ChangesEnvironment={#OnPath}
; The desktop workspace and Creator keep a tray icon and a local backend alive.
; Do not restart or close a running instance: an upgrade is a plain file
; overwrite after the user quit, and a silent install must launch nothing.
CloseApplications=no
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式(&D)"; GroupDescription: "附加任务:"; Flags: unchecked

[Files]
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#Title}"; Filename: "{app}\{#Launcher}"; IconFilename: "{app}\luban.ico"; Comment: "{#LauncherDesc}"
#if Launcher != "luban.cmd"
Name: "{group}\luban 命令行"; Filename: "{app}\luban.cmd"; IconFilename: "{app}\luban.ico"; Comment: "在终端里运行 luban"
#endif
Name: "{group}\卸载 {#Title}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#Title}"; Filename: "{app}\{#Launcher}"; IconFilename: "{app}\luban.ico"; Tasks: desktopicon

#if Kind == "cli"
[Code]
const
  EnvironmentKey = 'Environment';

procedure AddToPath();
var
  Paths: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Paths) then
    Paths := '';
  if Pos(';' + Uppercase(ExpandConstant('{app}')) + ';', ';' + Uppercase(Paths) + ';') > 0 then
    Exit;
  if (Paths <> '') and (Paths[Length(Paths)] <> ';') then
    Paths := Paths + ';';
  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Paths + ExpandConstant('{app}'));
end;

procedure RemoveFromPath();
var
  Paths, Remaining, Segment: string;
  Separator: Integer;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Paths) then
    Exit;
  Remaining := '';
  while Paths <> '' do
  begin
    Separator := Pos(';', Paths);
    if Separator = 0 then
    begin
      Segment := Paths;
      Paths := '';
    end
    else
    begin
      Segment := Copy(Paths, 1, Separator - 1);
      Paths := Copy(Paths, Separator + 1, Length(Paths));
    end;
    if (Segment <> '') and (Uppercase(Segment) <> Uppercase(ExpandConstant('{app}'))) then
    begin
      if Remaining <> '' then
        Remaining := Remaining + ';';
      Remaining := Remaining + Segment;
    end;
  end;
  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Remaining);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddToPath();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveFromPath();
end;
#endif
