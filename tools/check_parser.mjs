import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
// UMD 构建会自行把 pdfjsLib / pdfjsWorker 挂到 globalThis；package.json 声明
// type:module 后，require() 返回的是空的模块命名空间对象，不能用来覆盖全局。
require('../public/vendor/pdf.min.js');
// Node 环境没有真正的 Worker，pdf.js 的 fake worker 依赖主线程暴露的
// WorkerMessageHandler。
require('../public/vendor/pdf.worker.min.js');

const { parsePdfFile, splitTextToSections } = await import('../public/js/parser.js');
pdfjsLib.GlobalWorkerOptions.workerSrc = resolve('public/vendor/pdf.worker.min.js');
const pdfPath = resolve(process.argv[2] || 'public/samples/sample_paper.pdf');
const data = await readFile(pdfPath);
const parsed = await parsePdfFile({
  async arrayBuffer() {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  },
});

const lengths = Object.fromEntries(
  Object.entries(parsed.sections).map(([name, text]) => [name, text.length]),
);
console.log(JSON.stringify({
  title: parsed.title,
  pages: parsed.numPages,
  lengths,
  parts: parsed.parts.map(part => ({ id: part.id, title: part.title, semanticType: part.semanticType })),
  abstractPreview: parsed.sections.abstract.slice(0, 180),
  firstLines: parsed.fullText.split('\n').slice(0, 30),
}, null, 2));

if (!parsed.sections.abstract || !parsed.sections.introduction) {
  process.exitCode = 1;
}

const generic = splitTextToSections([
  { text: 'Abstract', page: 1 },
  { text: 'This paper studies a robust section parser for papers whose main body does not use a Method heading. The abstract is intentionally long enough to resemble real prose.', page: 1 },
  { text: '1 Problem Formulation', page: 1 },
  { text: 'We define the learning problem, introduce the observable variables, and state the assumptions required by the analysis. This section deliberately contains enough prose to be treated as a real paper section rather than an entry copied from a table of contents.', page: 1 },
  { text: '2 Causal Representation', page: 2 },
  { text: 'The representation is organized around latent causal states and an intervention-aware objective. We describe the objective, its mathematical interpretation, and the conditions under which it preserves the information needed by downstream control policies.', page: 2 },
  { text: '3 Experimental Results', page: 3 },
  { text: 'We evaluate the representation on several benchmarks and compare it with strong baselines. The experiments include quantitative results and ablation studies.', page: 3 },
  { text: '4 Conclusion', page: 4 },
  { text: 'We summarize the findings.', page: 4 },
]);

if (generic.parts.length !== 3 || generic.parts[0].title !== 'Problem Formulation' ||
    generic.parts[1].title !== 'Causal Representation' || generic.parts[2].semanticType !== 'experiments' ||
    !generic.sections.experiments) {
  console.error('Generic numbered-section fallback failed', generic.parts);
  process.exitCode = 1;
}
