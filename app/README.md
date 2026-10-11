# 论文精读 Windows 正式客户端（`app/`）

基于 Tauri 的 Windows 正式客户端。Rust 承担本地能力、模型请求与阅读协议运行，JavaScript 承担界面与前端状态。支持导入、建图、深挖、复述稿和论文问答。云端同步尚未实现，任务注册表为内存态。

## 代码入口

- [bridge.rs](src-tauri/src/bridge.rs)：版本化命令与任务入口。
- [library.rs](src-tauri/src/library.rs)：本地书库与持久化。
- [protocol.rs](src-tauri/src/protocol.rs)、[model.rs](src-tauri/src/model.rs)：阅读协议运行与模型请求。
- [tasks.rs](src-tauri/src/tasks.rs)：任务生命周期。
- [pdfparse.rs](src-tauri/src/pdfparse.rs)、[pdfpool.rs](src-tauri/src/pdfpool.rs)、[pdfassets.rs](src-tauri/src/pdfassets.rs)：解析侧车、常驻池与页图/裁切图。

以下桥接说明用于入门，命令与任务类型以代码和契约测试为准。

## 桥接形状

- `bridge_invoke(command, input)`：短时、幂等或事务性操作。命令名带版本后缀（`app.info@1`、
  `bridge.echo@1`、`tasks.*@1`、`library.*@1`、`files.*@1`、`migration.*@1`、`settings.*@1`、
  `skills.list@1`、`exports.write@1`、`dialog.*@1`、`app.close-window@1`）。
- `bridge_start(taskKind, input)`：长任务，返回 `{ schemaVersion, taskId }`；
  事件经 `task:{taskId}` 通道推送（`chunk` / `progress` / `status`），终态可用 `tasks.get@1` 查询。
  任务类型：`model.chat@1`（流式模型调用）、`model.test@1`（连接测试）、
  `net.fetch-text@1`（网页文本抓取）、`files.download@1`（整文件下载落附件）、`demo.*@1`（演示）。
  模型与网络失败按统一策略自动重试（retry_waiting → 退避 → 重试，共 3 次）；
  流式 chat 一旦已产出内容块即不再自动重试，避免重复内容。
- `model.chat@1` 成功终态的 `result.text` 保留完整正文，用于补齐事件订阅建立前漏收的 chunk；流式预览仍由 chunk 驱动。
- 与接口规格措辞的对应：`invoke` → `bridge_invoke`，`start` → `bridge_start`，
  `subscribe(taskId)` → 监听 `task:{taskId}` 事件，`getTask(taskId)` → `tasks.get@1`。
- 每个响应包含 `schemaVersion`；错误统一为 `{ code, message, retryable, details }`。
- 任务状态：`queued`、`running`、`succeeded`、`failed`、`cancel_requested`、`cancelled`、`retry_waiting`；
  取消请求幂等，只在安全检查点停止。
- 窗口关闭时若仍有运行中任务，Rust 阻止关闭并发出 `app:close-requested` 事件；
  前端选择“等待任务完成”（任务全部结束后自动退出）或“停止任务并退出”。

## 运行与验证

```bash
cd app
npm install            # 安装 @tauri-apps/cli

npm run tauri dev      # 开发模式（带控制台）
npm run tauri build    # 安装包：src-tauri/target/release/bundle/nsis/*-setup.exe

npm test               # JavaScript 桥接客户端契约测试（node --test）
npm run test:rust      # Rust 桥接与任务生命周期测试（cargo test）
npm run smoke          # 不开窗口的桥接冒烟检查（debug 构建，退出码 0/1）
```

发布构建不带控制台；`--bridge-smoke` 请用 debug 构建运行。

### PDF 原生窗口验收

Windows 上安装项目 npm 依赖，以及 Python `pypdf`、`Pillow`、`pymupdf` 后运行：

```powershell
npm run test:pdf-webview
```

此命令用专用 Tauri 测试宿主运行真实 WebView2、Rust 桥、SQLite 和附件存储，页面使用未修改的 `ui/`，模型请求发往临时本机 SSE 服务。使用独立应用标识并先核对原生书库目录；不读取正常书库或模型凭据。测试程序从临时目录启动，避免迁移开发目录旁的旧解析组件。窗口尺寸调整权限只存在于测试配置，正式客户端权限不变。不要与物理窗口走查同时运行，窗口失焦会按真实取消规则中断拖动。

运行记录和截图保存在仓库根 `tmp/pdf-webview-<时间戳>/`；独立测试书库路径记录于 `report.json`，保留供失败排查。测试退出会关闭自己的窗口与本机服务，并恢复普通配置的库构建。正常 `node --test` 不启动此窗口。夹具包含真实双栏论文、由 10 篇论文合并的 150 页 PDF、混合页尺寸、位图扫描页和图形公式。

CDP 合成鼠标、滚轮及 DOM Range 证明原生交互链路，不能代替物理鼠标、触控板或真实图像模型质量验收。旧 schema 迁移仍由 Rust 契约测试覆盖；窗口里的旧页码 DTO 恢复单独检查。该命令也不证明安装版升级和签名更新路径。

阅读画布每页最多 400 万像素（RGBA 约 16 MiB），高倍缩放超过预算时降低位图分辨率，文字层和选区坐标保持原缩放。测试另用 12 页、300 DPI 模拟扫描论文执行短序列，记录进程树工作集、私有内存、单进程归因（按 paper30min 与 WebView2 进程角色聚合的峰值/末值）、停止交互后的占用及 idle 后半段最小值（settled 稳态），不以固定进程内存阈值判定通过。解读时区分两个口径：压力期峰值是缩放输入密度决定的瞬时占用，Chromium GPU 缓存归还周期长于 5 秒，短 idle 会把"尚未归还"计成"占用"；评估稳态用 `PAPER30MIN_PDF_MEM_IDLE_MS`（默认 5000）拉长等待、`PAPER30MIN_PDF_MEM_TEARDOWN=1` 在 idle 前返回书库（产品行为保留 viewer，仅切换视图）。默认只测当前代码；设置 `PAPER30MIN_PDF_BASELINE_REF` 为修改前的 Git 提交时，分别冷启动旧阅读器和当前阅读器做同输入对照。仅阅读器模块替换为指定提交，其余模块均使用当前代码；报告记录基线提交及源码摘要。这是 Debug 宿主测量，不代表安装版 Release 的内存表现。

针对性复测可用 `PAPER30MIN_PDF_CHECK_FILTER` 正则筛选检查名（例如 `reader raster` 仅执行资源与内存检查）；报告保留过滤条件及跳过项，不视为完整套件通过。

### 主界面窄窗口验收

Windows 上运行 `npm run test:layout-webview`，使用隔离的原生 WebView2 宿主，检查书库、已建图阅读页与原文页在 430×760 等价视口下没有文档级横向溢出，并检查恢复到 1280×900 后的左右栏布局。程序同时调整原生窗口与 CDP 视口，以避免 Windows 非整数 DPI 尺寸舍入影响断言；报告及截图位于根目录 `tmp/com.paper30min.layout-<时间戳>/`。不读取正常书库或模型凭据。

### 安装版矩阵与阅读性能基线

Windows 上安装 npm 依赖及 Python `pypdf`、`Pillow`、`pymupdf` 后运行 `npm run test:installed-webview`。从本地 `main` 和当前 `HEAD` 的 Git 快照分别构建 1.3.0 与 1.4.0-beta.1 的 Release NSIS 包；使用独立产品名称、应用标识及临时测试签名，不读取正常书库或正式私钥。未提交的产品改动不在构建范围内。先执行签名字节校验，再通过 NSIS 静默安装验证默认路径、自选含空格路径、安装后启动和重启，以及旧版独立创建书库后的原地升级；升级核对笔记、阅读位置和全部 PDF 字节。

矩阵还验证两种路径的保留书库卸载与重装、历史 1.3.0 卸载器产生的孤立安装目录记录恢复，以及残留程序和其他产品身份的拒绝保护。卸载使用正常临时复制流程，等待程序文件及卸载项清理完成，再检查安装身份；验收和复测准备均不手动清理孤立注册表记录。只复测安装行为时设置 `PAPER30MIN_INSTALL_ONLY=1`，跳过阅读性能测量。

只验证连续缩放时设置 `PAPER30MIN_ZOOM_ONLY=1`：从当前 `HEAD` 构建并安装隔离的新版包，逐份执行滚动、100 次缩放及停止后的再次缩放，省去旧版构建和安装矩阵。停止输入后最多等待 10 秒，要求每个可见页都有匹配最终尺寸的画布、内容非空且加载提示已隐藏；高倍缩放的目标尺寸遵循每页 4 Mi 像素预算。该模式仍记录输入区间 FPS/P95 和进程树内存，性能分诊线不决定缩放验收结果。复用同一 `HEAD` 的缩放安装时，同时将 `PAPER30MIN_READING_REPORT` 指向该模式的报告。

提交前验证安装器修改可设置 `PAPER30MIN_INSTALLED_NSIS_WORKTREE=1`：仅将当前工作区的 `windows/installer.nsi` 覆盖到新版 Git 快照，报告记录该文件的 SHA256，其余产品代码仍取 `HEAD`；该选项不能与安装包复用同时启用。之后按下文复用这类报告时，还会核对当前安装器模板与报告中的 SHA256，防止复用过期的工作区产物。

提交前验证阅读器修改可设置 `PAPER30MIN_INSTALLED_READER_WORKTREE=1`，同样仅覆盖 `ui/js/pdf-reader.js`，记录并在复用时核对 SHA256；该选项不能与安装包复用同时启用。

在升级后的安装版窗口中，测量 150 页合并论文、3 页混合尺寸 PDF 和由真实 ResNet 论文栅格化的 12 页 300 DPI 模拟扫描版。通过 CDP 合成滚轮与缩放按钮输入，记录 `requestAnimationFrame` 回调帧率、帧间隔 P95，以及应用和 WebView2 进程树工作集与私有内存采样峰值。内存采样间隔为 500 ms 等待加进程枚举时间，以采样文件的实际时间戳为准；工作集相加包含进程间共享页的重复计数，不是系统物理内存独占量。缩放统计包含最终重绘等待。分诊线为低于 45 FPS、P95 超过 50 ms 或工作集超过 1 GiB；超标仅记录，不自动优化。报告、内存采样和截图位于根目录 `tmp/installed-<时间戳>/`，结论归 Linear。

物理窗口使用系统当前 DPI，不覆盖其他 Windows 显示缩放档位。回调帧率不能替代物理显示呈现帧率；模拟扫描版不能替代真实扫描质量验收。该入口也不证明正式签名、远端附件、应用内更新或组件安装。测试不会上传安装包。结束后保留隔离测试安装与书库供排查，临时私钥自动清除。需要复测时，可将 `PAPER30MIN_INSTALLED_ARTIFACTS` 指向同一 `HEAD` 的既有 `report.json`，重新核对包哈希与签名后复用安装包；会卸载该报告的独立测试安装并移出其测试书库，重新执行矩阵。只补测性能时，用 `PAPER30MIN_READING_REPORT` 指向安装矩阵报告；保留原矩阵证据，仅重新启动其隔离安装并测量。报告分别保存输入区间和含最终重绘等待的整体帧率，性能分诊使用输入区间指标。

### 更新停流原生窗口验收

Windows 上安装项目 npm 依赖后运行：

```powershell
npm run test:updater-webview
```

复用隔离 WebView2 宿主和真实更新命令，本机端点分别模拟检查响应停流、下载响应头停流、下载正文停流和签名不匹配。检查入口及安装前二次检查的期限为 20 秒；下载以实际非零字节进展重置 30 秒空闲期限，不设置整包总时长。验签成功后才发送下载完成事件并调用插件安装；安装期间持续占用准入，不施加下载空闲期限。

验收检查超时后 UI 重试、下载连接关闭、任务与组件互斥及恢复，并保存 1280 px 原生宽窗口和 CDP 模拟的 430 px 窄视口截图。测试配置使用独立应用标识、测试公钥和本机更新端点，正常书库、正式公钥及更新端点不变。夹具仅替换确认对话框的 IPC 响应，验证安装确认和活动任务二次确认的接受与取消；原生确认框的显示和实际点击未验证。更新入口通过现有 `dialog.message` 的 `OkCancel` 结果等待确认，不调用插件中已失效的 `window.confirm` 替换实现。

原生夹具的完整下载故意篡改字节，使签名验证失败，不执行安装器；持续慢速分块、正确签名和版本验证、安装边界的准入保持由 Rust 更新器测试覆盖。真实签名安装包的升级、安装路径和旧书库保留仍须另行验收。

运行记录保存在根目录 `tmp/updater-webview-<时间戳>/report.json`；退出关闭自己的宿主与服务，并恢复普通配置的库构建。普通 `node --test` 不启动该窗口。Rust 测试使用 Tauri mock runtime；构建脚本为 Windows 测试程序生成 Common Controls v6 manifest，隔离窗口宿主显式嵌入该 manifest 后从临时目录启动。

### 解析结果安全发布验收

解析方式由设置页全局二选一决定：选择百度后，只有回到设置页改选本地才能使用本地组件。未安装本地组件不能选本地，未配置云端凭据与上传确认不能选云端；右侧箭头仍可进入配置。阅读页不提供解析方式选择或历史浏览；“重新解析”与“重新建图”并排，重新解析读取设置中的服务，成功后覆盖当前结果，失败或取消保留原结果。解析结果先封存为不可变批次，完整候选校验通过后再在 SQLite 事务中切换当前指针。普通保存携带原批次身份，迟到写入不能覆盖新解析。同一解析补全视觉资源保留已有建图成果；首次本地解析仍允许模型先于图片就绪。

书库导出使用版本 2，包含当前及历史批次、选区截图和回想卡图片。原生导入校验资源摘要、大小与引用，兼容版本 1 及无版本旧书库；浏览器导入不能恢复原生批次时明确拒绝。旧本地模型没有原始 Docling 来源、且无法从可信缓存恢复时，需要重新解析才能发布新的视觉批次。

```powershell
$env:PAPER30MIN_U6 = '1'
node tests/integration/cloudassets-webview.mjs
Remove-Item Env:PAPER30MIN_U6
```

复用隔离 WebView2 宿主与已有离线百度结果，验证发布拒绝、过期保存、重启、完整依赖导出导入及阅读界面。报告与截图位于根目录 `tmp/com.paper30min.cloudassets-webview-<时间戳>/`。这不证明真实云服务质量或安装版升级；本地 WebP 校验覆盖容器、尺寸与摘要，不是完整像素解码。

补验阅读界面时，可将 `PAPER30MIN_U6_READER_REPORT` 指向已通过的完整 `report.json`，复用其隔离书库及真实封存资源，仅重跑阅读和离线显示检查。新报告的 `reusedReport` 标明来源；准备、发布和迁移结果仍以原报告为准。

### 云端解析设置与恢复原生窗口验收

Windows 上安装项目 npm 依赖后运行：

```powershell
npm run test:cloudparse-webview
```

复用隔离 WebView2 宿主与未修改的 `ui/`，覆盖 14 项检查：云端桥接命令注册与凭据脱敏、本地组件与云端配置的分设入口、解析方式选择保存与重载保持、缺失上传确认时三个导入入口均落入设置且不改书库、中断任务带 jobId 恢复、远端失败重新提交的计费确认、设置读取失败重试与并发导入只启动一次，以及离线云端候选建图后回叠原始 PDF 来源。云端提交、arXiv 下载与系统确认框由页面内夹具替代，设置、书库与附件处理保持真实原生链路；真实百度调用与原生确认框显示不在此验证。

运行记录与截图保存在仓库根 `tmp/com.paper30min.cloudparse-webview-<时间戳>/`；退出关闭自己的窗口与服务，并恢复普通配置的库构建。正常 `node --test` 不启动此窗口。

### 网络代理与直连

设置的「网络代理」页可选择「自动代理」或「直连」，点击保存后写入本机书库。旧书库默认自动代理；自动模式沿用进程环境变量及 Windows 系统代理 / 绕过规则。直连跳过这些代理配置，适用于模型连接测试、普通对话、阅读协议、文本抓取、论文附件下载、解析组件 ZIP 下载及应用更新检查 / 下载。保存后后续请求立即采用新模式，已经发出的请求继续使用其原模式。

模式不改变 API 端点或操作系统路由，不能保证国内出口，也不绕过系统级 VPN / TUN。PDF 解析侧车是独立 Python 进程，其 Hugging Face 模型下载仍使用侧车自己的网络配置；外部链接使用系统浏览器。本次没有实现手动代理地址。

Windows 原生验证入口：

```powershell
npm run test:network-webview
```

隔离 WebView2 宿主继承本机夹具代理变量，验证自动模式进入代理、直连到达本机模型和下载端点、运行中切换、页面重载及 1280 / 430 px 设置页布局。更新包使用故意篡改的签名字节，验证下载路径但不执行安装器。组件下载的代理 / 直连由 Rust 子进程契约验证，避免修改并行测试的代理环境。报告与截图位于根目录 `tmp/com.paper30min.network-webview-<时间戳>/`。本机夹具不能证明真实百炼端点可用，需用户使用原端点复测。

## Windows 更新与发版核对

v1.2.0 正式版仅更新主程序；解析组件继续使用 v1.2.0-beta.1 的 ZIP、内置哈希及下载地址，不重新打包。v1.1.0 用户需手动运行新版安装包；Beta 用户也可手动升级。更新沿用 `com.paper30min.reader` 的 currentUser NSIS 安装身份，书库仍位于 Tauri 应用数据目录。主程序安装包不含 Docling：新安装用户可在设置的「服务」页按需下载或选择本地 ZIP 安装解析组件。未安装组件时仍可查看 PDF 与已有阅读内容，新 PDF 的结构化解析和页图生成不可用。v1.1.0 原地升级时安装器锁定旧安装目录并保留旧侧车，首次启动复制到用户本地组件目录；迁移失败可在设置中重试。安装前应备份现有书库，并等待生成任务完成或确认取消。

1. 将 Tauri updater 私钥及密码保存在仓库外并独立备份；公钥在 `src-tauri/tauri.conf.json`。私钥丢失后，已安装版本将无法验证后续更新。Windows 代码签名与 updater 的 `.sig` 是不同事项，应分别核对。不要把私钥、密码或组件包提交到仓库。
2. 核对 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 都是同一版本。使用 `TAURI_SIGNING_PRIVATE_KEY`（私钥路径或内容）和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 环境变量运行 `npm run tauri build`，不要把凭据写进 `.env`、命令日志或仓库。
3. 核对已发布的 Beta.1 组件 ZIP 和清单与 `src-tauri/component-release.json` 一致；本次不重新生成或上传组件包。后者的 SHA-256 编入主程序，用于下载安装和本地 ZIP 安装校验。
4. 核对 `src-tauri/target/release/bundle/nsis/Paper30Min_<version>_x64-setup.exe` 与相邻 `.sig`。在仓库根目录运行以下检查；`verify` 会用更新器公钥核对安装包字节、签名注释中的文件名及清单一致性：

   ```powershell
   node tools/release_manifest.mjs create --installer app/src-tauri/target/release/bundle/nsis/Paper30Min_1.2.0_x64-setup.exe --component app/src-tauri/target/release/component/Paper30Min_pdfparse_1.2.0-beta.1_windows-x86_64.zip --component-manifest app/src-tauri/target/release/component/Paper30Min_pdfparse_1.2.0-beta.1_windows-x86_64.manifest.json --tag v1.2.0 --manifest app/src-tauri/target/release/latest.json
   node tools/release_manifest.mjs verify --installer app/src-tauri/target/release/bundle/nsis/Paper30Min_1.2.0_x64-setup.exe --component app/src-tauri/target/release/component/Paper30Min_pdfparse_1.2.0-beta.1_windows-x86_64.zip --component-manifest app/src-tauri/target/release/component/Paper30Min_pdfparse_1.2.0-beta.1_windows-x86_64.manifest.json --tag v1.2.0 --manifest app/src-tauri/target/release/latest.json
   ```

5. 用 `src-tauri/tauri.test-updater.conf.json` 构建隔离安装身份，并由本机测试端点 `127.0.0.1:18437` 提供较新版本的签名清单和安装包，实际走查下载、签名拒绝、安装及书库保留。正式构建不使用该测试配置。
6. 完成最终差异审查后发布正式版，并如实记录未完成的安装版走查。正式版 Release 仅附主程序安装包、`.sig` 和 `latest.json`；解析组件继续从 Beta.1 Release 下载。发布前重新核对安装包字节签名与清单。本机与 GitHub CI 的实际检查状态分别记录，CI 因账户问题不可用时不记为通过。

## 界面结构（`ui/`）

- `ui/index.html` + `ui/style.css` + `ui/js/main.js`：阅读界面（书库 / 阅读 / 任务中心三个视图）。
- `ui/js/` 领域模块：`papers.js`（论文记录生命周期）、`generation.js`（精读生成编排）、
  `skills.js`、`markdown.js`、`parser.js`（PDF/arXiv/文本解析）在客户端内维护；
  `store.js` 负责 `library.*@1`/`files.*@1` 存储适配，`model.js` 负责设置缓存与 `model.*@1` 任务封装。
- `ui/vendor/` 内置 pdf.js、MathJax，`ui/samples/` 内置示例论文；技能文件由 Rust 编译期内嵌
  （`skills.list@1`），内置技能副本有同步测试防漂移。
- 任务中心从主导航进入，显示全部任务的七态与进度，支持取消与失败重试；
  阅读位置（视图/精读部分/PDF 页码）经 `library.*ReadingPosition@1` 持久化，重开论文时恢复。

## 数据位置

应用数据目录由 Tauri 管理（`app_data_dir`，标识 `com.paper30min.reader`）。首次启动会创建
`database/`、`attachments/`、`operations/`、`exports/`，并在 `database/library.sqlite`
建立版本化书库（v3 起含 settings 表：模型设置与技能覆盖；API Key 只存此处，
不进入论文 DTO、迁移数据与整库导出）。JavaScript 只通过 `library.*@1`、`files.*@1` 与 `migration.*@1` 命令读写领域 DTO，
不依赖表结构，也不接触附件绝对路径。PDF 和其他附件按 `attachments/{paperId}/` 分区保存，
写入使用临时文件后原子改名；`files.readRange@1` 提供按字节范围读取，供在线阅读按页取数。
浏览器书库通过 `migration.inspect@1` 预检整库 JSON（不修改书库），再用 `migration.commit@1`
提交对应预检令牌；按论文 ID 合并记录与附件，不导入 API Key 或应用设置。源文件变化或令牌过期
必须重新预检；提交失败不改写原导出文件。导入文件上限 512 MB。预检由 Rust 读取导出文件，
结果 DTO 不含绝对路径；提交前请自行保留原导出文件。
