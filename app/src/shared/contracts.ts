export interface DocumentRecord {
  id: string;
  path: string;
  sha256: string;
}

export interface Manifest {
  formatVersion: 1;
  id: string;
  name: string;
  paper: DocumentRecord;
  materials: DocumentRecord[];
  map: string | null;
  explanations: string[];
  translations: Record<string, string>;
}

export interface FileEntry {
  path: string;
  directory: boolean;
}
export interface Project {
  root: string;
  manifest: Manifest;
  files: FileEntry[];
  missing: string[];
  reading: ReadingState;
}
export interface DocumentTab {
  key: string;
  title: string;
  path?: string;
  markdown?: {
    mode: "read" | "edit" | "split";
    scroll: number;
    readScroll?: number;
    cursor: number;
  };
}
export interface MarkdownFile {
  text: string;
  version: string;
}
export type MarkdownSave =
  | { saved: true; file: MarkdownFile }
  | { saved: false; file: MarkdownFile | null };
export interface ProjectAsset {
  bytes: Uint8Array;
  mime: string;
}
export interface PdfPosition {
  sha256: string;
  page: number;
  x: number;
  y: number;
  zoom: number;
  scrollStrategy?: "vertical" | "horizontal";
  spreadMode?: "none" | "odd" | "even";
  rotation?: 0 | 1 | 2 | 3;
}
export interface ReadingState {
  tabs: DocumentTab[];
  active: string;
  pdf: Record<string, PdfPosition>;
}
export interface PdfSource {
  bytes: Uint8Array;
  sha256: string;
}
export interface Preferences {
  defaultFolder: string | null;
  recent: { root: string; name: string }[];
}
export interface CreateInput {
  source: string;
  parent: string;
  name: string;
  makeDefault: boolean;
  operationId: string;
}
export type Command =
  | { type: "preferences" }
  | { type: "setDefault"; folder: string | null }
  | { type: "create"; input: CreateInput }
  | { type: "cancelCreate"; operationId: string }
  | { type: "open"; root: string }
  | { type: "refresh"; root: string }
  | { type: "addMaterial"; root: string; source: string }
  | { type: "move"; root: string; path: string; destination: string }
  | { type: "relink"; root: string; id: string; source: string }
  | { type: "trash"; root: string; id: string }
  | { type: "read"; root: string; path: string }
  | { type: "readMarkdown"; root: string; path: string }
  | {
      type: "saveMarkdown";
      root: string;
      path: string;
      text: string;
      version: string;
    }
  | { type: "createNote"; root: string; name: string }
  | { type: "readAsset"; root: string; path: string }
  | { type: "readPdf"; root: string; path: string }
  | { type: "saveWorkspace"; root: string; tabs: DocumentTab[]; active: string }
  | {
      type: "savePdfPosition";
      root: string;
      path: string;
      position: PdfPosition;
    }
  | { type: "resolveFile"; root: string; path: string };

export interface Desktop {
  invoke<T>(command: Command): Promise<T>;
  choose(kind: "pdf" | "folder" | "material"): Promise<string | null>;
  watchProject(root: string, listener: (error?: string) => void): () => void;
  openLink(url: string): Promise<void>;
  openFile(root: string, path: string): Promise<void>;
}
