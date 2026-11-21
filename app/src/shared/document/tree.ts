import Type from "typebox";
import Schema from "typebox/schema";

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maximumNodeCount = 200_000;
const maximumSectionDepth = 64;
const maximumRawHtmlBytes = 2 * 1024 * 1024;

const IdSchema = Type.String({ pattern: uuidPattern });
const SourceAliasesSchema = Type.Optional(
  Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 100, uniqueItems: true }),
);
const SourceRepresentationSchema = Type.Object(
  {
    format: Type.Union([Type.Literal("latex"), Type.Literal("mathml"), Type.Literal("text")]),
    value: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const InlinePartSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("text"),
      text: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("atom"),
      atomId: IdSchema,
    },
    { additionalProperties: false },
  ),
]);
const SectionNodeSchema = Type.Object(
  {
    id: IdSchema,
    parentSectionId: Type.Union([IdSchema, Type.Null()]),
    title: Type.String(),
    childSectionIds: Type.Array(IdSchema, { uniqueItems: true }),
    unitIds: Type.Array(IdSchema, { uniqueItems: true }),
    sourceAliases: SourceAliasesSchema,
  },
  { additionalProperties: false },
);
const UnitNodeSchema = Type.Object(
  {
    id: IdSchema,
    sectionId: IdSchema,
    kind: Type.Union([
      Type.Literal("paragraph"),
      Type.Literal("list-item"),
      Type.Literal("caption"),
      Type.Literal("abstract"),
      Type.Literal("footnote"),
      Type.Literal("reference"),
      Type.Literal("table-cell"),
    ]),
    sentenceIds: Type.Array(IdSchema, { uniqueItems: true }),
    sourceAliases: SourceAliasesSchema,
  },
  { additionalProperties: false },
);
const SentenceNodeSchema = Type.Object(
  {
    id: IdSchema,
    unitId: IdSchema,
    content: Type.Array(InlinePartSchema, { minItems: 1 }),
    sourceAliases: SourceAliasesSchema,
  },
  { additionalProperties: false },
);
const atomFields = {
  id: IdSchema,
  unitId: IdSchema,
  text: Type.String(),
  sourceAliases: SourceAliasesSchema,
};
const AtomNodeSchema = Type.Union([
  Type.Object(
    {
      ...atomFields,
      kind: Type.Literal("math"),
      source: SourceRepresentationSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...atomFields,
      kind: Type.Literal("citation"),
      /** 解析到的书目规范单元；未解析为 null 并保留 sourceAliases 与 warning。 */
      targetUnitId: Type.Union([IdSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...atomFields,
      kind: Type.Literal("cross-reference"),
      targetUnitId: Type.Union([IdSchema, Type.Null()]),
      sourceTarget: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...atomFields,
      kind: Type.Literal("link"),
      href: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...atomFields,
      kind: Type.Literal("footnote-reference"),
      targetUnitId: IdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...atomFields,
      kind: Type.Literal("inline-object"),
      source: SourceRepresentationSchema,
    },
    { additionalProperties: false },
  ),
]);
const AssetReferenceSchema = Type.Object(
  {
    path: Type.String(),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    mime: Type.String({ pattern: "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$" }),
  },
  { additionalProperties: false },
);
const blockFields = {
  id: IdSchema,
  sectionId: IdSchema,
  sourceAliases: SourceAliasesSchema,
};
const BlockNodeSchema = Type.Union([
  Type.Object(
    {
      ...blockFields,
      kind: Type.Literal("unit"),
      unitId: IdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...blockFields,
      kind: Type.Literal("figure"),
      asset: Type.Union([AssetReferenceSchema, Type.Null()]),
      captionUnitId: Type.Union([IdSchema, Type.Null()]),
      warning: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...blockFields,
      kind: Type.Literal("table"),
      captionUnitId: Type.Union([IdSchema, Type.Null()]),
      rows: Type.Array(
        Type.Array(
          Type.Object(
            {
              unitId: IdSchema,
              rowSpan: Type.Integer({ minimum: 1 }),
              columnSpan: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
        { minItems: 1 },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...blockFields,
      kind: Type.Literal("formula"),
      source: SourceRepresentationSchema,
      text: Type.String(),
      /** 可选原页裁剪资产（SPEC-pdf-import §6.7）：LaTeX/文本仍是权威，图像只是区域证据。 */
      asset: Type.Optional(AssetReferenceSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...blockFields,
      kind: Type.Literal("raw"),
      html: Type.String({ minLength: 1 }),
      text: Type.String(),
      limitations: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);
const DocumentTreeSchema = Type.Object(
  {
    documentFormatVersion: Type.Literal(1),
    paperId: IdSchema,
    sections: Type.Record(Type.String(), SectionNodeSchema),
    units: Type.Record(Type.String(), UnitNodeSchema),
    sentences: Type.Record(Type.String(), SentenceNodeSchema),
    atoms: Type.Record(Type.String(), AtomNodeSchema),
    blocks: Type.Array(BlockNodeSchema),
  },
  { additionalProperties: false },
);

export type DocumentTree = Type.Static<typeof DocumentTreeSchema>;
type SectionNode = DocumentTree["sections"][string];
type BlockNode = DocumentTree["blocks"][number];

const documentTreeSchema = Schema.Compile(DocumentTreeSchema);

function invalid(message: string): never {
  throw new Error(`文档树无效：${message}`);
}

function sameOrder(actual: string[], expected: string[]) {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

function validateNodeTable(nodes: Record<string, { id: string }>, kind: string, ids: Set<string>) {
  for (const [key, node] of Object.entries(nodes)) {
    if (!uuid.test(key) || key !== node.id) invalid(`${kind} 的记录键必须与节点 ID 一致。`);
    if (ids.has(node.id)) invalid(`节点 ID 重复：${node.id}。`);
    ids.add(node.id);
  }
}

function sectionChain(section: SectionNode, sections: DocumentTree["sections"]) {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: SectionNode | undefined = section;
  while (current) {
    if (seen.has(current.id)) invalid("章节父子关系存在循环。");
    if (chain.length >= maximumSectionDepth) invalid(`章节嵌套深度不能超过 ${maximumSectionDepth}。`);
    seen.add(current.id);
    chain.unshift(current.id);
    current =
      current.parentSectionId === null
        ? undefined
        : (sections[current.parentSectionId] ?? invalid(`章节父级不存在：${current.parentSectionId}。`));
  }
  return chain;
}

function expectedSectionOrder(roots: string[], sections: DocumentTree["sections"]) {
  const order: string[] = [];
  const visit = (sectionId: string) => {
    order.push(sectionId);
    for (const childId of sections[sectionId].childSectionIds) visit(childId);
  };
  for (const root of roots) visit(root);
  return order;
}

function validateSections(tree: DocumentTree) {
  const roots: string[] = [];
  const childOwners = new Map<string, string>();
  for (const section of Object.values(tree.sections)) {
    sectionChain(section, tree.sections);
    if (section.parentSectionId === null) roots.push(section.id);
    for (const childId of section.childSectionIds) {
      const child = tree.sections[childId] ?? invalid(`子章节不存在：${childId}。`);
      if (child.parentSectionId !== section.id) invalid(`子章节 ${childId} 的父级不一致。`);
      if (childOwners.has(childId)) invalid(`子章节被多个父级占用：${childId}。`);
      childOwners.set(childId, section.id);
    }
  }
  for (const section of Object.values(tree.sections)) {
    if (section.parentSectionId !== null && childOwners.get(section.id) !== section.parentSectionId)
      invalid(`章节 ${section.id} 未出现在父章节的有序子章节中。`);
  }
  if (!roots.length) invalid("至少需要一个根章节。");

  const observed: string[] = [];
  const seen = new Set<string>();
  for (const block of tree.blocks) {
    const section = tree.sections[block.sectionId] ?? invalid(`阅读块章节不存在：${block.sectionId}。`);
    for (const id of sectionChain(section, tree.sections)) {
      if (!seen.has(id)) {
        seen.add(id);
        observed.push(id);
      }
    }
  }
  const observedPosition = new Map(observed.map((id, index) => [id, index]));
  roots.sort((a, b) => observedPosition.get(a)! - observedPosition.get(b)!);
  if (!sameOrder(observed, expectedSectionOrder(roots, tree.sections)))
    invalid("章节顺序与阅读块顺序不一致，或章节没有可阅读内容。");
}

function validateUnitsAndSentences(tree: DocumentTree) {
  const unitOwners = new Map<string, string>();
  for (const section of Object.values(tree.sections)) {
    for (const unitId of section.unitIds) {
      const unit = tree.units[unitId] ?? invalid(`章节直属单元不存在：${unitId}。`);
      if (unit.sectionId !== section.id) invalid(`单元 ${unitId} 的所属章节不一致。`);
      if (unitOwners.has(unitId)) invalid(`单元被多个章节占用：${unitId}。`);
      unitOwners.set(unitId, section.id);
    }
  }
  for (const unit of Object.values(tree.units)) {
    if (!tree.sections[unit.sectionId]) invalid(`单元章节不存在：${unit.sectionId}。`);
    if (unitOwners.get(unit.id) !== unit.sectionId) invalid(`单元 ${unit.id} 未出现在所属章节的有序单元中。`);
  }

  const referencedSentences = new Set<string>();
  const referencedAtoms = new Set<string>();
  for (const unit of Object.values(tree.units)) {
    for (const sentenceId of unit.sentenceIds) {
      const sentence = tree.sentences[sentenceId] ?? invalid(`句子不存在：${sentenceId}。`);
      if (sentence.unitId !== unit.id) invalid(`句子 ${sentenceId} 的所属单元不一致。`);
      if (referencedSentences.has(sentenceId)) invalid(`句子被多个单元占用：${sentenceId}。`);
      referencedSentences.add(sentenceId);
      for (const part of sentence.content) {
        if (part.kind !== "atom") continue;
        const atom = tree.atoms[part.atomId] ?? invalid(`内联原子不存在：${part.atomId}。`);
        if (atom.unitId !== unit.id) invalid(`原子 ${atom.id} 的所属单元不一致。`);
        if (referencedAtoms.has(atom.id)) invalid(`原子被重复引用：${atom.id}。`);
        referencedAtoms.add(atom.id);
      }
    }
  }
  if (referencedSentences.size !== Object.keys(tree.sentences).length) invalid("存在未被所属单元引用的句子。");
  if (referencedAtoms.size !== Object.keys(tree.atoms).length) invalid("存在未被句子引用的原子。");
}

function blockUnits(block: BlockNode) {
  switch (block.kind) {
    case "unit":
      return [block.unitId];
    case "figure":
      return block.captionUnitId ? [block.captionUnitId] : [];
    case "table":
      return [...(block.captionUnitId ? [block.captionUnitId] : []), ...block.rows.flat().map((cell) => cell.unitId)];
    default:
      return [];
  }
}

function validateBlocks(tree: DocumentTree) {
  const actualOrder = new Map<string, string[]>(Object.keys(tree.sections).map((id) => [id, []]));
  for (const block of tree.blocks) {
    if (block.kind === "figure" && block.asset === null && !block.warning)
      invalid(`缺失资产的图片块 ${block.id} 必须保留明确警告。`);
    for (const unitId of blockUnits(block)) {
      const unit = tree.units[unitId] ?? invalid(`阅读块引用的单元不存在：${unitId}。`);
      if (unit.sectionId !== block.sectionId) invalid(`阅读块 ${block.id} 与单元所属章节不一致。`);
      if (block.kind === "table" && unit.kind !== "table-cell" && unit.id !== block.captionUnitId)
        invalid(`表格内容必须引用 table-cell 单元：${unitId}。`);
      actualOrder.get(block.sectionId)!.push(unitId);
    }
  }
  for (const section of Object.values(tree.sections)) {
    if (!sameOrder(actualOrder.get(section.id)!, section.unitIds))
      invalid(`章节 ${section.id} 的直属单元顺序与阅读块不一致，或单元被重复占用。`);
  }
}

function validateAtoms(tree: DocumentTree) {
  for (const atom of Object.values(tree.atoms)) {
    if (atom.kind === "link") {
      let url: URL;
      try {
        url = new URL(atom.href);
      } catch {
        invalid(`链接原子 ${atom.id} 的 URL 无效。`);
      }
      if (!["https:", "http:", "mailto:"].includes(url.protocol))
        invalid(`链接原子 ${atom.id} 使用了危险或不支持的协议。`);
    }
    if (atom.kind === "cross-reference") {
      if (atom.targetUnitId && !tree.units[atom.targetUnitId]) invalid(`交叉引用目标不存在：${atom.targetUnitId}。`);
      if (!atom.targetUnitId && !atom.sourceTarget) invalid(`未解析交叉引用 ${atom.id} 必须保留来源目标。`);
    }
    if (atom.kind === "citation" && atom.targetUnitId && !tree.units[atom.targetUnitId])
      invalid(`文献引用目标不存在：${atom.targetUnitId}。`);
    if (atom.kind === "footnote-reference" && !tree.units[atom.targetUnitId])
      invalid(`脚注引用目标不存在：${atom.targetUnitId}。`);
    if ((atom.kind === "math" || atom.kind === "inline-object") && atom.source.format === "mathml")
      validateMarkup(atom.source.value, mathmlTags, `原子 ${atom.id} 的 MathML`);
  }
}

const rawHtmlTags = new Set([
  "blockquote",
  "br",
  "code",
  "em",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
const mathmlTags = new Set([
  "annotation",
  "math",
  "mfrac",
  "mi",
  "mn",
  "mo",
  "mroot",
  "mrow",
  "mspace",
  "msqrt",
  "msub",
  "msup",
  "mtext",
  "semantics",
]);

function validateMarkup(html: string, allowedTags: Set<string>, description: string) {
  const stack: string[] = [];
  const tokens = html.matchAll(/<(\/?)([a-z0-9]+)\s*(\/?)>/gi);
  let valid = true;
  for (const match of tokens) {
    const [, closing, rawTag, selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (!allowedTags.has(tag) || (closing && selfClosing)) valid = false;
    if (tag === "br" || selfClosing) continue;
    if (closing) {
      if (stack.pop() !== tag) valid = false;
    } else stack.push(tag);
  }
  const remaining = html.replace(/<(\/?)([a-z0-9]+)\s*(\/?)>/gi, "");
  if (!valid || stack.length || remaining.includes("<") || /<!--|<!|<\?|javascript:|on[a-z]+\s*=/i.test(html))
    invalid(`${description} 未通过白名单消毒。`);
}

function validateNonTextBlocks(tree: DocumentTree) {
  for (const block of tree.blocks) {
    if (block.kind === "formula" && block.source.format === "mathml")
      validateMarkup(block.source.value, mathmlTags, `公式块 ${block.id} 的 MathML`);
    if (block.kind === "raw") {
      if (new TextEncoder().encode(block.html).byteLength > maximumRawHtmlBytes)
        invalid(`raw block ${block.id} 超过 2 MiB 预算。`);
      validateMarkup(block.html, rawHtmlTags, `raw block ${block.id}`);
    }
    if ((block.kind === "figure" || block.kind === "formula") && block.asset) {
      const match = /^assets\/([a-f0-9]{64})\.[a-z0-9]+$/.exec(block.asset.path);
      if (!match || match[1] !== block.asset.sha256)
        invalid(`${block.kind === "figure" ? "图片" : "公式"}块 ${block.id} 的资产路径与 SHA-256 不一致。`);
    }
  }
}

export function parseDocumentTree(value: unknown, expectedPaperId?: string): DocumentTree {
  if (!documentTreeSchema.Check(value)) invalid("不符合 documentFormatVersion: 1 树 schema。");
  const tree = value;
  if (expectedPaperId !== undefined && tree.paperId !== expectedPaperId) invalid("paperId 与工程主论文身份不匹配。");
  const nodeCount =
    Object.keys(tree.sections).length +
    Object.keys(tree.units).length +
    Object.keys(tree.sentences).length +
    Object.keys(tree.atoms).length +
    tree.blocks.length;
  if (nodeCount > maximumNodeCount) invalid(`节点总数不能超过 ${maximumNodeCount}。`);
  if (!tree.blocks.length) invalid("至少需要一个阅读块。");

  const ids = new Set<string>();
  validateNodeTable(tree.sections, "章节", ids);
  validateNodeTable(tree.units, "单元", ids);
  validateNodeTable(tree.sentences, "句子", ids);
  validateNodeTable(tree.atoms, "原子", ids);
  for (const block of tree.blocks) {
    if (ids.has(block.id)) invalid(`节点 ID 重复：${block.id}。`);
    ids.add(block.id);
  }
  validateSections(tree);
  validateUnitsAndSentences(tree);
  validateBlocks(tree);
  validateAtoms(tree);
  validateNonTextBlocks(tree);
  return tree;
}

export function validateDocumentAssets(tree: DocumentTree, assetHashes: Readonly<Record<string, string>>) {
  for (const block of tree.blocks) {
    if ((block.kind !== "figure" && block.kind !== "formula") || !block.asset) continue;
    if (assetHashes[block.asset.path] !== block.asset.sha256)
      invalid(`图片块 ${block.id} 引用的资产未登记或摘要不一致：${block.asset.path}。`);
  }
}
