; intelligentSTUDIO 含模型版安装包（Inno Setup）
; 打包 release\win-unpacked（Electron 主程序 + backend + 文本分类器 + 子应用）+ 大模型（photo/sherpa）
; 用 Inno Setup 是因为 NSIS 单 exe 有 2GB 上限，无法打包约 4GB 模型。

[Setup]
AppId={{D79A0B5E-6E4A-4B8A-9F3D-1C2E3A4B5C6D}
AppName=intelligentSTUDIO
AppVersion=0.1.0
AppPublisher=intelligentSTUDIO
DefaultDirName={autopf}\intelligentSTUDIO
DefaultGroupName=intelligentSTUDIO
DisableProgramGroupPage=yes
OutputDir=..\release
OutputBaseFilename=intelligentstudio-full-0.1.0
Compression=lzma2
SolidCompression=no
DiskSpanning=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
WizardStyle=modern

[Files]
; Electron 主程序 + backend + 文本分类器 + 子应用（去模型版解包目录）
Source: "..\release\win-unpacked\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
; 大模型（不压缩：权重高熵，压缩收益极低且耗时）
Source: "..\models\photo\*"; DestDir: "{app}\resources\models\photo"; Flags: recursesubdirs ignoreversion nocompression
Source: "..\models\sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20\*"; DestDir: "{app}\resources\models\sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"; Flags: recursesubdirs ignoreversion nocompression

[Icons]
; 开始菜单（4 个）
Name: "{group}\STUDIO 设置"; Filename: "{app}\resources\settings\DonySettings.exe"
Name: "{group}\Dony 对话"; Filename: "{app}\resources\dony\Dony.exe"
Name: "{group}\图乐园"; Filename: "{app}\resources\playground\ImagePlayground.exe"
Name: "{group}\照片编辑器"; Filename: "{app}\resources\photo\PhotoEditor.exe"
; 桌面（4 个：设置 + Dony + 图乐园 + 照片编辑器）
Name: "{userdesktop}\STUDIO 设置"; Filename: "{app}\resources\settings\DonySettings.exe"
Name: "{userdesktop}\Dony 对话"; Filename: "{app}\resources\dony\Dony.exe"
Name: "{userdesktop}\图乐园"; Filename: "{app}\resources\playground\ImagePlayground.exe"
Name: "{userdesktop}\照片编辑器"; Filename: "{app}\resources\photo\PhotoEditor.exe"

[Run]
; 安装完成后启动主程序（首次启动会触发设置向导）
Filename: "{app}\intelligentSTUDIO.exe"; Description: "启动 intelligentSTUDIO"; Flags: postinstall nowait skipifsilent
