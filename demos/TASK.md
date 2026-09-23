# 桌面壁纸任务

目标机器:win-testbox (Windows)

步骤:
1. 打开浏览器(无图形界面则用 headless / curl / PowerShell 抓取)。
2. 搜索"赵丽颖 照片"(Zhao Liying photos),挑一张清晰、质量好的图。
3. 下载到本机(如 C:\Users\Public\Pictures 或桌面),保存为 jpg/png。
4. 设为当前 Windows 桌面背景(PowerShell Set-ItemProperty 改注册表 Wallpaper,或 SystemParametersInfo)。
5. 回报:图片完整路径、尺寸、壁纸是否设置成功(读注册表 Wallpaper 值确认)。
