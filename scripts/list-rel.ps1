Get-ChildItem 'D:\OpenCode\APPXInteligent\release' -File -Filter 'intelligentstudio-*' |
    Sort-Object Name |
    ForEach-Object { '{0,-45} {1,10:N2} MB  {2:MM-dd HH:mm}' -f $_.Name, ($_.Length / 1MB), $_.LastWriteTime }
