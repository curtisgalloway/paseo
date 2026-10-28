import type { ReactElement } from "react";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";

/**
 * The states that carry a shape of their own instead of a bare colored dot, so that failed and
 * ready-for-review never differ by red versus green alone: an alert for needs-input, an X for
 * failed, a check for finished-and-unread. Running keeps its ring; done has no mark.
 */
export type StatusGlyphBucket = Extract<SidebarStateBucket, "needs_input" | "failed" | "attention">;

export function isStatusGlyphBucket(
  bucket: SidebarStateBucket | null | undefined,
): bucket is StatusGlyphBucket {
  return bucket === "needs_input" || bucket === "failed" || bucket === "attention";
}

const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleX = withUnistyles(CircleX);
const ThemedCircleCheck = withUnistyles(CircleCheck);

// Disc in the status color with the glyph knocked out in the surface color, the way the
// needs-input alert has always been drawn.
const glyphMapping = (bucket: StatusGlyphBucket) => (theme: Theme) => ({
  color: theme.colors.surface0,
  fill: getStatusDotColor({ theme, bucket }) ?? undefined,
});
const needsInputMapping = glyphMapping("needs_input");
const failedMapping = glyphMapping("failed");
const attentionMapping = glyphMapping("attention");

export function StatusGlyph({
  bucket,
  size,
}: {
  bucket: StatusGlyphBucket;
  size: number;
}): ReactElement {
  switch (bucket) {
    case "needs_input":
      return <ThemedCircleAlert size={size} uniProps={needsInputMapping} />;
    case "failed":
      return <ThemedCircleX size={size} uniProps={failedMapping} />;
    case "attention":
      return <ThemedCircleCheck size={size} uniProps={attentionMapping} />;
  }
}
