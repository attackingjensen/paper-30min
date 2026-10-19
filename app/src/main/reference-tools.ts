import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ReferenceService } from "./reference-service.js";

export function createReferenceTools(root: string, references: ReferenceService, active: () => boolean) {
  const fields = {
    link: Type.String({ description: "Existing complete paper://cite/... or project-relative PDF#annotation=... link, without Markdown wrapper." }),
    sourceDocument: Type.Optional(Type.String({ description: "Project-relative Markdown source path for a relative annotation link. Omit only for chat links relative to the project root." })),
  };
  const check = (signal?: AbortSignal) => { signal?.throwIfAborted(); if (!active()) throw new Error("任务已停止。"); };
  return [
    defineTool({ name: "resolve_reference", label: "读取引用与批注",
      description: "Read an existing project citation or native PDF annotation as structured text. Returns actual PDF identity, pages/regions, available excerpt (selection or parser), and annotation comment separately. Does not create citations, render images, extract PDF text or write files. Reuse complete links from read/search verbatim; use read_pdf only when a page image is needed.",
      parameters: Type.Object(fields),
      async execute(_id, args, signal) {
        check(signal);
        const reference = await references.resolve(root, args, signal);
        check(signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(reference) }], details: { reference } };
      },
    }),
    defineTool({ name: "create_annotation", label: "创建块级评论",
      description: "Write and save a native PDF comment ONLY when the user asks for annotations. Requires an existing parsed block citation with reliable registered page/region; never guess coordinates or IDs. Page-only links are insufficient. Preserves existing annotations, flushes pending reader edits and rejects external PDF conflicts. Returns a reusable annotation link only after saving.",
      parameters: Type.Object({ ...fields, comment: Type.String({ minLength: 1, maxLength: 100000 }) }),
      async execute(_id, args, signal) {
        check(signal);
        const result = await references.create(root, args, signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { annotation: result } };
      },
    }),
  ];
}
