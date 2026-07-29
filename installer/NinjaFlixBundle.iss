#define BundleVersion "1.1.08"
#define BundleFileVersion "1.1.8.0"
#define AdsPowerVersion "8.6.3"
#define AdsPowerInstaller "AdsPower-Global-8.6.3-x64.exe"
#define NinjaExecutable "Ninjaflix Painel.exe"

[Setup]
AppId={{E38F7381-1A52-4CC9-BA89-31C05631AC51}
AppName=Ninjaflix Painel + AdsPower
AppVersion={#BundleVersion}
AppVerName=Ninjaflix Painel {#BundleVersion} + AdsPower {#AdsPowerVersion}
AppPublisher=NinjaFlix
DefaultDirName={autopf}\Ninjaflix Painel
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist-bundle
OutputBaseFilename=NinjaFlixCompletoSetup-{#BundleVersion}
SetupIconFile=..\build\icon.ico
Uninstallable=yes
CreateUninstallRegKey=yes
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern dynamic windows11
WizardSizePercent=110
VersionInfoVersion={#BundleFileVersion}
VersionInfoCompany=NinjaFlix
VersionInfoDescription=Instalador completo do Ninjaflix Painel e AdsPower
VersionInfoProductName=Ninjaflix Painel
VersionInfoProductVersion={#BundleVersion}
MinVersion=10.0.17763
CloseApplications=no
RestartApplications=no

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "..\adspower_exe\{#AdsPowerInstaller}"; DestDir: "{tmp}"; Flags: deleteafterinstall ignoreversion
Source: "..\dist-electron\win-unpacked\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{commondesktop}\Ninjaflix Painel"; Filename: "{app}\{#NinjaExecutable}"; WorkingDir: "{app}"; IconFilename: "{app}\resources\icon.ico"
Name: "{commonprograms}\Ninjaflix Painel"; Filename: "{app}\{#NinjaExecutable}"; WorkingDir: "{app}"; IconFilename: "{app}\resources\icon.ico"

[Run]
Filename: "{tmp}\{#AdsPowerInstaller}"; Parameters: "/S"; StatusMsg: "Instalando AdsPower {#AdsPowerVersion}..."; Flags: waituntilterminated runhidden; Check: ShouldInstallAdsPower; AfterInstall: RemoveAdsPowerDesktopShortcuts
Filename: "{app}\{#NinjaExecutable}"; Description: "Abrir Ninjaflix Painel"; Flags: nowait postinstall skipifsilent

[Code]
function ShouldInstallAdsPower: Boolean;
begin
  Result :=
    not FileExists(ExpandConstant('{commonpf64}\AdsPower Global\AdsPower Global.exe')) and
    not FileExists(ExpandConstant('{commonpf32}\AdsPower Global\AdsPower Global.exe')) and
    not FileExists(ExpandConstant('{localappdata}\AdsPower Global\AdsPower Global.exe'));
end;

procedure RemoveAdsPowerDesktopShortcuts;
begin
  DelTree(ExpandConstant('{commondesktop}\AdsPower*.lnk'), False, True, False);
  DelTree(ExpandConstant('{userdesktop}\AdsPower*.lnk'), False, True, False);
  DeleteFile(ExpandConstant('{commondesktop}\AdsPower Global.lnk'));
  DeleteFile(ExpandConstant('{userdesktop}\AdsPower Global.lnk'));
  DeleteFile(ExpandConstant('{commondesktop}\AdsPower Browser.lnk'));
  DeleteFile(ExpandConstant('{userdesktop}\AdsPower Browser.lnk'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    RemoveAdsPowerDesktopShortcuts;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if ShouldInstallAdsPower then
    Log('AdsPower nao encontrado; o instalador oficial sera executado.')
  else
    Log('AdsPower ja esta instalado; mantendo a instalacao existente.');
end;
