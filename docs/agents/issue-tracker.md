# 问题跟踪：GitHub

本仓库的问题和规格说明统一记录在 GitHub Issues，并使用 `gh` CLI 操作。

## 操作约定

- 创建：`gh issue create --title "..." --body "..."`
- 查看：`gh issue view <编号> --comments`
- 列出：`gh issue list --state open --json number,title,body,labels,comments`
- 评论：`gh issue comment <编号> --body "..."`
- 添加标签：`gh issue edit <编号> --add-label "..."`
- 移除标签：`gh issue edit <编号> --remove-label "..."`
- 关闭：`gh issue close <编号> --comment "..."`

在仓库目录中运行命令，由 `gh` 根据 Git 远端自动识别仓库。

## 是否将拉取请求纳入分类流程

**否。**

单独出现的 `#42` 可能是 Issue 或 Pull Request。先运行 `gh pr view 42`，失败后再运行 `gh issue view 42`。

## 技能约定

- “发布到问题跟踪器”表示创建 GitHub Issue。
- “获取相关工单”表示运行 `gh issue view <编号> --comments`。
