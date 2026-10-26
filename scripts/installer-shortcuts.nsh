; electron-builder NSIS 自定义快捷方式
; 开始菜单：STUDIO 设置 / Dony 对话 / 图乐园 / 照片编辑器
; 桌面：Dony 对话 / 图乐园 / 照片编辑器（不含设置）
; 主进程（Electron）不创建快捷方式，由 package.json 的 nsis 配置关闭。

!macro customInstall
  ; 开始菜单
  CreateDirectory "$SMPROGRAMS\intelligentSTUDIO"
  CreateShortCut "$SMPROGRAMS\intelligentSTUDIO\STUDIO 设置.lnk" "$INSTDIR\resources\settings\DonySettings.exe"
  CreateShortCut "$SMPROGRAMS\intelligentSTUDIO\Dony 对话.lnk" "$INSTDIR\resources\dony\Dony.exe"
  CreateShortCut "$SMPROGRAMS\intelligentSTUDIO\图乐园.lnk" "$INSTDIR\resources\playground\ImagePlayground.exe"
  CreateShortCut "$SMPROGRAMS\intelligentSTUDIO\照片编辑器.lnk" "$INSTDIR\resources\photo\PhotoEditor.exe"
  ; 桌面（4 个：设置 + Dony + 图乐园 + 照片编辑器）
  CreateShortCut "$DESKTOP\STUDIO 设置.lnk" "$INSTDIR\resources\settings\DonySettings.exe"
  CreateShortCut "$DESKTOP\Dony 对话.lnk" "$INSTDIR\resources\dony\Dony.exe"
  CreateShortCut "$DESKTOP\图乐园.lnk" "$INSTDIR\resources\playground\ImagePlayground.exe"
  CreateShortCut "$DESKTOP\照片编辑器.lnk" "$INSTDIR\resources\photo\PhotoEditor.exe"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\intelligentSTUDIO\STUDIO 设置.lnk"
  Delete "$SMPROGRAMS\intelligentSTUDIO\Dony 对话.lnk"
  Delete "$SMPROGRAMS\intelligentSTUDIO\图乐园.lnk"
  Delete "$SMPROGRAMS\intelligentSTUDIO\照片编辑器.lnk"
  RMDir "$SMPROGRAMS\intelligentSTUDIO"
  Delete "$DESKTOP\STUDIO 设置.lnk"
  Delete "$DESKTOP\Dony 对话.lnk"
  Delete "$DESKTOP\图乐园.lnk"
  Delete "$DESKTOP\照片编辑器.lnk"
!macroend
