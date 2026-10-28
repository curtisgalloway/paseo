import { useMemo, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import { StatusGlyph, isStatusGlyphBucket } from "@/components/status-glyph";
import { getStatusBucketLabel } from "@/hooks/sidebar-status-view-model";
import { StatusRing } from "@/components/status-ring";
import { getStatusRingOffset } from "@/components/status-ring/geometry";
import {
  STATUS_INDICATOR_ALERT_SIZE,
  STATUS_INDICATOR_DOT_SIZE,
} from "@/utils/status-indicator-geometry";

interface StatusIconProps {
  children: ReactNode;
  statusBucket: SidebarStateBucket | null;
  size?: number;
  /** @deprecated No longer used: the status mark is a glyph with no border. */
  statusDotBorderColor?: string;
  backdrop: SurfaceBackdrop;
}
const DEFAULT_STATUS_DOT_OFFSET = -2;
const STATUS_ALERT_OFFSET = -3;

export function StatusIcon({
  children,
  statusBucket,
  size = 14,
  backdrop,
}: StatusIconProps): ReactElement {
  const { t } = useTranslation();
  const bucket = statusBucket;
  const isRunning = bucket === "running";
  const glyphBucket = isStatusGlyphBucket(bucket) ? bucket : null;
  const agentIconWrapperStyle = useMemo(
    () => [styles.agentIconWrapper, { width: size, height: size }],
    [size],
  );

  return (
    <View style={agentIconWrapperStyle}>
      {children}
      {isRunning ? (
        <View
          style={styles.statusRing}
          accessibilityRole="progressbar"
          accessibilityLabel="Agent running"
        >
          <StatusRing backdrop={backdrop} />
        </View>
      ) : null}
      {glyphBucket ? (
        <View
          style={styles.statusAlertOverlay}
          role="status"
          accessibilityLabel={getStatusBucketLabel(glyphBucket, t)}
        >
          <StatusGlyph bucket={glyphBucket} size={STATUS_INDICATOR_ALERT_SIZE} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  agentIconWrapper: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  statusRing: {
    position: "absolute",
    right: getStatusRingOffset(DEFAULT_STATUS_DOT_OFFSET, STATUS_INDICATOR_DOT_SIZE),
    bottom: getStatusRingOffset(DEFAULT_STATUS_DOT_OFFSET, STATUS_INDICATOR_DOT_SIZE),
  },
  statusAlertOverlay: {
    position: "absolute",
    right: STATUS_ALERT_OFFSET,
    bottom: STATUS_ALERT_OFFSET,
  },
}));
