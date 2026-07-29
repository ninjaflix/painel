!macro customInstall
  Delete "$DESKTOP\NinjaFlix Agent.lnk"
  Delete "$SMPROGRAMS\NinjaFlix Agent.lnk"
  Delete "$SMPROGRAMS\NinjaFlix Agent\NinjaFlix Agent.lnk"
  RMDir "$SMPROGRAMS\NinjaFlix Agent"
  Delete "$DESKTOP\Ninjaflix Painel.lnk"
  Delete "$DESKTOP\NinjaFlix Painel.lnk"
  Delete "$SMPROGRAMS\Ninjaflix Painel.lnk"
  Delete "$SMPROGRAMS\NinjaFlix Painel.lnk"
  Delete "$SMPROGRAMS\Ninjaflix Painel\Ninjaflix Painel.lnk"
  Delete "$SMPROGRAMS\NinjaFlix Painel\NinjaFlix Painel.lnk"
  RMDir "$SMPROGRAMS\Ninjaflix Painel"
  RMDir "$SMPROGRAMS\NinjaFlix Painel"
  RMDir /r "$LOCALAPPDATA\Programs\NinjaFlix Agent"
  CreateDirectory "$SMPROGRAMS\Ninjaflix Painel"
  CreateShortCut "$DESKTOP\Ninjaflix Painel.lnk" "$INSTDIR\Ninjaflix Painel.exe" "" "$INSTDIR\resources\icon.ico" 0
  CreateShortCut "$SMPROGRAMS\Ninjaflix Painel\Ninjaflix Painel.lnk" "$INSTDIR\Ninjaflix Painel.exe" "" "$INSTDIR\resources\icon.ico" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\NinjaFlix Agent.lnk"
  Delete "$SMPROGRAMS\NinjaFlix Agent.lnk"
  Delete "$SMPROGRAMS\NinjaFlix Agent\NinjaFlix Agent.lnk"
  RMDir "$SMPROGRAMS\NinjaFlix Agent"
  Delete "$DESKTOP\Ninjaflix Painel.lnk"
  Delete "$DESKTOP\NinjaFlix Painel.lnk"
  Delete "$SMPROGRAMS\Ninjaflix Painel.lnk"
  Delete "$SMPROGRAMS\Ninjaflix Painel\Ninjaflix Painel.lnk"
  RMDir "$SMPROGRAMS\Ninjaflix Painel"
  Delete "$SMPROGRAMS\NinjaFlix Painel.lnk"
  Delete "$SMPROGRAMS\NinjaFlix Painel\NinjaFlix Painel.lnk"
  RMDir "$SMPROGRAMS\NinjaFlix Painel"
!macroend
