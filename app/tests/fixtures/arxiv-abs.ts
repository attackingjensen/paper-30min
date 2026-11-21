// 受控 abs 页面 fixture：只保留版本固定所需的真实结构（citation meta 与提交历史），
// 不访问真实 arXiv。变体用于版本混杂、撤稿与缺失版本的故障注入。

export interface AbsFixtureOptions {
  id: string;
  versions: number[];
  latest?: number;
  withdrawn?: number[];
}

export function absHtml(options: AbsFixtureOptions): string {
  const latest = options.latest ?? Math.max(...options.versions);
  const history = options.versions
    .map((version) => {
      const withdrawn = options.withdrawn?.includes(version) ? " <span>(withdrawn)</span>" : "";
      return `<b><a href="/abs/${options.id}v${version}">[v${version}]</a></b> Mon, 1 Jan 2024 00:00:00 UTC (100 KB)${withdrawn}`;
    })
    .join("\n      ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>[${options.id}] Fixture Paper</title>
  <meta name="citation_title" content="Fixture Paper" />
  <meta name="citation_arxiv_id" content="${options.id}v${latest}" />
</head>
<body>
  <h1 class="title">Fixture Paper</h1>
  <div class="submission-history">
    Submission history
    <h2>Submission history</h2>
    From: Fixture Author
      ${history}
  </div>
</body>
</html>`;
}
