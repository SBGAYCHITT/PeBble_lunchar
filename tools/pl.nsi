!define APPNAME "Pebble Lunchar"
!define EXENAME "Pebble Lunchar.exe"
!define INSTDIRNAME "PebbleLunchar"
!define BUILDVER "3.0.0.202610010608"

Name "${APPNAME}"
OutFile "C:\Users\Felix\WorkBuddy\2026-09-12-10-14-18\pefebeb-lunchar\dist\Pebble-Lunchar.exe"
InstallDir "$LOCALAPPDATA\${INSTDIRNAME}"
RequestExecutionLevel user
SilentInstall silent
SetCompressor /SOLID lzma
SetCompressorDictSize 64
Icon "C:\Users\Felix\WorkBuddy\2026-09-12-10-14-18\pefebeb-lunchar\build\icon.ico"
UninstallIcon "C:\Users\Felix\WorkBuddy\2026-09-12-10-14-18\pefebeb-lunchar\build\icon.ico"
BrandingText "${APPNAME}"

Function .onInit
  ; Already installed and same build -> launch directly
  IfFileExists "$INSTDIR\${EXENAME}" 0 doInstall
  ClearErrors
  FileOpen $0 "$INSTDIR\version.txt" r
  IfErrors doInstall
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "${BUILDVER}" 0 doInstall
    Exec "$INSTDIR\${EXENAME}"
    Quit
  doInstall:
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r /x debug.log /x run.cmd "C:\Users\Felix\WorkBuddy\2026-09-12-10-14-18\pefebeb-lunchar\dist\win-unpacked\*"
  FileOpen $0 "$INSTDIR\version.txt" w
  FileWrite $0 "${BUILDVER}"
  FileClose $0
  WriteUninstaller "$INSTDIR\uninstall.exe"
  ; Uninstall info
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTDIRNAME}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTDIRNAME}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTDIRNAME}" "DisplayIcon" "$INSTDIR\${EXENAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTDIRNAME}" "Publisher" "Felix"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTDIRNAME}" "DisplayVersion" "3.0.0"
SectionEnd

Section "Launch"
  Exec "$INSTDIR\${EXENAME}"
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTDIRNAME}"
SectionEnd
