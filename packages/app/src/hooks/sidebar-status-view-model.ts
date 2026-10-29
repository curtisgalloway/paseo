import type { TFunction } from "i18next";
import { STATUS_BUCKET_ORDER } from "@/utils/sidebar-agent-state";
import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";

export type StatusBucket = SidebarWorkspaceEntry["statusBucket"];

export { STATUS_BUCKET_ORDER };

const STATUS_BUCKET_LABEL_KEYS = {
  needs_input: "sidebar.statusBucket.needsInput",
  failed: "sidebar.statusBucket.failed",
  attention: "sidebar.statusBucket.readyToReview",
  running: "sidebar.statusBucket.working",
  done: "sidebar.statusBucket.done",
} as const satisfies Record<StatusBucket, string>;

export function getStatusBucketLabel(bucket: StatusBucket, t: TFunction): string {
  return t(STATUS_BUCKET_LABEL_KEYS[bucket]);
}

export interface StatusGroup {
  bucket: StatusBucket;
  label: string;
  rows: SidebarWorkspaceEntry[];
}

export function buildStatusGroups(
  workspaces: SidebarWorkspaceEntry[],
  projectNamesByViewKey: Map<string, string>,
  t: TFunction,
): StatusGroup[] {
  const bucketRows = new Map<StatusBucket, SidebarWorkspaceEntry[]>();

  for (const ws of workspaces) {
    const bucket: StatusBucket = ws.statusBucket;
    let rows = bucketRows.get(bucket);
    if (!rows) {
      rows = [];
      bucketRows.set(bucket, rows);
    }
    rows.push(ws);
  }

  const groups: StatusGroup[] = [];

  for (const bucket of STATUS_BUCKET_ORDER) {
    const rows = bucketRows.get(bucket);
    if (!rows || rows.length === 0) continue;

    rows.sort((a, b) => compareStatusRows(a, b, projectNamesByViewKey));
    groups.push({ bucket, label: getStatusBucketLabel(bucket, t), rows });
  }

  return groups;
}

function compareStatusRows(
  a: SidebarWorkspaceEntry,
  b: SidebarWorkspaceEntry,
  projectNamesByViewKey: Map<string, string>,
): number {
  const aTime = a.statusEnteredAt?.getTime() ?? null;
  const bTime = b.statusEnteredAt?.getTime() ?? null;

  if (aTime !== null && bTime !== null) {
    if (aTime !== bTime) return bTime - aTime;
  } else if (aTime !== null) {
    return -1;
  } else if (bTime !== null) {
    return 1;
  }

  const aProject = projectNamesByViewKey.get(a.projectViewKey) ?? "";
  const bProject = projectNamesByViewKey.get(b.projectViewKey) ?? "";
  const projectCmp = aProject.localeCompare(bProject);
  if (projectCmp !== 0) return projectCmp;

  const nameCmp = a.name.localeCompare(b.name);
  if (nameCmp !== 0) return nameCmp;

  return a.workspaceKey.localeCompare(b.workspaceKey);
}

export function buildStatusShortcutIndex(groups: StatusGroup[]): Map<string, number> {
  const index = new Map<string, number>();
  let shortcutNumber = 1;
  for (const group of groups) {
    for (const row of group.rows) {
      if (shortcutNumber > 9) return index;
      index.set(row.workspaceKey, shortcutNumber);
      shortcutNumber += 1;
    }
  }
  return index;
}

/** Buckets whose rows are waiting on the user. */
export function isWaitingOnUserBucket(bucket: StatusBucket): boolean {
  return bucket === "needs_input" || bucket === "failed";
}

/**
 * The status view's endpoint: nothing, pinned rows included, needs the user. Pinned rows sit
 * outside the groups, so the groups alone would call a pinned failure "all clear".
 */
export function isStatusViewAllClear(input: {
  groupBuckets: readonly StatusBucket[];
  pinnedBuckets: readonly StatusBucket[];
}): boolean {
  return (
    !input.groupBuckets.some(isWaitingOnUserBucket) &&
    !input.pinnedBuckets.some(isWaitingOnUserBucket)
  );
}

/**
 * Which trailing label a row gets. Waiting rows count from when they entered the state; a
 * row with no entry time (old daemon, empty workspace) keeps the activity label.
 */
export function resolveRowTimeLabelKind(input: {
  statusBucket: StatusBucket;
  statusEnteredAt: Date | null;
}): "waiting" | "activity" {
  return isWaitingOnUserBucket(input.statusBucket) && input.statusEnteredAt !== null
    ? "waiting"
    : "activity";
}
