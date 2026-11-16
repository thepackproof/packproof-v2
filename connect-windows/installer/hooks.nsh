!include "WordFunc.nsh"
!macro customInit
  ReadRegStr $0 HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $0 != ""
    ${VersionCompare} $0 "${VERSION}" $1
    ${If} $1 == 1
      MessageBox MB_ICONSTOP "A newer PackProof Connect version is already installed. Downgrade is blocked to preserve the queue and protected configuration."
      Abort
    ${EndIf}
  ${EndIf}
!macroend
!macro customInstall
  ${DisableX64FSRedirection}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$INSTDIR\resources\installer\lifecycle.ps1" -Action Install -InstallRoot "$INSTDIR" -RedactedFailureOutput'
  Pop $0
  Pop $1
  ${EnableX64FSRedirection}
  ${If} $0 != 0
    # electron-builder disables interactive details before this hook. Restore
    # visibility and display only the trusted script's bounded redacted line.
    SetDetailsPrint both
    SetDetailsView show
    StrCpy $2 $1 37
    ${If} $2 == "PackProof installation check failed: "
      StrCpy $3 $1 480
    ${ElseIf} $0 == "timeout"
      StrCpy $3 "INSTALL_SCRIPT_TIMEOUT: The local installation checks did not finish. Existing data and keys were preserved."
    ${Else}
      StrCpy $3 "INSTALL_SCRIPT_LAUNCH_FAILED: Windows could not run or complete the trusted installation checks. Ask support to inspect PowerShell policy and the installed files. Existing data and keys were preserved."
    ${EndIf}
    DetailPrint "$3"
    MessageBox MB_ICONSTOP "Setup has not completed.$\r$\n$\r$\n$3$\r$\n$\r$\nCopy this code or the installation details for support. Do not delete the PackProof data folder."
    Abort
  ${EndIf}
!macroend
!macro customUnInstall
  ${DisableX64FSRedirection}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$INSTDIR\resources\installer\lifecycle.ps1" -Action Remove -InstallRoot "$INSTDIR"'
  Pop $0
  Pop $1
  ${EnableX64FSRedirection}
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "The background service could not be stopped. Uninstall has stopped to preserve pending work."
    Abort
  ${EndIf}
  DetailPrint "Encrypted queued data and keys are retained in the protected ProgramData directory. Source exports and cloud records are retained. Revocation is a separate administrator action in PackProof."
!macroend
