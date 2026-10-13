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
  | { type: "resolveFile"; root: string; path: string };

export interface Desktop {
  invoke<T>(command: Command): Promise<T>;
  choose(kind: "pdf" | "folder" | "material"): Promise<string | null>;
  openFile(root: string, path: string): Promise<void>;
}
