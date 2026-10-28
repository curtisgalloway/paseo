import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Moon } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DensityIcon } from "@/components/ui/density-icon";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import {
  FOCUS_DURATION_OPTIONS_MS,
  focusBarFraction,
  focusRemainingMs,
  formatFocusRemaining,
} from "./format";

const TICK_MS = 15_000;

const DURATION_LABEL_KEYS = {
  [FOCUS_DURATION_OPTIONS_MS[0]]: "sidebar.focus.duration25",
  [FOCUS_DURATION_OPTIONS_MS[1]]: "sidebar.focus.duration60",
  [FOCUS_DURATION_OPTIONS_MS[2]]: "sidebar.focus.duration120",
} as const;

/**
 * The host Focus controls: the active workspace's host when it supports focus, otherwise the
 * first connected host that does. Focus is per daemon, and each daemon holds its own agents.
 */
function useFocusHostId(): string | null {
  const active = useActiveWorkspaceSelection();
  const last = useLastWorkspaceSelection();
  const preferred = active?.serverId ?? last?.serverId ?? null;
  return useSessionStore((state) => {
    if (preferred && state.sessions[preferred]?.serverInfo?.features?.attentionFocus === true) {
      return preferred;
    }
    for (const [serverId, session] of Object.entries(state.sessions)) {
      if (session.serverInfo?.features?.attentionFocus === true) return serverId;
    }
    return null;
  });
}

/** Whether any connected host supports focus, so the footer knows to show the row. */
export function useFocusAvailable(): boolean {
  return useFocusHostId() !== null;
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(interval);
  }, [enabled]);
  return now;
}

/**
 * Footer row that holds agent notifications for a while. Idle it reads "Focus"; during a period it
 * shows the time left and a bar that shrinks to empty, with a count of what is being held.
 */
export function FocusSidebarItem() {
  const serverId = useFocusHostId();
  if (!serverId) return null;
  return <FocusRow serverId={serverId} />;
}

function FocusRow({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const focus = useSessionStore((state) => state.sessions[serverId]?.serverInfo?.attentionFocus);
  const [open, setOpen] = useState(false);
  const active = focus?.active === true && focus.until !== null;
  const now = useNow(active);

  const setFocus = useCallback(
    (durationMs: number | null) => {
      void client?.setAttentionFocus(durationMs).catch(() => {});
    },
    [client],
  );

  const remainingMs = active && focus.until ? focusRemainingMs(focus.until, now) : 0;
  const remaining = formatFocusRemaining(remainingMs);
  const remainingText =
    remaining.kind === "minutes"
      ? t("sidebar.focus.minutesLeft", { minutes: remaining.minutes })
      : t("sidebar.focus.lessThanMinuteLeft");
  const heldCount = focus?.heldCount ?? 0;
  const heldText = heldCount > 0 ? t("sidebar.focus.held", { count: heldCount }) : null;

  const label = t("sidebar.focus.label");
  const visibleText = active ? [label, remainingText, heldText].filter(Boolean).join(" · ") : label;
  const accessibilityLabel = active
    ? t("sidebar.focus.accessibilityActive", { details: visibleText })
    : t("sidebar.focus.accessibilityInactive");

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        style={styles.trigger}
        testID="sidebar-focus"
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        {({ hovered, open: menuOpen }) => (
          <View style={[styles.row, hovered || menuOpen ? styles.rowHovered : null]}>
            <View style={styles.line}>
              <DensityIcon
                icon={Moon}
                size="md"
                color={active || hovered ? "foreground" : "foregroundMuted"}
              />
              <Text
                style={active ? styles.text : styles.textIdle}
                numberOfLines={1}
                testID="sidebar-focus-text"
              >
                {visibleText}
              </Text>
            </View>
            {active ? (
              <View style={styles.track} testID="sidebar-focus-bar">
                <View
                  style={[styles.fill, { width: `${focusBarFraction(remainingMs, focus) * 100}%` }]}
                />
              </View>
            ) : null}
          </View>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        offset={8}
        width={200}
        testID="sidebar-focus-menu"
      >
        {active ? (
          <>
            <FocusMenuItem
              testID="sidebar-focus-end"
              durationMs={null}
              label={t("sidebar.focus.end")}
              onChoose={setFocus}
            />
            <DropdownMenuSeparator />
          </>
        ) : null}
        {FOCUS_DURATION_OPTIONS_MS.map((durationMs) => (
          <FocusMenuItem
            key={durationMs}
            testID={`sidebar-focus-start-${durationMs / 60_000}`}
            durationMs={durationMs}
            label={t(DURATION_LABEL_KEYS[durationMs])}
            onChoose={setFocus}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FocusMenuItem({
  testID,
  durationMs,
  label,
  onChoose,
}: {
  testID: string;
  durationMs: number | null;
  label: string;
  onChoose: (durationMs: number | null) => void;
}) {
  const handleSelect = useCallback(() => onChoose(durationMs), [onChoose, durationMs]);
  return (
    <DropdownMenuItem testID={testID} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: "100%",
  },
  // Same row geometry and leading rail as the Usage row and Add project.
  row: {
    width: "100%",
    minHeight: 28,
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  text: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  textIdle: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  track: {
    height: 3,
    marginTop: theme.spacing[1],
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: theme.colors.border,
  },
  fill: {
    height: "100%",
    borderRadius: 2,
    backgroundColor: theme.colors.foregroundMuted,
  },
}));
