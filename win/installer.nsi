; SPDX-License-Identifier: GPL-3.0-or-later
; Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
; DAWters and Son — Windows installer (per-user: no administrator prompt)
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef SRC
  !define SRC "out/DAWters and Son-win32-x64"
!endif
!ifndef OUTFILE
  !define OUTFILE "DAWters-and-Son-Setup.exe"
!endif
!define APP "DAWters and Son"
!define EXE "DAWters and Son.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DAWtersAndSon"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "Software\${APP}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "${APP} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "${APP}"
VIAddVersionKey "LegalCopyright" "${APP}"

!define MUI_ICON "../build/icons/dawters.ico"
!define MUI_UNICON "../build/icons/dawters.ico"
!define MUI_WELCOMEPAGE_TITLE "${APP} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "A multitrack recording studio with a console, instruments, a GrooveMatrix, mastering and a tuner.$\r$\n$\r$\nIt installs for your Windows account only, so no administrator password is needed.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APP} now"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!define MUI_LICENSEPAGE_TEXT_TOP "DAWters and Son is free software. You don't have to accept anything to use it; this explains your rights to share and change it."
!define MUI_LICENSEPAGE_BUTTON "&Next >"
!define MUI_LICENSEPAGE_TEXT_BOTTOM "The GNU GPL gives you the right to use, study, share and change this program. Click Next to continue."
!insertmacro MUI_PAGE_LICENSE "../LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "${APP} (required)" SecApp
  SectionIn RO
  ; close a running copy so its files can be replaced
  nsExec::Exec 'taskkill /IM "${EXE}" /F'
  SetOutPath "$INSTDIR"
  File /r "${SRC}/*.*"
  WriteUninstaller "$INSTDIR\Uninstall ${APP}.exe"
  WriteRegStr HKCU "Software\${APP}" "InstallDir" "$INSTDIR"
  ; Start menu
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  ; songs: .dawters opens in the studio
  WriteRegStr HKCU "Software\Classes\.dawters" "" "DAWters.Song"
  WriteRegStr HKCU "Software\Classes\DAWters.Song" "" "DAWters and Son song"
  WriteRegStr HKCU "Software\Classes\DAWters.Song\DefaultIcon" "" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\Classes\DAWters.Song\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; Settings > Apps entry
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall ${APP}.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Tuner shortcut (D&S Tuner)" SecTuner
  CreateShortcut "$SMPROGRAMS\D&S Tuner.lnk" "$INSTDIR\${EXE}" "--tuner" "$INSTDIR\resources\tuner.ico" 0
SectionEnd

Section "Desktop shortcut" SecDesk
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecApp} "The studio itself, with ffmpeg for MP3, AAC, Ogg, Opus and FLAC exports."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecTuner} "A Start menu shortcut that opens straight into the instrument tuner."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesk} "An icon on your desktop."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${EXE}" /F'
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$SMPROGRAMS\D&S Tuner.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP}"
  ReadRegStr $0 HKCU "Software\Classes\.dawters" ""
  StrCmp $0 "DAWters.Song" 0 +2
    DeleteRegKey HKCU "Software\Classes\.dawters"
  DeleteRegKey HKCU "Software\Classes\DAWters.Song"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; your songs, autosave and settings stay in %APPDATA%\DAWters and Son (delete that folder to remove them too)
SectionEnd
