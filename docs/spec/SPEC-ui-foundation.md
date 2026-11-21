# Spec: UI foundation — v2.0.0

> 状态：已批准  
> 来源任务：`paper-30min-ou7`  
> 视觉验收：2026-11-21 用户确认蓝靛色高保真预览可用于 v2.0.0，后续只做一致性落地

## Objective

在不改变三栏工作台、中央正文列和业务行为的前提下，统一 Paper30Min 的语义 tokens、基础组件、控件状态与轻量动效。v2.0.0 的目标是全套真实界面保持一致，而不是继续探索新视觉、增加主题系统或重做信息架构。

成功时，工作台、设置、Agent、Reader、Markdown 与 PDF 视图使用同一套蓝靛色语义和交互规则；键盘、焦点、reduced-motion 与窄窗口行为不回退。

## Scope

### In scope

- 蓝靛色语义 tokens：表面、文字、边框、accent、状态、焦点、圆角与动效。
- 原生优先的 `Button`、`IconButton`、`Field`、`InlineMessage`、`EmptyState`。
- `Dialog`、`ConfirmDialog` 使用原生 `<dialog>` 管理焦点；Field 与需要复杂定位的自定义 `Select` 采用 Base UI headless 组件，样式仍由项目普通 CSS 负责。
- 创建工程、笔记、移动、上传确认与 renderer 内未保存确认。
- 设置、Agent、Reader、Markdown、PDF 的控件与状态样式迁移。
- 真实 Electron 键盘、焦点、reduced-motion、多宽度截图和相关行为回归。

### Out of scope

- B 暖纸绿主题、C 现代柔和方案、主题切换和暗色模式。
- 三栏比例、页签/侧栏拖拽、阅读位置、选区映射、业务状态、IPC 与持久化契约变更。
- TextFold 栅格、大字号、正文衬线改造或额外排版美化。
- 大型 UI 框架、Tailwind、CSS-in-JS、CSS Modules、Storybook 或组件展示页。
- arXiv 创建入口（由 `paper-30min-oaa` 承接）及工作区双窗格功能。

## Tech Stack

- Electron 44、React 19、TypeScript、Vite、普通 CSS。
- 原生 `button/input/textarea/dialog/details`；Base UI 仅承担 Field/Select 等复杂交互，不引入默认皮肤。Base UI Dialog 经真实 Electron Tab 焦点回归证伪后不再采用。
- Lucide 图标沿用现有依赖；不加载远端字体或视觉资源。

## Commands

在 `app/` 中执行：

```powershell
npm run check:fast
npm run check:task
npx playwright test -g 'desktop|reader|pdf-import-electron'
npm run check:full
npm run format:check
```

需要原生焦点或现场视觉核对时，只对相关用例设置 `PAPER30MIN_TEST_WINDOW=visible`；完成后清除环境变量。

## Project Structure

```text
app/src/renderer/ui/       tokens、基础组件与共享控件样式
app/src/renderer/          工作台、设置、Agent、Markdown、PDF 迁移
app/src/renderer/reader/   Reader 与来源/修正/冲突宿主迁移
app/tests/                 真实 Electron 行为、焦点和多宽度证据
```

## Component Contract

- `Button` 默认 Secondary；每个操作组最多一个 Primary。Ghost 用于低强调操作，Danger 只用于真实破坏行为。
- `IconButton` 必须有可访问名称，目标尺寸不小于 24×24 CSS px。
- `Field` 只组合 label、control、description 与 error，不接管业务值、草稿或校验规则。
- `Dialog` 必须提供可访问标题、焦点圈定和关闭后焦点恢复。表单与上传确认不得因遮罩点击而静默丢失或确认。
- `Select` 区分当前选中项与键盘/鼠标高亮项；选中项使用文字和对勾，不只依赖颜色。弹层必须在视口内重定位。
- 成功、错误和空状态使用一致语义；异步反馈保留布局与键盘焦点。

## Visual and Motion Contract

- 当前唯一主视觉为 A 蓝靛色；B 仅记录为未来主题候选，本版不实现。
- 控件圆角以 6px 为基线，主面板保持现有 10px 层级；不新增大面积卡片化区域。
- 正文保持当前 `15px / 1.75`、最大约 `860px` 和既有标题层级。
- hover 只改变表面/边框；active 使用轻微内陷，不缩放、不位移。
- 键盘焦点使用清晰的 2px 焦点环；鼠标与键盘状态不得混用。
- 弹层只使用约 100ms 的短距离淡入；面板收放保持现有约 350ms；拖拽始终即时跟手。
- `prefers-reduced-motion` 下取消非必要过渡，最终尺寸、焦点与阅读位置一致。

## Testing Strategy

- 优先复用现有真实 Electron 创建、设置、Agent、Reader、PDF、选区与位置回归。
- 新增公共 UI 用例覆盖：Tab 焦点顺序、Dialog 焦点圈定与恢复、Select 键盘选择、表单错误关联、reduced-motion 和多宽度无横向溢出。
- 截图作为视觉 finish-gate 证据；自动门禁使用行为、几何与可访问状态断言，不采用跨平台逐像素快照。
- 每个增量运行最窄相关检查；最终运行 `check:full`、格式检查与完整真实 Electron 回归。

## Boundaries

- Always：沿用现有业务回调和状态契约；使用语义 tokens；在真实 Electron 验证实际界面。
- Ask first：新增 Base UI 之外的运行时 UI 依赖、改变业务行为、扩大视觉范围或引入主题能力。
- Never：新增抑制/跳过、降低质量门禁、用静态 DOM 或预览页冒充真实 Electron 证据、为统一外观而重写 Reader/布局逻辑。

## Success Criteria

- `Button/IconButton/Field/Dialog/InlineMessage/EmptyState` 均有真实消费者，无死导出。
- 所有目标区域消费同一语义 tokens，不保留区域独立的 accent、焦点与状态色体系。
- 现有布局、拖拽、选区、阅读位置、模型/密钥、Agent 与 PDF 行为回归通过。
- 键盘、焦点、reduced-motion 与 `1440×960`、`1000×780`、`560×780` 等真实 Electron 多宽度证据通过。
- 用户确认最终实现与已批准蓝靛色预览一致，没有额外视觉扩张。
