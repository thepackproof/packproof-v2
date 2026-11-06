!macro customInstall
  ${DisableX64FSRedirection}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$INSTDIR\resources\installer\lifecycle.ps1" -Action Install -InstallRoot "$INSTDIR"'
  Pop $0
  Pop $1
  ${EnableX64FSRedirection}
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "The PackProof connection service could not be installed. Pending data is preserved. Ask IT to review service installation permissions."
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
  ; ProgramData queue, encryption keys, source exports and cloud records are retained.
!macroend
