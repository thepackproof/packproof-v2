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
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$INSTDIR\resources\installer\lifecycle.ps1" -Action Install -InstallRoot "$INSTDIR"'
  Pop $0
  Pop $1
  ${EnableX64FSRedirection}
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_ICONSTOP "PackProof did not pass its installation or protected-storage readiness check. Setup has not completed. Existing data and encryption keys were not reset. Open the installation details for the specific failure; do not delete the PackProof data folder."
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
