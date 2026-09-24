export async function translateForPaper({
  paper, partId, chunks, language, source, systemPrompt,
  chat, save, isCurrent, signal, onDelta, onProgress, retry,
}) {
  const assertActive = () => {
    if (signal?.aborted || !isCurrent()) throw new DOMException('已停止', 'AbortError');
  };
  const translated = [];
  for (let index = 0; index < chunks.length; index++) {
    assertActive();
    onProgress?.(index, chunks.length);
    const piece = await chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: chunks[index] },
    ], {
      stream: true,
      signal,
      onDelta: full => {
        if (!signal?.aborted && isCurrent()) onDelta?.([...translated, full].join('\n\n'));
      },
      retry,
    });
    assertActive();
    translated.push(piece);
  }
  const text = translated.join('\n\n');
  if (!text.trim()) throw new Error('模型未返回译文');
  assertActive();
  await save(paper, partId, language, text, source);
  return text;
}
