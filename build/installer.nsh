; ============================================================================
; Nimbus installer customisation
;
; - Installer: optional desktop shortcut (the Start menu shortcut is always
;   created by electron-builder).
; - Uninstaller: choose whether to delete the local library and GitHub storage
;   data before the application files are removed.
;
; Silent usage:
;   Nimbus-Setup.exe /S /no-desktop-shortcut
;   Uninstall Nimbus.exe /S /delete-local-data
;   Uninstall Nimbus.exe /S /delete-github-data
;   Uninstall Nimbus.exe /S /delete-github-data /delete-github-repository
; ============================================================================

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
Var NimbusInstallerDialog
Var NimbusDesktopShortcutCheckbox
Var NimbusCreateDesktopShortcut
!endif

!ifdef BUILD_UNINSTALLER
Var NimbusUninstallerDialog
Var NimbusLocalDataCheckbox
Var NimbusGithubDataCheckbox
Var NimbusGithubRepoCheckbox
Var NimbusDeleteLocalData
Var NimbusDeleteGithubData
Var NimbusDeleteGithubRepository
Var NimbusGithubCleanupFailed
!endif

; ---------------------------------------------------------------------------
; Installer
; ---------------------------------------------------------------------------

!ifndef BUILD_UNINSTALLER

!macro customInit
  StrCpy $NimbusCreateDesktopShortcut "1"
  ${GetParameters} $R0
  ${GetOptions} $R0 "/no-desktop-shortcut" $R1
  ${IfNot} ${Errors}
    StrCpy $NimbusCreateDesktopShortcut "0"
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom NimbusDesktopShortcutPageCreate NimbusDesktopShortcutPageLeave
!macroend

Function NimbusDesktopShortcutPageCreate
  !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose where Nimbus appears."
  nsDialogs::Create 1018
  Pop $NimbusInstallerDialog
  ${If} $NimbusInstallerDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 30u "Setup always creates a Start menu shortcut. You can also put Nimbus on your desktop for quick access."
  Pop $0

  ${NSD_CreateCheckbox} 0 38u 100% 16u "Create a desktop shortcut"
  Pop $NimbusDesktopShortcutCheckbox
  ${If} $NimbusCreateDesktopShortcut == "1"
    ${NSD_SetState} $NimbusDesktopShortcutCheckbox ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $NimbusDesktopShortcutCheckbox ${BST_UNCHECKED}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function NimbusDesktopShortcutPageLeave
  ${NSD_GetState} $NimbusDesktopShortcutCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $NimbusCreateDesktopShortcut "1"
  ${Else}
    StrCpy $NimbusCreateDesktopShortcut "0"
  ${EndIf}
FunctionEnd

!macro customInstall
  ${If} $NimbusCreateDesktopShortcut != "1"
    Delete "$newDesktopLink"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend

!endif ; BUILD_UNINSTALLER

; ---------------------------------------------------------------------------
; Uninstaller
; ---------------------------------------------------------------------------

!ifdef BUILD_UNINSTALLER

!macro customUnInit
  StrCpy $NimbusDeleteLocalData "0"
  StrCpy $NimbusDeleteGithubData "0"
  StrCpy $NimbusDeleteGithubRepository "0"
  StrCpy $NimbusGithubCleanupFailed "0"

  ${GetParameters} $R0

  ${GetOptions} $R0 "/delete-local-data" $R1
  ${IfNot} ${Errors}
    StrCpy $NimbusDeleteLocalData "1"
  ${EndIf}

  ${GetOptions} $R0 "/delete-github-repository" $R1
  ${IfNot} ${Errors}
    StrCpy $NimbusDeleteGithubData "1"
    StrCpy $NimbusDeleteGithubRepository "1"
  ${EndIf}

  ${GetOptions} $R0 "/delete-github-data" $R1
  ${IfNot} ${Errors}
    StrCpy $NimbusDeleteGithubData "1"
  ${EndIf}
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.NimbusDataPageCreate un.NimbusDataPageLeave
!macroend

Function un.NimbusToggleGithub
  ${NSD_GetState} $NimbusGithubDataCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    EnableWindow $NimbusGithubRepoCheckbox 1
  ${Else}
    ${NSD_SetState} $NimbusGithubRepoCheckbox ${BST_UNCHECKED}
    EnableWindow $NimbusGithubRepoCheckbox 0
  ${EndIf}
FunctionEnd

Function un.NimbusDataPageCreate
  !insertmacro MUI_HEADER_TEXT "Remove Nimbus" "Choose what happens to your library data."
  nsDialogs::Create 1018
  Pop $NimbusUninstallerDialog
  ${If} $NimbusUninstallerDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 28u "The app, shortcuts and Start menu entry will be removed. Your library is kept unless you select an option below."
  Pop $0

  ${NSD_CreateCheckbox} 0 36u 100% 16u "Delete local library data ($APPDATA\nimbus-vault)"
  Pop $NimbusLocalDataCheckbox
  ${If} $NimbusDeleteLocalData == "1"
    ${NSD_SetState} $NimbusLocalDataCheckbox ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $NimbusLocalDataCheckbox ${BST_UNCHECKED}
  ${EndIf}

  ${NSD_CreateCheckbox} 0 60u 100% 16u "Delete GitHub storage data (Nimbus releases and assets)"
  Pop $NimbusGithubDataCheckbox
  ${If} $NimbusDeleteGithubData == "1"
    ${NSD_SetState} $NimbusGithubDataCheckbox ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $NimbusGithubDataCheckbox ${BST_UNCHECKED}
  ${EndIf}
  ${NSD_OnClick} $NimbusGithubDataCheckbox un.NimbusToggleGithub

  ${NSD_CreateLabel} 18u 76u 92% 20u "Only releases created by Nimbus are deleted. If cleanup fails, local data is kept."
  Pop $0

  ${NSD_CreateCheckbox} 0 102u 100% 16u "Also delete the GitHub repository itself"
  Pop $NimbusGithubRepoCheckbox
  ${If} $NimbusDeleteGithubRepository == "1"
    ${NSD_SetState} $NimbusGithubRepoCheckbox ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $NimbusGithubRepoCheckbox ${BST_UNCHECKED}
  ${EndIf}

  ${NSD_CreateLabel} 18u 118u 92% 20u "This removes the whole repository, including anything else you keep in it. It cannot be undone."
  Pop $0

  ${If} $NimbusDeleteGithubData != "1"
    ${NSD_SetState} $NimbusGithubRepoCheckbox ${BST_UNCHECKED}
    EnableWindow $NimbusGithubRepoCheckbox 0
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function un.NimbusDataPageLeave
  ${NSD_GetState} $NimbusLocalDataCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $NimbusDeleteLocalData "1"
  ${Else}
    StrCpy $NimbusDeleteLocalData "0"
  ${EndIf}

  ${NSD_GetState} $NimbusGithubDataCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $NimbusDeleteGithubData "1"
  ${Else}
    StrCpy $NimbusDeleteGithubData "0"
    StrCpy $NimbusDeleteGithubRepository "0"
  ${EndIf}

  ${If} $NimbusDeleteGithubData == "1"
    ${NSD_GetState} $NimbusGithubRepoCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $NimbusDeleteGithubRepository "1"
    ${Else}
      StrCpy $NimbusDeleteGithubRepository "0"
    ${EndIf}
  ${EndIf}
FunctionEnd

!macro customUnInstall
  ${If} $NimbusDeleteGithubData == "1"
    DetailPrint "Deleting GitHub storage data..."
    ${If} ${FileExists} "$INSTDIR\resources\app\dist\server\cleanup.js"
      System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
      ${If} $NimbusDeleteGithubRepository == "1"
        nsExec::ExecToStack '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\app\dist\server\cleanup.js" --data-dir "$APPDATA\nimbus-vault\library" --github --repository'
      ${Else}
        nsExec::ExecToStack '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\app\dist\server\cleanup.js" --data-dir "$APPDATA\nimbus-vault\library" --github'
      ${EndIf}
      Pop $0
      Pop $1
      ${If} $0 != 0
        StrCpy $NimbusGithubCleanupFailed "1"
        StrCpy $2 $1 500
        MessageBox MB_ICONEXCLAMATION|MB_OK "GitHub cleanup could not finish. Local data was kept so you can reinstall Nimbus and try again.$\r$\n$\r$\n$2"
      ${EndIf}
    ${Else}
      StrCpy $NimbusGithubCleanupFailed "1"
      MessageBox MB_ICONEXCLAMATION|MB_OK "The GitHub cleanup helper is missing from this installation, so no cloud data was deleted."
    ${EndIf}
  ${EndIf}

  ${If} $NimbusDeleteLocalData == "1"
    ${If} $NimbusGithubCleanupFailed == "1"
      MessageBox MB_ICONEXCLAMATION|MB_OK "Local Nimbus data was kept because GitHub cleanup failed. You can delete $APPDATA\nimbus-vault manually if you still want to remove it."
    ${Else}
      DetailPrint "Deleting local Nimbus data..."
      RMDir /r "$APPDATA\nimbus-vault"
    ${EndIf}
  ${EndIf}
!macroend

!endif ; BUILD_UNINSTALLER
