import type { CoreCommand } from "../shared/contracts.js";
import {
  commitRevision,
  createProject,
  openProject,
  publishSourceSnapshot,
  readRevision,
  readRevisionDocument,
  readSourceSnapshot,
} from "./project-core.js";
import {
  createDocumentMergeCandidate,
  publishDocumentMergeCandidate,
  resolveDocumentMergeCandidateConflict,
} from "./document/merge.js";

const coreCommandTypes: Record<CoreCommand["type"], true> = {
  coreCreate: true,
  coreOpen: true,
  corePublishSource: true,
  coreCommit: true,
  coreReadSource: true,
  coreReadRevision: true,
  coreReadDocument: true,
  coreMergePublish: true,
};

export function isCoreCommand(command: { type: string }): command is CoreCommand {
  return command.type in coreCommandTypes;
}

export function dispatchCoreCommand(command: CoreCommand): Promise<unknown> {
  switch (command.type) {
    case "coreCreate":
      return createProject({ parent: command.parent, name: command.name });
    case "coreOpen":
      return openProject(command.root);
    case "corePublishSource":
      return publishSourceSnapshot({
        root: command.root,
        files: command.files,
        metadata: command.metadata,
      });
    case "coreCommit":
      return commitRevision({
        root: command.root,
        baseRevision: command.baseRevision,
        sourceSnapshotId: command.sourceSnapshotId,
        revisionId: command.revisionId,
        files: command.files,
        metadata: command.metadata,
      });
    case "coreReadSource":
      return readSourceSnapshot(command.root, command.sourceSnapshotId);
    case "coreReadRevision":
      return readRevision(command.root, command.revisionId);
    case "coreReadDocument":
      return readRevisionDocument(command.root, command.revisionId, command.tree);
    case "coreMergePublish":
      return mergePublish(command);
  }
}

async function mergePublish(
  command: Extract<CoreCommand, { type: "coreMergePublish" }>,
) {
  let candidate = await createDocumentMergeCandidate({
    root: command.root,
    baseRevision: command.baseRevision,
    sourceSnapshotId: command.sourceSnapshotId,
    candidate: command.candidate,
  });
  for (const resolution of command.resolutions ?? []) {
    candidate = resolveDocumentMergeCandidateConflict(
      candidate,
      resolution.conflictId,
      resolution.choice,
    );
  }
  return publishDocumentMergeCandidate(candidate);
}