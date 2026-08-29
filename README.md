# F_Record

[English](./README_EN.md)

一款用来录制绘画过程的轻量级 PS 插件。画布一有变化就抓一帧，最后连成录像。

**当前版本**：4.0（对 3.x 的彻底重写）
**支持系统**：Windows
**支持 PS 版本**：Photoshop 2020 – 2026（21.x – 27.x）

---

## 安装

1. 下载并解压发布包。
2. 双击 `scripts\install.cmd`（会请求管理员权限，因为 Photoshop 装在 Program Files 下）。

   安装脚本会自己找出机器上所有的 Photoshop，读出每一个的真实版本，然后装上对应的那份构建 ——
   PS 2020 用 legacy 版，2021 及以后用 modern 版。不需要你手动拷贝文件夹。

   **关于 ffmpeg**：导出视频要用到 ffmpeg，但它不再塞在安装包里（那是个 138 MB 的文件）。
   安装脚本会先在你机器上找 —— PATH、winget、chocolatey、常见目录都会看一遍 ——
   找到就直接用；找不到才会从
   [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases)
   下载最新的稳定版，校验 SHA-256 之后放到 `%ProgramData%\F_Record\ffmpeg\`。

   下载失败（比如没网）不会让安装中断：面板和录制照常装好，只是导出用不了，
   脚本会明确告诉你。你自己装好 ffmpeg 之后再跑一次安装脚本就行。
   不想让它碰网络就加 `-SkipFfmpeg`。

   想指定某一个 Photoshop，或者先看看它打算做什么：

   ```bash
   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -WhatIf
   ```

   ```bash
   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Path "D:\Adobe Photoshop 2024"
   ```

3. 完全退出 Photoshop 再重新打开。
4. 检查「编辑 ▸ 首选项 ▸ 增效工具」：
   - **启用生成器** 要勾上（真正干录制活的是它）
   - **载入扩展面板** 要勾上（在「旧版扩展」那一栏）

   有任何一个是你刚勾的，就再重启一次 Photoshop。

5. 面板在「窗口 ▸ 扩展（旧版）▸ F_Record」。

出问题就跑诊断脚本，它会告诉你卡在哪一步：

```bash
powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1
```

卸载：双击 `scripts\uninstall.cmd`。你的录像放在 `%APPDATA%\F_Record`，卸载不会动它。

---

## 使用

**开关打开，然后就可以不管了。** 录制是在 Photoshop 的后台进程里跑的，面板关掉、藏起来都不影响。
在设置里打开「启动 Photoshop 时自动开始录制」，以后连开关都不用碰。

每个文档的过程图存在各自的文件夹里。**换个名字另存为、改名、关掉重开、甚至重启 Photoshop，
都会接着录进原来那个文件夹** —— 这是 4.0 修掉的主要问题，下面有说明。

「录像」标签页列出所有历史录制，任何一段都能单独导出，不只是当前打开的这个文档。

### 几个设置

| 设置 | 说明 |
|---|---|
| 过程图文件夹 | 默认在 C 盘，建议换到空间够的盘。改了之后已有的录像不会自动搬走。 |
| 分辨率 / 质量 | 越高最终视频越清楚，过程图也越占地方。估算占用别拿空白画布估，jpg 的大小跟画面复杂度关系很大。 |
| 抓帧间隔 | 两帧之间的最短间隔。这只是下限：真实间隔会根据抓帧实际耗时自动往上调，画得越重的文档抓得越稀。 |
| 离开时间 | 超过这个时间没落笔就停止计时，用时统计不会把发呆算进去。 |

### 导出

两种节奏：

- **匀速** —— 每帧时长相同，和 3.x 一样。
- **真实节奏** —— 按落笔的真实间隔来，停顿会被保留（单帧最长 2 秒，免得中间干等）。
  这是因为 4.0 把抓帧时间写进了文件名。

---

## 4.0 改了什么

### 录制期间不再静默卡死

3.x 卡死不是玄学，是四件事叠在一起，都在这一版修了：

1. **每秒两次全量图层遍历，而且关掉开关也照跑。** 旧代码每 500ms 调一次
   `getDocumentInfo()`，用的是默认参数 —— 那会在 Photoshop 主线程上用 ExtendScript
   把每一个图层走一遍。现在改成事件驱动，并且把 `layerInfo` / `compInfo` / `getTextStyles`
   全部关掉，只要 `imageInfo`（就是画布尺寸和文件路径）。
2. **每帧 4 次文档信息 + 2 次 pixmap。** 现在每帧只有 **1 次** pixmap 调用，
   靠 `clipToDocumentBounds` 让 Photoshop 自己裁到画布，省掉了旧代码那个
   boundsOnly 预取和一整段 padding/extract 算术。
3. **`isGettingImage` 会永久卡在 true。** 旧代码的 `catch (error) { throw error }` 写在复位之前，
   JSON 读写一抛异常，这个标志就再也回不来了，录制静默死亡直到重启 PS。
   现在每次抓帧都有 30 秒看门狗，标志在 `finally` 里无条件复位。
4. **完全没有节流。** generator-core 自己都在日志里写着
   `WARNING the imageChanged event is expensive`，旧代码却对每个事件都抓一次。
   现在有自适应节流：下次间隔 = 上次耗时 × 3（夹在设定下限和 15 秒之间），
   一连串事件只会合并成一次抓帧 + 一次收尾补帧。

连续失败会**自动暂停并在面板上写明原因**，而不是悄悄不动了。

### 另存为不再把录制搞丢

Photoshop 有个很老的 bug：另存为会把文档里的 `generatorSettings` 清空。
3.x 只把录制身份存在那里，所以画到一半另存为，录制就断了，后面的帧进了一个新文件夹。

4.0 把身份同时写在三个地方，三者失效条件互不相同：

| 存放位置 | 扛得住 | 扛不住 |
|---|---|---|
| PSD 的 generatorSettings | 关闭重开 | 另存为 |
| 内存里的 documentId 映射 | 另存为 | PS 重启 |
| 磁盘上的恢复索引 | PS 重启 | 文档改名 |

任意一个都能把文档认回来，而且**一发现 PSD 里那份没了就立刻写回去**。
3.x 里那个手工补丁，变成了自动、永久生效的机制。

三个都对不上时（比如重启 PS 后打开一个陌生文件），会按画布尺寸列出候选让你选，
**绝不会自己认领** —— 认错了会毁掉一段录制，多开一个文件夹只是浪费点空间。

顺带把存储方式也改了，让它经得起意外：

- `session.json` 直接放在过程图文件夹**里面**，文件夹搬走、备份、拷到别的机器都不丢元数据。
- 帧文件名是 `<序号>_<时间戳>.jpg`。**没有独立的计数器文件可以失步了** ——
  帧数直接由目录内容决定。3.x 是把 count 存在另一个 JSON 里，而面板又用
  `readDir().length` 另算一遍，两边对不上。

### 版本覆盖到 2020–2026

一份源码出两份构建，因为这一段跨了三代浏览器内核：

| PS | 年份 | CEP | Chromium | CEP 里的 Node |
|---|---|---|---|---|
| 21.x | 2020 | CEP 9 | 61 | 8.6 |
| 22.x | 2021 | CEP 10 | 74 | 12.3 |
| 23.x – 25.11 | 2022–2024 | CEP 11 | 88 | 15.9 |
| 25.12+, 26.x, 27.x | 2024–2026 | CEP 12 | 99 | 17.7 |

所以：

- **面板 UI 不再用 React Spectrum**，改成自绘（Preact + 手写 CSS）。Spectrum 在
  Chromium 61/74 上必然排版错乱：flex `gap` 要 Chrome 84，`:focus-visible` 要 86。
  CSS 按 Chromium 61 的基线写，两份构建只差 JS 的编译目标。
- **加了一层 Node 兼容层。** 3.x 直接调 `fs.rmSync`（需要 Node 14.14），
  在 PS 2020/2021 的面板里必崩 —— 导出功能在那两个版本上其实一直是坏的。
  现在这类 API 全部特性检测 + 回落。

### 两个进程之间改用真正的通道

3.x 是两个进程隔着 JSON 文件互相喊话，各自 500ms 轮询一次。竞态、临时文件残留
（面板里还得专门写代码去删 `configData.json.*`），最要命的是**面板根本分不清
「没在录」和「录制进程已经死了」** —— 两种情况看起来都是数字不动了。

现在 Generator 在 `127.0.0.1` 上开一个只监听回环地址的 HTTP 端点，
用 SSE 把状态推给面板。面板变成纯客户端：它只负责显示和发命令，连不上就明说连不上。

安全上：只绑回环地址、每次运行随机生成 token、并且**拒绝任何带 `Origin` 头的请求** ——
浏览器没法在跨源请求里省掉这个头，而面板走的是 Node 的 http 模块（CEP 面板本来就带 Node），
从不发 Origin，所以这一条能干净地挡掉网页扫本地端口。

### 导出重做

- **不再依赖用户装了 Node.js。** 3.x 用 `spawn("node", ...)` 起一个 worker ——
  只有恰好装了 Node 并且在 PATH 上才跑得通，大多数 PS 用户并没有装，
  导出会以一句莫名其妙的 "Worker exited" 失败。现在直接调 ffmpeg。
- **ffmpeg 不再塞进安装包。** 之前是把一个 75 MB 的 ffmpeg.exe 一起打包，
  于是这个插件自己的代码只有 419 KB，下载包却几乎全是第三方二进制文件，
  仓库也因此被撑到 165 MB。现在安装脚本先在机器上找，找不到才去下载一份。
- **一次 ffmpeg 调用**代替原来的四趟（主视频 .ts + 片头 .ts + 片尾 .ts + concat）。
- **不再把每一帧复制到临时目录**，直接从原位置读。长录制能省掉一半磁盘 IO。
- 损坏的帧（比如崩溃时写了一半）会被跳过，而不是让整个导出失败。

---

## 开发

```bash
npm install
npm run build      # 构建 dist/（generator + legacy 面板 + modern 面板 + 脚本）
npm run check      # 类型检查 + 全部测试
```

测试用 `node --test`，不需要装 Photoshop：会话身份的各种场景、抓帧调度的状态机、
pixmap 通道解码、导出计划的生成、以及 Node 兼容层的回落，全部覆盖。
其中 `test/integration.test.mjs` 会加载**真正构建出来的 generator 产物**，
拿一个 mock 的 Photoshop 驱动它跑完整流程。

```
shared/          两端共用：协议、路径布局、Node 兼容层
generator/src/   抓帧引擎（在 Photoshop 的 Generator 进程里跑）
cep/src/         面板（Preact）和导出管线
scripts/         构建、安装、卸载、诊断
test/            单元测试 + 集成测试
```
