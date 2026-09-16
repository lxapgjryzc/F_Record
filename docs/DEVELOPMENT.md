# 开发与发布指南

## 环境与命令

完整构建和 ZIP 打包使用 Windows、PowerShell、Node.js 24 与 npm。测试使用 Node 的实验性模块模拟接口；不要用 Photoshop 内置的旧 Node 运行开发测试。

```powershell
npm install
npm run typecheck
npm test
npm run check
npm run build
node scripts/build.mjs --zip
```

`npm test` 构建测试模块和实际生成器后运行测试。`npm run check` 检查类型，再分别执行核心与面板覆盖率检查，行、分支和函数门槛均为 100%。

`npm run build` 输出到 `dist/`。`--zip` 另生成 `release/F_Record-<version>.zip`，并去除 `dist/` 内的测试模块与 ES5 中间产物；之后需要测试时重新运行 `npm test` 或 `npm run check`。

## 按功能阅读源码

| 顺序 | 模块 | 职责 |
|---|---|---|
| 1 | `shared/` | 协议、默认值、路径、分辨率与运行时兼容 |
| 2 | `generator/src/logger.ts`、`store.ts` | 日志、设置、会话清单与恢复索引 |
| 3 | `generator/src/stamp.ts`、`session.ts` | PSD 标识、续录、另存为分支与文档归属 |
| 4 | `generator/src/capture.ts`、`encoder.ts`、`framing.ts` | 抓帧调度、像素编码与画布几何 |
| 5 | `generator/src/zip.ts`、`trash.ts`、`housekeeping.ts` | 打包、回收站与批量整理 |
| 6 | `generator/src/bridge.ts`、`update.ts`、`index.ts` | 本机 HTTP/SSE 通信、更新检查与录制运行时 |
| 7 | `cep/src/node/` | 视频导出、ffmpeg/字体定位、水印与剪贴板 |
| 8 | `cep/src/app/`、`cep/src/host/` | 面板、语言、主题、兼容补丁与 Photoshop 脚本接口 |
| 9 | `scripts/`、`cep/src/CSXS/`、`cep/src/icons/` | 构建、版本选择、安装、诊断与发布素材 |

生成器拥有配置、索引和会话清单的写入权。面板通过本机桥接获取状态、发送命令，导出与剪贴板处理在面板侧执行。桥接绑定回环接口，校验每次运行生成的令牌，并拒绝带 `Origin` 的请求。

会话目录保存 `session.json` 与 `<序号>_<时间戳>.jpg`；帧目录是帧数依据，索引用于恢复。移动会话时还需维护指针文件，不能仅修改索引路径。

## 运行时与构建

| 产物 | 目标 | 构建方式 |
|---|---|---|
| Generator | Photoshop CC 2015.5 起 | TypeScript 降级到 ES5，再由 esbuild 打包 |
| `cep-classic` | Photoshop 17–18 | ES5 / Chromium 41 基线 |
| `cep-legacy` | Photoshop 19–21 | Chromium 57 基线 |
| `cep-modern` | Photoshop 22 及以上 | Chromium 74 基线 |

三种面板使用同一源码，差异在编译目标、宿主范围与兼容处理。`package.json` 是版本来源，构建时写入生成器包、面板清单与 `build.json`。协议版本位于 `shared/protocol.ts`，修改通信约定时应同时维护。

准备旧 Node 可执行文件后，可运行生成器冒烟脚本：

```powershell
& 'C:\runtimes\node-4.8.4.exe' scripts/smoke-generator.js dist/generator/com.f_know.f_record.generator/index.js
```

脚本使用隔离数据目录和模拟 Photoshop，验证构建包能加载并写出一帧，不替代真实 Photoshop 测试。

## 测试范围

- `test/*.test.mjs`：配置、路径、兼容、存储、会话、抓帧、通信、导出、整理与打包约定。
- `test/panel/*.test.mjs`：用 DOM 模拟验证组件、输入法、对话框与应用流程。
- 集成与产物测试：实际生成器包，以及保存、新建文档、改尺寸等事件交错。
- 覆盖率对象是 `dist/modules/*.mjs`；核心与面板分开统计，避免不同测试进程的模块模拟互相覆盖结果。

覆盖率通过不代表第三方程序、全部 JSX/PowerShell 路径或所有 Photoshop 版本都已验证。发布结果同时报告跳过和失败项，不将历史实机验证写成本次验证。

## 发布步骤

1. 核对版本、协议和宿主范围，更新两份 README 与 `RELEASE_NOTES.md`。
2. 运行 `npm run check`，保存结果。
3. 运行 `node scripts/build.mjs --zip`，核对生成器、三种面板、六个安装/诊断脚本、文档和许可证。
4. 确认 ZIP 不含测试模块、ES5 中间文件和开发依赖，所有清单与生成器包版本一致。
5. 在目标 Photoshop 验证安装、录制、保存/另存为、重新打开、导出和剪贴板。
6. 将标签指向发布提交，以 `RELEASE_NOTES.md` 更新 Release 正文并上传 ZIP；重新核对远端标签、附件与校验值。

当前构建脚本**不签署 CEP 面板**，因此生成的包使用 `scripts/install.ps1 -DevMode` 安装。若引入签名流程，同步更新安装说明。

`scripts/repair-frames.mjs` 修复历史坏帧，需先安装源码依赖；默认另写到相邻的 `-repaired` 目录，不覆盖源目录。`scripts/icon.mjs` 用于重建图标。这两个开发工具不随安装包分发。
