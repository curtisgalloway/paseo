import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export type ProjectStatusBadgeDotBucket = "running";
export type ProjectStatusBadgeGlyphBucket = "failed" | "attention";

export type ProjectStatusBadgeContent =
  | { kind: "alert" }
  | { kind: "glyph"; bucket: ProjectStatusBadgeGlyphBucket }
  | { kind: "dot"; bucket: ProjectStatusBadgeDotBucket };

/**
 * What the project status badge should render for a project's aggregate bucket, or null when
 * no badge should show at all. Kept as plain data (no React) so it's testable without JSDOM
 * or component mounting — see docs/testing.md's two test categories.
 *
 * Running is a dot rather than its own glyph. The badge is 14pt; anything with internal detail
 * at that size loses to a solid disc, so running separates by color and by pulsing. Every state
 * that needs a person carries its own shape as well as a color (alert, X, check), so failed and
 * ready-for-review never differ by red versus green alone.
 */
export function getProjectStatusBadgeContent(
  statusBucket: SidebarStateBucket | null,
): ProjectStatusBadgeContent | null {
  if (statusBucket === "needs_input") {
    return { kind: "alert" };
  }
  if (statusBucket === "failed" || statusBucket === "attention") {
    return { kind: "glyph", bucket: statusBucket };
  }
  if (statusBucket === "running") {
    return { kind: "dot", bucket: statusBucket };
  }
  return null;
}
