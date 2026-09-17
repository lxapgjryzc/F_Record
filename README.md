# F_Record

[English](README_EN.md) · [下载发布包](https://github.com/lxapgjryzc/F_Record/releases/latest) · [发布说明](RELEASE_NOTES.md)

F_Record 是录制 Photoshop 绘画过程的插件。画布变化时自动保存过程图，完成后可导出视频，也可以把当前画面复制到剪贴板。

当前版本为 **4.0.2**，面向 **Windows、Photoshop CC 2015.5–2026（17.x–27.x）**。安装包包含后台生成器和三种 CEP 面板，安装器按 Photoshop 版本自动选择。

## 安装与升级

1. 下载 `F_Record-4.0.2.zip` 并完整解压。GitHub 自动生成的 Source code 压缩包是源码，需要先构建。
2. 退出 Photoshop，在解压目录打开 PowerShell，执行：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DevMode
   ```

   脚本会请求管理员权限，安装到检测到的受支持 Photoshop。当前发布包中的面板未签名；`-DevMode` 为当前 Windows 用户设置 CEP 的 `PlayerDebugMode`，允许面板加载。已开启该设置时，也可双击 `scripts\install.cmd`。

3. 启动 Photoshop，在「编辑 → 首选项 → 增效工具」中确认已启用生成器、允许载入扩展面板。更改后重启 Photoshop。
4. 从「窗口 → 扩展」或「窗口 → 扩展（旧版）」打开 **F_Record**；菜单名称随版本和语言变化。

升级使用同一命令，同时更新面板和生成器。两者的协议版本为 **14**，应成套安装。

| Photoshop | 主版本 | 自动选择的面板 |
|---|---|---|
| CC 2015.5–CC 2017 | 17–18 | `classic` |
| CC 2018–2020 | 19–21 | `legacy` |
| 2021–2026 | 22–27 | `modern` |

CC 2015.1 及更早版本会被跳过。以上是构建与安装的适配范围；自动化测试不等同于所有 Photoshop 版本的实机验证。

### ffmpeg 与安装选项

录制不依赖 ffmpeg，视频导出和复制画面的处理流程需要它。发布包不内置 ffmpeg。安装器先查找本机程序，找不到时从 [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) 下载并校验 SHA-256，放到 `%ProgramData%\F_Record\ffmpeg\`。下载失败仍可完成插件安装，但需补装 ffmpeg 才能使用相关功能。

```powershell
# 预览操作，不修改系统
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf

# 仅安装到指定 Photoshop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DevMode -Path "D:\Adobe Photoshop 2024"

# 跳过 ffmpeg 查找和下载
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DevMode -SkipFfmpeg
```

## 录制与续录

录制开关属于每个画布：在面板上打开当前文档的录制后，插件跟随这个文档保存过程图，开关状态存在它的录制目录里，切换文档、关掉重开、重启 Photoshop 都各自保持。录制在后台执行，关闭或隐藏面板仍可继续。仪表盘上状态文字旁有一个圆点，随当前画布变色：录制中为红色，出问题（暂停、抓帧失败、画布太小）为黄色，未录制为灰色。面板和停靠栏的图标都是纯灰色的标志，不表示状态。

设置中的「打开画布时自动开始录制」会在一次 Photoshop 运行里第一次看到某个画布时替你打开它的录制：没录过的画布得到新录制，关着的画布被打开。之后关掉的画布在本次运行里不会再被自动打开，下次启动时重新开始。

- 抓帧由画布变化触发，最短间隔默认 1.5 秒，并根据抓帧耗时调整；持续无操作时不重复保存相同画面。
- 默认分辨率为 1080p、JPEG 质量为 70。分辨率按像素面积换算并保留画布比例，不强行裁成 16:9。
- 切换文档、改画布大小和 Photoshop 暂时忙碌都有同步与恢复处理；持续失败会在面板提示。
- 会话通过 PSD 内的标识、运行中的文档表和磁盘索引关联。恢复索引仅用于从文件打开、且画布尺寸匹配的文档；无法可靠识别时提供选择。
- **另存为会分出两份录制**：新文件获得此前过程图的完整副本并继续录制，原文件保留原来的录制。支持时使用硬链接，否则复制文件。

## 视频、水印与复制画面

当前录制和录像列表都可导出。导出时可选画幅比例和目标时长，视频匀速播放；缩短时长通过抽帧完成并保留首尾帧。比例与时长会记作下次导出的默认值。

水印支持文字或图片，可选角标、居中或浮雕满屏，并调整大小与不透明度。导出对话框可临时更改内容或关闭本次水印。透明 PNG 可用作签名；需要指定字体时，将 `F_RECORD_FONT` 环境变量设为字体文件路径。

**复制画面**可在未开启录制时使用。默认复制 1080p 画面，设置中可选其他分辨率或原图，并独立决定是否加水印。缩放在水印处理前完成，复制期间短暂暂停抓帧。

## 录像整理

| 操作 | 用途 |
|---|---|
| 打开 / 切换文档 | 从录制的路径打开 PSD、PSB 等文件；切换操作会先保存并关闭当前文档。 |
| 归档 / 恢复 | 将完成的作品收进归档；继续绘画时自动恢复到录像列表。 |
| 移动过程图 | 将过程图放到源文件旁边，或移回设置中的过程图目录。 |
| 筛选旧录像 | 按帧数和创建天数筛选；默认少于 20 帧或创建超过 30 天。 |
| 打包 ZIP | 每段录制单独打包，可包含源文件和过程图，并选择打包后删除。 |
| 清理 | 依次在 Photoshop 查看作品，逐项选择，最后统一确认删除。 |

删除录像与删除源文件是不同选项；源文件删除使用回收站。处理前请核对面板列出的对象。

## 设置、数据与排查

设置和默认过程图目录位于 `%APPDATA%\F_Record\`：

| 路径 | 内容 |
|---|---|
| `config.json` | 插件设置 |
| `processImages\` | 默认过程图目录；每个会话含 `session.json` 和帧文件 |
| `index.json` | 恢复索引 |
| `logs\generator.log` | 生成器日志 |

更换过程图目录不会自动迁移已有录像。备份作品时应保存源文件和完整的过程图文件夹。

面板支持简体中文、繁體中文、English、日本語、한국어、Deutsch、Français、Español、Português (Brasil)、Русский，默认跟随 Photoshop，无法匹配时回退英语。

更新检查默认关闭；开启后约每天查询一次 GitHub Releases，手动检查也会访问 GitHub。录制本身在本机完成。

面板打不开、连接失败或无法导出时，先执行诊断：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

卸载运行 `scripts\uninstall.cmd`，默认保留设置和录制数据。反馈时可附 Photoshop 版本、诊断结果与相关日志：[Issues](https://github.com/lxapgjryzc/F_Record/issues)。

## 开发

使用 Node.js 24 和 npm：

```powershell
npm install
npm run build
npm run check
node scripts/build.mjs --zip
```

构建输出到 `dist\`，发布包输出到 `release\F_Record-4.0.2.zip`。开发环境使用系统 Node.js，插件运行时使用 Photoshop 自带的 Node.js。

模块、测试与发布步骤见 [开发与发布指南](docs/DEVELOPMENT.md)。许可证为 [GPL-3.0-only](LICENSE)。
