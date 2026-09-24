---
title: v1.2.0 更新器、建图恢复与可选本地解析 - Plan
type: feat
date: 2026-09-24
topic: v1-2-updater-map-recovery
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# v1.2.0 更新器、建图恢复与可选本地解析 - Plan

## Goal Capsule

- **Objective:** v1.2.0 发布后，用户能用较小的主程序包升级并自行决定是否安装本地解析组件；能在应用内安装后续版本；建图失败时能从缺口继续，参考文献和附录不进入新地图。
- **Product authority:** 本计划采用用户本轮提出的 v1.2.0 范围；`STRATEGY.md` 和 `CONCEPTS.md` 约束既有阅读及本地书库语义。`docs/ideation/2026-09-24-paper30min-v2-revision.md` 中“v2.0.0 起交付更新器”的时间安排由本计划取代。
- **Means:** 利用现有 L2 部分产物和块模型附件做可校验的续跑；按块模型角色控制建图范围；使用 Tauri 2 updater 更新主程序，并把完整 Docling 运行环境及模型作为独立组件分发。
- **Execution profile:** 在 `steven123397/dev` 直接开发；代码品质升级已完成，更新器和建图改动已在工作区推进。后续会话先核对当前差异，再补齐本次新增范围，避免重做已实现部分。
- **Stop condition:** 若[发布前审查](../reviews/2026-09-24-v1.2-pre-release.md)的阻断项未修复并复审、签名密钥无法安全保存、更新链路不能在 Windows 安装版验证、v1.1.0 侧车迁移可能被安装器删除，或续跑会错误复用已变化的原文，不发布 v1.2.0 正式版。

---

## Product Contract

### Beta 发布顺序

先以 `v1.2.0-beta.1` GitHub 预发布交付两个测试下载包，供用户在隔离云主机验证安装与升级；不上传稳定端点使用的 `latest.json`，解析组件下载地址指向同一预发布。Beta 必须先通过本机测试、修复复审、签名及清单核对。云主机验收后再决定是否发布正式 `v1.2.0`；正式版需重新构建、签名并完成本计划的安装版验收门槛。

### Summary

v1.2.0 将已完成的客户端代码品质升级与四项改动一起交付：应用内更新、建图失败后的续跑、跳过参考文献和附录的建图，以及用户可选的本地 Docling 解析组件。正式 Release 提供两个用户下载包：不含侧车的主程序 NSIS 安装包，以及独立的本地解析组件包。

### Problem Frame

v1.1.0 的建图任务曾在 16 个 L2 节中完成 15 个、1 个失败后以整体失败结束；重试再次请求全部 L2。参考文献已被排除，附录仍参加建图。v1.2.0 工作区已在处理这些问题及更新器，安装版尚待验证。v1.1.0 的 NSIS 安装包把约 1.5 GB 的 Docling 侧车放在程序目录；当前 v1.2.0 打包配置仍包含它。旧安装器若先卸载 v1.1.0，侧车会随程序目录消失；现有 `download` 变体虽可补装依赖和模型，却仍将 Python 骨架随包安装，前端也没有组件管理入口。

### Requirements

- R1. v1.2.0 安装版显示当前版本，能检查稳定版更新、显示版本说明、下载进度和错误，并由用户确认安装；无更新、离线、下载失败均有明确状态。
- R2. v1.2.0 是第一个带更新器的版本；v1.1.0 用户需手动运行一次 v1.2.0 主程序安装包。此后同一 Windows 安装身份下，主程序更新不破坏本地书库、附件或已安装的解析组件。
- R3. 建图的某个 L2 节失败或被取消时，已完成节保留；再次建图只请求尚未完成或无法安全复用的节，完成后再生成 L1。
- R4. L1 合成失败后，完整 L2 仍可用于下一次续跑；用户明确选择“重新建图并覆盖”时可以从头重建。未凑齐必要 L2 时任务仍应准确报告失败，不把不完整地图标为成功。
- R5. 续跑不得把旧块模型的 L2 用到已变化的原文上；从 v1.1.0 留下的无来源指纹部分结果保留可读，但升级后的首次续跑应重新生成这些节。
- R6. 新建或重建地图时，`References`、`Appendix` 和 `Acknowledgments` 不进入 L2 请求、L1 结构或精读进度域；它们仍保留在原文、PDF 和块模型中供阅读与取证。
- R7. 已有论文、译文、问答、已读标记及已生成的附录产物不得在升级时被静默删除；需要改变旧地图时由明确的重建操作处理。
- R8. 发布 v1.2.0 前核对代码品质改动、目标分支、版本一致性、Windows 安装和升级、两个下载包及其校验信息、签名清单与书库兼容性；不把未运行的 GitHub CI 记为通过。
- R9. 主程序包不得包含 Docling、嵌入式 Python、解析依赖或模型；新安装用户可以不安装本地解析组件，仍能打开已有论文产物和用 PDF 查看器阅读原文件。未安装组件时，新 PDF 的结构化解析及依赖侧车的页图、裁切生成明确提示不可用，不自动下载。
- R10. 应用提供本地解析组件的安装状态、下载量与预计落盘占用、下载安装进度、取消、重试及用户确认的卸载入口。组件作为完整运行单元独立于主程序安装目录和书库保存，下载或升级失败不得覆盖已验证可用的版本；卸载不得删除论文、PDF 或已有解析产物。
- R11. v1.1.0 已安装的有效侧车在用户手动安装 v1.2.0 主程序包时迁移并复用，不重复下载组件。检测到旧版时，安装器自动沿用注册的旧安装目录，固定走不卸载的原地更新，不允许本次升级改到另一目录；旧侧车缺失、损坏或不兼容时，主程序仍能升级并提供组件下载，不能误报为已就绪。旧安装目录无法确认时，安装器须在触碰旧版前停止并说明处理方式。
- R12. 本版只提供本地 Docling 解析选项；云端 OCR API 和多模态解析仍待同集验证与块模型适配，不显示为可用后端。选择不安装本地组件的用户在 v1.2.0 暂时无法为新 PDF 建立块模型；已有块模型与阅读产物继续可用。

### Acceptance Examples

- AE1. 第 16 节失败而前 15 节完成时，重试只调用失败节；补齐后生成一份 L1，已完成 15 节不再次计费。
- AE2. 所有 L2 已完成但 L1 失败时，下次只重试 L1；块模型附件被替换后，旧 L2 不可直接复用。
- AE3. 含正文、参考文献和多节附录的论文只为摘要及正文请求 L2；原文和 PDF 仍可查看附录及文献。
- AE4. v1.2.0 安装版检查到经签名的较新测试版本后能完成更新；损坏签名或断网不覆盖现有程序或书库。
- AE5. 干净账户仅安装主程序包后可启动并查看导入的 PDF；导入已有书库副本后，已有阅读产物仍可查看。首次请求新 PDF 解析时提示安装本地组件，用户拒绝后不产生下载或残缺块模型。
- AE6. 已安装 v1.1.0 且侧车完整的账户只下载主程序包即可升级；无论 v1.1.0 安装在默认目录还是用户自选目录，v1.2.0 都沿用该目录。升级后侧车自检、PDF 解析和页图生成通过，不重新下载组件，书库及附件保留。
- AE7. 组件下载中断、空间不足、校验失败或安装取消时，状态与重试入口明确，残缺文件不被激活；卸载组件后已解析论文仍可阅读，重新安装后可继续解析。
- AE8. v1.2.0 安装版更新到较新测试主程序时，已安装组件仍在且可用；组件未安装时，应用更新不强制下载它。Release 恰有两个用户下载包，主程序更新清单只指向主程序包。

### Scope Boundaries

本计划不交付 v2 阅读布局、PDF 文字层、云端 OCR 或多模态解析后端、云同步及 Android。本地组件下载与主程序更新是两条独立链路；模型随本地解析组件一起交付，不另发第三个模型包。v1.1.0 无更新器，不能从该版本直接应用内升级。

### Sources

- 用户本轮反馈及建图任务截图；`app/src-tauri/src/protocol.rs`、`app/ui/js/main.js`、`app/ui/js/protocol.js` 和 `app/src-tauri/tests/protocol_contract.rs` 的当前行为。
- [Tauri 2 Updater](https://v2.tauri.app/plugin/updater/)：Windows NSIS 更新产物、强制签名、静态 JSON 端点和安装时退出行为。
- [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/) 与 [NSIS 安装器模板](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)：原地更新、先卸载旧版的手动安装选项，以及安装钩子的运行时机。
- `app/src-tauri/tauri.conf.json`、`app/src-tauri/Cargo.toml`、`app/package.json`、`.github/workflows/ci.yml`、`docs/current.md`：现行发布配置和验证状态。
- `tools/pdfparse-sidecar/build_sidecar.py`、`app/src-tauri/src/pdfparse.rs`、`app/src-tauri/src/pdfassets.rs`、`app/ui/js/main.js`：现有 `bundled` / `download` 构建、侧车查找与状态、`pdfparse.bootstrap@1` 及前端调用边界；`docs/ideation/2026-09-24-paper30min-v2-revision.md` 记录体积与云端方案尚未验证的限制。

---

## Planning Contract

### Key Technical Decisions

- KTD1. **用 Tauri 官方 updater 更新主程序。** NSIS 主程序安装包不带侧车；`latest.json` 只指向签名的主程序安装包，不把组件包交给 Tauri updater。签名私钥不得进入仓库，公钥随应用发布；Windows 代码签名与 updater 签名分别核对。落实 R1、R2、R8-R10。
- KTD2. **续跑以论文块模型来源和节身份校验。** 已完成 L2 以现有 `protocol_products` 保存，新增来源指纹或等价校验信息；恢复时还要复核节 ID、角色和产物形状。v1.1.0 无指纹的部分结果无法可靠证明原文未变，保留给用户查看，但首次续跑重新生成；此后 v1.2.0 的有效部分结果才自动复用。用户选择完整覆盖时不使用缓存。落实 R3-R5、R7。
- KTD3. **L1 只在所有必要 L2 有效时产生。** 节失败时保留完成项并返回具体失败节；L1 失败也保留 L2。任务中心区分续跑与完整覆盖，显示复用数、待补数和真实失败原因。落实 R3、R4。
- KTD4. **角色过滤在 Rust 协议与 JavaScript 纯逻辑两侧一致。** 只让摘要和正文参加新地图；L1 图表清单与结构校验遵循同一范围。保留块模型原文及旧产物，不通过解析器删除附录。落实 R6、R7。
- KTD5. **首版更新器只服务 Windows 稳定版。** 设置中的版本检查和安装通过 Rust 命令封装 Tauri updater，沿用现有无构建步骤的 JavaScript 桥接；活跃生成任务结束或取消后才安装。使用单独的测试更新端点验证较新版本，避免污染稳定版 `latest.json`。落实 R1、R2、R8、R10。
- KTD6. **本地解析组件是独立的完整运行单元。** 从当前 `bundled` 侧车构建经校验的组件包，包含 Python、钉版依赖、脚本和必需模型；主程序不沿用现有只含 Python 骨架的 `download` 变体。组件落在当前用户的应用管理目录，独立于安装目录与论文书库；先下载到暂存目录并检查版本、架构、大小及组件签名（或签名主程序内置的预期哈希），通过自检后再切换活动版本。落实 R9、R10、R12。
- KTD7. **v1.1.0 侧车通过同目录原地升级保留。** 主程序安装器从旧版注册信息读取安装目录，识别相同 `currentUser` 安装身份后，在旧版卸载选择之前固定进入不卸载的 NSIS 更新路径，并锁定该目录；仅全新安装允许选择路径。不能依赖用户手动选择“不要卸载”，也不能仅靠 `NSIS_HOOK_PREINSTALL`，因为它运行在该选择之后。安装后将有效旧侧车迁入组件目录，迁移失败时保留原副本并提供重试。落实 R2、R10、R11。
- KTD8. **v1.2.0 不暴露尚未实现的云端解析选项。** 解析状态区分未安装、下载中、校验中、就绪、失败和待重试；新 PDF 转块模型及侧车页图/裁切任务只有在本地组件就绪时启动。已有块模型、阅读产物与 PDF.js 查看器不依赖新下载。落实 R9、R10、R12。

### Risks and Compatibility

- `protocol_products` 的 L2 以 `partId` 存储；排除附录会改变精读部分与进度域。核对 `app/ui/js/view.js`、`app/ui/js/papers.js`、`app/tests/papers.test.mjs`，确保旧附录标记和深挖产物不会被删除或误算为当前进度。
- v1.1.0 部分产物缺少来源指纹，升级后的首次续跑可能仍需重新生成已完成节；此限制应在发布说明中说清楚。通过“块模型替换、章节顺序变化、旧产物缺字段”用例验证复用边界。
- updater 安装在 Windows 上会退出应用。书库写入和任务取消必须先结束；主程序更新与较大的组件下载都需处理失败和磁盘不足。更新后更高版本数据库不保证旧程序可直接读取，升级走查须使用一致性书库备份。
- 现有 `download` 变体在程序目录补装 Python 依赖，模型落在书库目录，不能直接满足独立安装和跨主程序升级复用。组件包应采用单独目录和明确的版本、校验与回滚语义；暂存和解压可能需要高于最终组件大小的空闲空间，界面不能只显示压缩包大小。
- v1.1.0 侧车在旧程序目录中。NSIS 常规手动升级可先卸载旧版；若主程序包不带侧车，原目录被清理后无法补救。升级前的检测、原地更新/迁移和失败回退必须用真实 v1.1.0 安装版验证，不能只运行开发版。
- Tauri NSIS 会读取上次安装目录作为默认值，但手动安装的目录页允许改路径。若本次轻量升级改到另一目录，不卸载原地安装会留下旧程序和旧侧车，v1.2.0 也可能找不到它；因此升级必须固定旧路径，路径记录缺失时先停止，不按新安装继续写入。
- `pdfassets.prerender@1` 的页图与裁切仍使用侧车；不安装组件时，PDF.js 查看器和已存阅读内容可用，但这些新产物及新 PDF 解析不可用。云端 OCR 接入将来还要满足章节、页码、图表与坐标的块模型契约，不能只返回文字。
- GitHub CI 当前因账户问题不可用。发版记录须区分本机通过与远端未运行，不能把发布流程自动化的存在当作实际验证。

### Deferred Implementation Details

来源指纹放在 L2 body 还是附属元数据、更新 UI 的具体控件排列、组件包的压缩格式，以及发布脚本的文件名由实现时依现有接口确定；不得改变 KTD2 的复用判据、R1 的用户可见状态或 KTD6-KTD7 的校验与迁移边界。

---

## Implementation Units

### U1. Align Map Scope

**Goal:** 新地图只覆盖摘要与正文，并保持旧书库可读。

**Requirements:** R6、R7；AE3。

**Dependencies:** 无。

**Files:** `app/src-tauri/src/protocol.rs`、`app/ui/js/protocol.js`、`app/ui/js/view.js`、`app/ui/js/papers.js`、`app/src-tauri/tests/protocol_contract.rs`、`app/tests/protocol.test.mjs`、`app/tests/papers.test.mjs`。

**Approach:** 在 Rust 和 JavaScript 的章节及精读部分映射中统一排除附录、参考文献与致谢；L1 输入和输出校验采用相同参与集。显式重建旧地图时处理旧附录 L2 的展示与进度，但不静默删除旧深挖、译文和标记。

**Test scenarios:**

- 块模型含摘要、正文、参考文献和连续多节附录时，L2 请求数、L1 结构和新精读部分只对应摘要与正文。
- 只有附录和文献、无可建图正文的异常块模型返回清楚结果，不把附录误作正文。
- 旧书库已有附录 L2、深挖与已读标记时，安装和打开仍能读取；明确重建后当前进度域不计附录，历史数据不静默丢失。

**Verification:** Rust/JS 角色契约一致，真实含附录论文的任务流与阅读页检查通过。

### U2. Resume Map From Valid Partial Results

**Goal:** 节或 L1 失败后继续缺口，不重复请求可靠的已完成节。

**Requirements:** R3-R5、R7；AE1、AE2。

**Dependencies:** U1 的参与节集合。

**Files:** `app/src-tauri/src/protocol.rs`、`app/src-tauri/src/tasks.rs`、`app/ui/js/main.js`、`app/ui/js/present.js`、`app/src-tauri/tests/protocol_contract.rs`、`app/tests/present.test.mjs`。

**Approach:** 为可续跑 L2 记录来源校验信息；启动时只将有效部分结果纳入完成集合，其余节进入有界并发队列。失败时保留全部有效完成项，L1 失败也保存可续跑 L2；成功时去掉部分标记并完成地图。任务中心以原任务论文为目标触发续跑，完整覆盖保持单独的确认语义。

**Execution note:** 先用现有契约测试复现“已完成节在重试时再次请求”和“L1 失败丢失 L2”两条路径，再改编排。

**Test scenarios:**

- 一节连续解析失败、其他节完成：错误列出该节；重试只请求失败及未启动节，进度从已复用节数开始且单调增长。
- L1 合成失败：再次执行不请求 L2，只请求 L1。
- 取消后重启应用：持久部分结果仍可续跑；块模型变化或部分结果损坏时该节重新生成。
- 块模型附件已存在时按任务中心“重试”，不触发 `pdfparse.convert@1`。
- v1.1.0 无指纹部分结果仍可读取，首次续跑重新生成；完整覆盖确认后所有参与节重新请求。

**Verification:** Rust 契约测试覆盖真实 SQLite 和 mock 模型端点；任务中心显示的复用、失败和完成状态与落库结果一致。

### U3. Add In-App Updater

**Goal:** v1.2.0 安装版提供可操作的版本检查与确认安装。

**Requirements:** R1、R2、R10；AE4、AE8。

**Dependencies:** U4 的签名与测试清单供安装版验证；接口开发可并行。

**Files:** `app/src-tauri/Cargo.toml`、`app/src-tauri/Cargo.lock`、`app/src-tauri/tauri.conf.json`、`app/src-tauri/capabilities/default.json`、`app/src-tauri/src/lib.rs`、`app/src-tauri/src/updater.rs`（新）、`app/ui/bridge.js`、`app/ui/js/main.js`、`app/ui/index.html`、`app/ui/style.css`、`app/tests/updater.test.mjs`（新）。

**Approach:** 接入 Tauri 2 updater；通过现有桥接风格暴露检查与安装，设置页显示当前版、新版说明、下载进度及重试。安装前检查活动任务并等待或让用户确认取消；更新目标仅为主程序包，安装行为服从 Windows updater 的退出流程。不把更新检查失败混成组件下载或解析任务失败。

**Test scenarios:**

- 无更新、网络失败、清单格式错误、签名不匹配分别显示正确状态，不触发安装。
- 有更新时显示版本和说明，用户确认后下载与安装；活跃建图时不直接退出并丢失结果。
- 安装版从签名的 v1.2.0 测试构建更新到较新测试构建后，书库和附件仍可读取。
- 已装与未装本地解析组件的两种账户分别更新主程序，前者组件继续就绪，后者不因主程序更新而开始下载。

**Verification:** UI 状态测试与 Windows WebView2 安装版走查均通过；不能用 JS 单测代替真实安装。

### U4. Make Release Artifacts Repeatable

**Goal:** 每次 Windows 发版都能核对两个下载包、主程序签名、组件校验和更新清单属于同一版本发布。

**Requirements:** R2、R8-R11；AE4、AE8。

**Dependencies:** U6 的组件包与主程序打包边界；须在 U3 安装版验收前完成。

**Files:** `app/src-tauri/tauri.conf.json`、`app/src-tauri/Cargo.toml`、`app/package.json`、`app/package-lock.json`、`tools/` 中的主程序更新清单及组件包校验脚本与测试（按现有工具布局命名）、`app/README.md`。

**Approach:** 将 v1.2.0 的版本源核对、updater 私钥保管、轻量 NSIS 主程序包与 `.sig`、独立组件包及其完整性清单、GitHub Release 的 `latest.json` 写成可重复流程。Release 的两个用户下载包分别为主程序和本地解析组件，`.sig`、清单及说明只是校验元数据；`latest.json` 只指向主程序。测试更新走独立端点。GitHub CI 不可用期间允许有记录的本机发版流程，但不降低安装版验证门槛。

**Test scenarios:**

- 版本、架构、附件 URL 或签名缺失时清单校验拒绝发布。
- 使用正式签名密钥生成的测试清单可被 v1.2.0 安装版接受；错误密钥或篡改包被拒绝。
- 主程序包内不存在 Python、Docling 依赖或模型；组件包含完整可自检的运行环境，二者的架构与版本兼容关系可核对。
- 错误组件哈希、错误架构、缺少文件或路径穿越条目不能被安装或激活；发布清单不会把组件包误作 Tauri 更新包。

**Verification:** 两个包、签名与校验元数据逐项核对，私钥和密码未进入仓库、日志或安装包；重建包后实测压缩体积，不沿用旧记录估算。

### U6. Separate And Reuse Local Parser Component

**Goal:** 主程序包不携带侧车，v1.1.0 已安装侧车可在 v1.2.0 继续使用。

**Requirements:** R2、R9-R11；AE5、AE6、AE8。

**Dependencies:** 无；与 U1-U2 可并行。

**Files:** `app/src-tauri/tauri.conf.json`、`app/src-tauri/build.rs`、`app/src-tauri/src/pdfparse.rs`、`app/src-tauri/src/pdfpool.rs`、`app/src-tauri/src/lib.rs`、`app/src-tauri/windows/` 下的 NSIS 定制文件（新）、`tools/pdfparse-sidecar/build_sidecar.py`、组件打包脚本（新）、`app/src-tauri/tests/pdfparse_contract.rs`、`app/README.md`。

**Approach:** 从已验证的完整侧车产生独立组件包，把组件版本放入当前用户的应用管理目录。正式版运行时先解析该目录，再兼容原有安装目录；仅开发版可使用编译期仓库路径兜底。校验兼容版本、必需文件及自检状态后才标为就绪。主程序安装器在任何旧版卸载动作之前读取 v1.1.0 注册的安装目录，固定沿用它并保留侧车；路径缺失或不可信时停止安装。首次启动将旧侧车迁移到独立目录，失败时保留原副本并明确报错。旧组件损坏或不存在时，主程序仍能升级并提示按需下载。不要通过更改现有 `download` 变体就声称完成分包。

**Test scenarios:**

- 真实 v1.1.0 NSIS 安装版上运行轻量主程序包，默认交互路径不会先删除旧侧车；迁移后组件自检、`pdfparse.convert@1` 与 `pdfassets.prerender@1` 成功，且没有组件网络下载。
- v1.1.0 分别装在默认和用户自选目录时，升级自动使用注册的原目录，不能在目录页改到别处；注册目录缺失或指向无关位置时，安装在修改旧版前停止。
- 旧侧车缺文件、版本不兼容、被占用或迁移失败时，不产生“已就绪”假状态，也不删除唯一可用副本；用户可选择下载安装独立组件。
- 干净账户只安装主程序包，安装目录不含嵌入式 Python、Docling 或模型，PDF.js 查看器与已存数据可用；后续主程序更新不移除组件目录。

**Verification:** Windows 安装版走查覆盖 v1.1.0 升级、干净安装和再次更新；Rust 契约测试覆盖侧车查找、版本校验及迁移失败路径。

### U7. Install And Manage Optional Parser Component

**Goal:** 用户可在应用内按需安装或移除本地解析组件，并看清下载量与磁盘占用。

**Requirements:** R9、R10、R12；AE5、AE7。

**Dependencies:** U6 的独立组件格式、位置和就绪判据。

**Files:** `app/src-tauri/src/pdfparse.rs`、`app/src-tauri/src/tasks.rs`、`app/src-tauri/src/bridge.rs`、`app/ui/js/main.js`、`app/ui/index.html`、`app/ui/style.css`、`app/src-tauri/tests/pdfparse_contract.rs`、相关 JavaScript 状态测试。

**Approach:** 在解析设置及首次解析入口展示组件状态、下载大小、预计落盘和当前能力限制。用户确认后由 Rust 下载到暂存目录、校验包与解压结果、执行侧车自检，再原子切换活动版本；取消、断网、空间不足及校验失败时保留原版本并允许重试。卸载前停止常驻侧车和活动解析任务，仅删除用户确认的组件文件。允许对同一组件包走已下载文件的本地安装路径，仍执行相同校验；不显示未实现的云端后端。

**Test scenarios:**

- 用户跳过本地组件后，导入 PDF、查看原 PDF 及已存产物正常；请求结构化解析或侧车页图时展示明确安装入口，拒绝后不自动下载。
- 从 Release 下载或选择已下载组件包安装，进度与最终占用可见；校验成功才开始解析新 PDF，并在重启及主程序更新后保持就绪。
- 下载取消、断网、哈希不符、解压路径越界、磁盘不足及自检失败不会激活残缺组件；已有有效组件不被覆盖，重试可恢复。
- 用户确认卸载后不能新解析，但已有论文、PDF、块模型及阅读产物仍可打开；正在运行解析任务时先结束或取消任务。

**Verification:** Rust 下载/安装/状态契约与 UI 状态测试通过，并在 Windows 安装版走查首次安装、取消恢复、卸载和重新安装。

### U5. Verify And Publish v1.2.0

**Goal:** 交付可从 v1.1.0 轻量升级、以后可应用内更新，且由用户决定是否安装本地解析组件的正式版本。

**Requirements:** R1-R12。

**Dependencies:** U1-U4、U6-U7。

**Files:** `docs/current.md`、`app/README.md`、必要的版本与发布说明文件；发布到项目现有 GitHub Releases。

**Approach:** 对照已完成的代码品质提交和审查记录，核对目标分支及工作区；对新增组件工作执行 `ce-simplify-code`，再执行 `ce-code-review` 并处理影响发布的发现。代码审查完成后，分别走查干净账户仅装主程序、v1.1.0 原地升级并复用侧车、组件按需安装及主程序测试更新。使用旧书库一致性副本，更新 `docs/current.md` 后与对应代码同笔提交；明确记录 GitHub CI 的实际状态，再创建包含两个下载包的正式 Release。

**Test scenarios:**

- v1.1.0 安装上只运行 v1.2.0 主程序包后，旧论文、附件、阅读位置、译文与问答可读；旧侧车通过迁移及解析自检，不重新下载组件。
- 新安装账户只装主程序可启动、查看 PDF 并检查更新；选择安装组件后能解析、建图和续跑，卸载走查确认书库处理符合当前安装策略。
- 真实含附录论文的建图失败与续跑完成；组件就绪后的安装版解析无控制台黑窗。

**Verification:** Release 中两个 v1.2.0 下载包、主程序签名、组件校验和更新清单可下载且相互匹配；本机与未运行的远端检查分别记录。

---

## Verification Contract

- `app/` 下 `node --test`：协议角色、进度域、任务中心、更新 UI 与可选组件状态。
- `app/src-tauri/` 下 `cargo test`：建图失败、续跑、旧部分结果、块模型变化、组件校验/迁移及书库兼容。
- `app/` 下 `npm run smoke`，仓库根目录 `node tools/check_syntax.mjs`：原生桥与 JS 入口回归。
- 构建无侧车的 v1.2.0 主程序包与独立组件包，实测压缩包和落盘大小；检查主程序安装目录不含 Python、Docling 或模型，组件包通过版本、架构、签名/预期哈希、自检和解压路径校验。
- Windows 安装版分别验证：干净账户只装主程序、v1.1.0 手动运行轻量主程序包并复用旧侧车、从应用内安装和卸载组件，以及签名的 v1.2.0 测试主程序更新。只有安装版实际更新能证明 updater 可用；只有真实 v1.1.0 升级能证明旧侧车迁移可用。
- 正式发布包构建前完成 `ce-simplify-code` 和 `ce-code-review`，修复并复审[已发现的阻断项](../reviews/2026-09-24-v1.2-pre-release.md)：更新/任务/组件操作共同准入、组件下载停流超时、签名与安装包字节匹配、完整覆盖重试。测试组件自检超时、窗口关闭和前端状态竞态。任何修复之后重新构建最终安装包与签名。
- 以 SQLite 一致性备份的现存书库副本走查，保留原库；发版前核对 `docs/current.md`、目标分支、提交范围、版本号与 GitHub Release 附件。

## Definition of Done

- U1-U7 的场景通过，失败重试不会重复请求可复用节，附录和参考文献不进入新地图。
- v1.2.0 Release 有两个用户下载包：不含侧车的主程序安装包和完整本地解析组件包；校验元数据正确，私钥得到安全备份。主程序可独立安装，用户决定是否下载、安装或移除本地组件；没有组件时不会假装能解析新 PDF。
- v1.1.0 的首次手动轻量升级经过安装版验证，旧侧车完整时可复用且不重新下载；此后主程序应用内更新不移除组件。升级路径及没有云端解析后端的限制写入发布说明。
- 旧书库及附件经安装版验证；代码品质改动与本次改动均已核对，`docs/current.md` 与提交一致，未运行检查如实注明。
- 删除试验性代码和无用发布产物；保留用户原有未跟踪文件，不把它们顺带提交或发布。
