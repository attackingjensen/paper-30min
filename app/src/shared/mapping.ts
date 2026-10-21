export interface MappingPlan {
  id: string;
  directory: string;
  manuscript: string;
  manifestVersion: string;
  files: Record<string, string | null>;
  targets: string[];
}

export interface MappingState {
  directory: string;
  status: "pending" | "published";
  files?: string[];
}
