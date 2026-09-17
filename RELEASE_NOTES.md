# F_Record 4.0.2

适用于 Windows / Photoshop CC 2015.5–2026（17.x–27.x）。本版把录制开关改为按画布记忆，仪表盘上用一个圆点显示录制状态。以下按使用流程说明发布包的能力。

## 本版变化

- **录制开关属于每个画布。** 开关状态存在该录制的 `session.json` 里，切换文档、关掉重开、重启 Photoshop 都各自保持；关掉后录制仍挂在文档上，再打开接着录进同一目录。面板开关和 Photoshop 菜单项都只作用于当前文档。
- **自动开始只剩一个设置：「打开画布时自动开始录制」。** 一次 Photoshop 运行里第一次看到某个画布时替你打开它的录制；之后手动关掉的画布，本次运行内不会再被自动打开，下次启动重新开始。原来的全局开关和「自动录制新文档」从配置里删除，旧配置自动清理。
- **仪表盘上只有一个状态灯：状态文字旁的圆点。** 录制中红色（抓帧时闪烁），暂停、抓帧失败或画布太小为黄色，未录制为灰色。面板顶部和 Photoshop 停靠栏里的图标改为纯灰色标志，不再随状态变色。
- 升级后，旧录像的开关一律视为打开，避免丢帧；不想录的画布在面板上关掉即可。

## 录制与文档恢复

- 画布变化时自动抓帧，按实际耗时调整间隔；切换文档、改画布大小和 Photoshop 忙碌后均有同步恢复处理。
- PSD 标识、运行中的文档表和磁盘索引共同支持续录；索引仅用于从文件打开且画布尺寸匹配的文档，避免新作品沿用旧文件名时误认录制。
- 另存为给新文件保留此前完整过程图，后续录制独立于原文件；支持硬链接时优先复用帧数据。

## 视频、水印与复制画面

- 支持按画幅比例和目标时长导出，抽帧保留首尾，并记住上次比例和时长。
- 支持文字、图片水印和角标、居中、浮雕满屏样式；可在单次导出时调整或关闭。
- 复制画面默认使用 1080p，可选原图或其他分辨率，水印开关独立设置；无需先开启录制。

## 整理与面板

- 支持归档、恢复、移动过程图到源文件旁边、按帧数或创建时间筛选，以及批量打包 ZIP。
- 从录像列表打开或切换源文档，逐项查看后统一确认清理；源文件删除使用回收站。
- 提供十种语言、Photoshop 主题适配与可选的更新提示；更新检查默认关闭。

## 兼容性与发布内容

- `classic` 面板对应 Photoshop 17–18，`legacy` 对应 19–21，`modern` 对应 22 及以上；本版适配范围列至 Photoshop 2026。
- 旧宿主使用 ES5 构建，包含 Buffer、面板键盘事件与 CSS 变量兼容处理。
- 附带普通、深色、悬停及高分辨率图标，安装器与诊断脚本使用统一的版本分界。
- 面板未签名，需要按下方命令以 `-DevMode` 安装。发布包不含 ffmpeg、测试构建和 ES5 中间文件。

下载 **`F_Record-4.0.2.zip`**，其中包含：

| 路径 | 内容 |
|---|---|
| `generator/` | 后台录制插件 |
| `cep-classic/`、`cep-legacy/`、`cep-modern/` | 三种面板构建，安装器自动选择 |
| `scripts/install.cmd`、`scripts/install.ps1` | 安装入口 |
| `scripts/uninstall.cmd`、`scripts/uninstall.ps1` | 卸载入口 |
| `scripts/doctor.ps1`、`scripts/photoshop.ps1` | 诊断与 Photoshop 检测 |
| `README.md`、`README_EN.md` | 中英文说明 |
| `RELEASE_NOTES.md`、`docs/DEVELOPMENT.md`、`LICENSE` | 发布说明、开发指南与许可证 |

GitHub 自动附带的 Source code 压缩包需要自行构建，不能直接安装。

## 安装与升级

退出 Photoshop，完整解压，在解压目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DevMode
```

脚本请求管理员权限，安装匹配的面板与生成器，并为当前 Windows 用户允许未签名 CEP 面板加载。重启 Photoshop，确认启用生成器和扩展面板，从「窗口 → 扩展（旧版）」或「窗口 → 扩展」打开 F_Record。

两部分须一起升级，协议版本为 **14**。安装器优先使用已有 ffmpeg，没有时才下载并校验；可加 `-SkipFfmpeg` 跳过。卸载入口是 `scripts\uninstall.cmd`，默认保留录制数据。

## 验证范围

本次运行 `npm run check`：类型检查通过；1007 项自动化测试全部通过，无失败或跳过。覆盖率涉及 38 个模块，行、分支和函数均为 100%。这些数值针对被测模块，不代表所有打包脚本、第三方依赖或 Photoshop 实机路径都已覆盖。

发布包另行检查三种面板、生成器、安装脚本和随包文档。各 Photoshop 版本的界面与实机录制仍应按需验证。

English installation and feature details: [README_EN.md](https://github.com/lxapgjryzc/F_Record/blob/develop/README_EN.md).
