# Constraints

Last reviewed: 2026-11-19 by @attackingjensen

本文件是 Paper30Min 质量线的唯一权威来源。除特别注明外，命令均在 `app/` 中运行。脚本只是可复现封装；修改本文件必须进入 code review，不得为了让当前变更通过而降低标准。

## Floor（始终阻断）

- 禁止新增抑制注释: 不允许新增 `@ts-ignore`、`@ts-expect-error`、`@ts-nocheck`、`eslint-disable`、`biome-ignore`、`istanbul ignore`、`nosemgrep`、`gitleaks:allow`、`Stryker disable` 及同类绕过。
- 禁止未完成桩: 不允许新增 not-implemented 异常、空 `catch {}` 或以 `TODO` 代替本次承诺的实现。
- 禁止静默弱化测试: 新增 `.skip` / `.todo`、删除测试文件或移除既有断言必须阻断；真实环境例外只能进入下方 Exceptions。
- 禁止源码秘密: 产品源码、测试、文档和 CI 不得包含凭据；gitleaks 输出必须始终使用 `--redact`。
- 禁止私自降低质量线: 不得调低阈值、删除规则、把阻断改成警告、扩大扫描排除或新增未登记例外。

Floor 由 `node scripts/floor-guard.mjs --base origin/main` 对 merge base 到工作区的 diff（含 untracked 文件）执行。退出码 `0` 为干净、`1` 为违规、`2` 为 guard 无法运行；`2` 同样阻断。`.constraintsignore` 当前只排除包含检测字面量的 guard 实现自身，任何扩大都必须 review。

## 失败与例外策略

- 类型、knip、secrets、floor、架构边界和完整扫描结果属于确定性检查，失败立即阻断。
- OSV high / critical、契约硬预算和 Windows 全量回归失败立即阻断；low / moderate 仅测量，不借此隐瞒 high / critical。
- 测量型指标回退先警告；连续 **3 次**回退必须转为阻断或经 review 重设基线。选择 3 次是为了过滤单次环境波动，同时防止“下次再处理”无限延续。
- 扫描器不可启动、报告不完整、未知严重度或解析器不受支持均视为检查不可用并阻断，不能按零 finding 通过。
- 例外必须有 owner 和到期日，默认 **90 天**，足以安排修复又能避免永久豁免；到期前必须修复、移除或重新评审，不得静默续期。
- 例外登记执行：新增 W/E 行由 floor-guard 验证登记要素（非空 owner、未来且不超过 90 天的到期日），要素缺失仍阻断；OSV 例外另由 `app/scripts/osv-exceptions.json` 按公告／包／版本精确匹配执行，被豁免 finding 在扫描输出中保持可见，过期例外自动恢复阻断。

## Enforced with numbers

| ID | Dimension | Rule | 设定理由 | Checked by | Runs at |
|---|---|---|---|---|---|
| C1 | Types | `0` 个 TypeScript 错误 | strict TS 是共享契约和跨进程调用的第一道检查 | `npm run typecheck` | BUILD、CI |
| C2 | Dead code | `0` 个 knip 问题 | 防止死文件、死导出和依赖漂移；不允许新增宽泛豁免 | `npm run test:dead-code` | BUILD、CI |
| C3 | Secrets | `0` 个产品范围 finding | 凭据不得进入源码、transcript 或 CI 日志 | `npm run check:secrets` | BUILD、CI |
| C4 | Architecture | `0` 个边界违规；`>= 1` 个扫描模块；SWC 与 `.ts/.tsx/.cts` 解析必须可用 | renderer 不得访问 main / Node / Electron；shared 保持进程中立；preload 只经受限契约暴露能力。非空扫描防止“0 modules 假通过” | `npm run check:architecture` | VERIFY、CI |
| C5 | Security: dependencies | high / critical 为 `0`；unknown severity 阻断；扫描包清单 `>= 1` | 高危依赖必须有修复或有期限的明确处置；低级别不掩盖高级别；非空包清单区分“零漏洞”与“未扫描” | `npm run check:dependencies` | REVIEW、CI |
| C6 | Build | `0` 个构建错误 | 生产运行目录必须能由锁定依赖重建；构建不等同安装包 | `npm run build` | REVIEW、CI |
| C7 | Contract tests | `0` 个失败 | 工程、文档、来源、核验与解析预算必须由真实契约回归裁决 | `npx playwright test -g "project-core\|document-core\|arxiv-import\|pdf-import\|pdf-reparse\|pdf-snapshot\|pdf-verification"` | VERIFY |
| C8 | Windows Electron | `0` 个失败；环境跳过按 M1 测量并仅登记 W2 | 桌面行为不能用 Linux 构建或纯静态检查替代 | `npm test` | Windows CI、完整本地验证 |

## Contract budgets（硬约束）

这些数值来自当前实现及对应 spec，用于限制恶意或异常输入的内存、磁盘、网络与费用影响。改变预算属于契约变更，必须同步实现、边界测试和 spec；不得通过截断正文、删除资产或跳过校验来满足预算。

| ID | 上限或范围 | 设定理由 | Checked by |
|---|---|---|---|
| B1 | 工程元数据与来源读取证据 `<= 1 MiB`；`document.json` / `source-base.json` / changeset / tombstones / `verification.json` 单文件 `<= 64 MiB` | 小元数据应快速失败；文档树与核验侧车需要更大但仍必须有界的读取预算 | `npx playwright test -g "project-core\|document-core\|pdf-verification"` |
| B2 | 单棵树节点 `<= 200,000`；章节深度 `<= 64`；单个 raw HTML block `<= 2 MiB` | 限制病态树的遍历、递归和原始内容成本 | `npx playwright test -g "document-core|arxiv-import"` |
| B3 | 单个 revision 资产 `<= 32 MiB`；单 revision 引用资产总量 `<= 512 MiB` | 防止单项或聚合资产导致无界内存与磁盘占用 | `npx playwright test -g "project-core|document-core"` |
| B4 | arXiv `abs.html <= 8 MiB`、`document.html <= 128 MiB`、单原始资产 `<= 32 MiB`、单快照原始资产合计 `<= 512 MiB` | 外部来源的声明大小与实际字节都必须有界 | `npx playwright test -g "arxiv-import|arxiv-transport|arxiv-snapshot"` |
| B5 | arXiv 自动额外重试 `<= 2` 次、重定向 `<= 5` 次、资产并发默认 `4` | 限制失败放大、重定向链和并发压力；活动下载不以短总时限误杀 | `npx playwright test -g "arxiv-import|arxiv-transport"` |
| B6 | 普通工程文本读取与编辑 `<= 2 MiB` | Agent 与编辑器读取必须有界；PDF 走专用读取工具 | `npx playwright test -g "agent-files|project-core"` |
| B7 | 云端解析上传 PDF `<= 50 MiB`、页数 `1–1000` | 控制上传费用和远端任务规模，超限不得上传 | `npx playwright test -g "pdf-import-task|pdf-snapshot"` |
| B8 | 任务状态响应 `<= 1 MiB`、受管 JSONL `<= 256 MiB`、单页解析块 `<= 10,000` | 限制远端响应和复杂页面结果的解析成本 | `npx playwright test -g "pdf-import-task|pdf-snapshot-parse"` |
| B9 | 单解析资产 `<= 32 MiB`、单解析快照资产合计 `<= 256 MiB`、单 PNG `<= 16,000,000` 像素 | 同时限制压缩字节与解码后像素，避免图像内存放大 | `npx playwright test -g "pdf-snapshot-parse|pdf-page-crop"` |
| B10 | 单轮远端查询等待 `<= 30 分钟`，之后必须保留原任务供恢复 | 避免无限等待和重复计费；超时不能冒充远端失败 | `npx playwright test -g "pdf-import-task"` |

B7–B10 自 s08.6 起由新 document-core 链路回归承担：上传预算与任务状态机由 `pdf-import-task` 承担，受管 JSONL／去敏／资产预算由 `pdf-snapshot-parse` 承担，原页裁切像素预算由 `pdf-page-crop` 承担；旧 `parsing` 套件已随旧解析路径退役删除（W3）。B1 的核验侧车与来源读取证据预算自 s08.5 起由 `pdf-verification` 回归承担。s08.7 起，重解析／更新的候选合并、`baseRevision` 复核、恢复不重传与核验继承由 `pdf-reparse` 回归承担（受控百度服务，不访问真实云端）；离线重新转换由 `pdf-snapshot-convert` 的离线重新转换用例承担。s08.8 起，PDF core* 命令面（快照、任务状态、停止、离线重转换、候选发布、核验与证据）由 `pdf-core-commands` 契约回归承担；生产 preload／IPC／utility process 的导入、显式上传确认、停止恢复与重解析候选由 `pdf-import-electron` 真实 Electron 回归承担（受控百度服务，不访问真实云端）。s08.9 起，原页区域裁切的几何校准（旋转／CropBox／宽高比／bbox）、像素与资产预算、确定性字节与公式块可选裁剪资产由 `pdf-page-crop` 回归承担；首次发布／离线重转换／重解析全链路的裁剪资产进入候选 revision 且不回写快照由 `pdf-snapshot-convert` 与 `pdf-reparse` 的裁剪用例承担。Phase 3 每个后续切片必须为其实际接管的范围补充边界测试；未实现或未运行的项目不得记为已验证。translation、pdf-comparison 等尚未实现的 spec 不提前虚报为当前强制项，接入实现时必须同步收录其预算。

## Measured, not yet enforced

| ID | Metric | Today（2026-11-17，本分支实测） | Direction | 理由与命令 |
|---|---|---:|---|---|
| M1 | 默认全量回归环境跳过数 | `3` | 不得增长 | 防止用环境条件静默扩大未测范围；`npm test`，既有 3 项登记为 W2（真实百度门控用例已随旧路径退役删除） |
| M2 | OSV low + moderate finding | `2`（LOW `1`、MODERATE `1`） | 不得增长 | 当前为 katex LOW 与 minimatch MODERATE；不强迫在本约束任务中做 major 升级，但需观察积累；`npm run check:dependencies` |
| M3 | knip 临时源码豁免 | `0` | 不得增长 | W1 已随 s08.6 旧解析退役移除；`npm run test:dead-code` 并 review `knip.jsonc` |

整数计数不设容差，因为新增一次跳过、漏洞或豁免都是可审查的离散事件。比例型指标若以后引入，ratchet 容差为 **0.5 个百分点**，用于吸收无关文件的轻微比例波动，而不是允许真实回退。

当前补充基线：`433 passed / 4 skipped (10.5m)`（s08.6 退役前，HEAD b1602af）、架构 `109 modules / 0 violations`。耗时只记录今日成本，不设硬秒数；机器与 runner 负载不同，耗时本身不自动阻断。

## Exceptions

| ID | Rule | Path | Reason | Owner | Expires |
|---|---|---|---|---|---|
| W2 | 默认回归允许 `3` 个环境门控跳过 | `app/tests/desktop.spec.ts` | 真实视觉模型与真实 Pi 验证需要本机凭据、费用授权和隔离配置；默认 CI 不伪造这些证据，发布前按 README 显式验收 | @attackingjensen | 2027-02-15 |
| W3 | 旧解析退役删除测试与断言 | `app/tests/parsing.spec.ts`、`app/tests/desktop.spec.ts` | s08.6 退役被新 corePdf* 链路取代的旧解析实现；等价行为由 pdf-import-task／pdf-snapshot-parse／pdf-import-electron 套件承担，设置加密与损坏恢复断言保留为新用例 | @attackingjensen | 2027-02-15 |

## 生命周期与成本

| Stage | Command | 内容与成本 |
|---|---|---|
| BUILD / 编辑循环 | `npm run check:fast` | 类型、knip、secrets、diff floor；保持秒级，secrets 今日扫描约 2.3 秒 |
| VERIFY / 任务交还前 | `npm run check:task` | fast、架构和导入/工程契约 Playwright；分钟级，其他功能另跑相关 `-g` 套件 |
| REVIEW / 完整本地验证 | `npm run check:full` | fast、架构、OSV、构建和 Windows 全量 Electron；以分钟计 |
| SHIP / CI | `.github/workflows/ci.yml` | Windows 与 Linux 执行 fast、架构、OSV、构建；仅 Windows 执行完整桌面回归 |

CI 固定 gitleaks 8.30.1 与 osv-scanner 2.7.0，避免未审查的工具漂移；dependency-cruiser、SWC 和 npm 依赖由 `app/package-lock.json` 固定。gitleaks 的 `.local/`、`.upstream/`、`node_modules/` 与生成目录排除只界定非产品文件，不是源码 finding 豁免。

## 当前不采用的维度

- **变更行覆盖率与 mutation score**：当前只有真实 Electron / Playwright 套件，没有覆盖率 runner；不虚构 80% 数字，也不为此另建平行测试体系。
- **Lighthouse 与 axe-CLI**：这是桌面应用，没有可运行的 preview URL；不制造无效检查。是否在真实 Electron 中引入 axe-in-Playwright 需另行评审。
- **Semgrep 与独立 lint**：当前未选择 Semgrep，仓库也没有 ESLint / Biome 配置；新增维度必须先确定规则、成本与负责人。
- **性能硬预算**：没有以桌面启动和交互实测为基础的阈值；当前只记录成本，不套用 Web Vitals。
