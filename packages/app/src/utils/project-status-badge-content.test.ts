import { describe, expect, it } from "vitest";
import { getProjectStatusBadgeContent } from "./project-status-badge-content";

describe("getProjectStatusBadgeContent", () => {
  it("shows a running dot while working", () => {
    expect(getProjectStatusBadgeContent("running")).toEqual({ kind: "dot", bucket: "running" });
  });

  it("shows the alert when input is needed", () => {
    expect(getProjectStatusBadgeContent("needs_input")).toEqual({ kind: "alert" });
  });

  it("shows a failed glyph when a workspace failed", () => {
    expect(getProjectStatusBadgeContent("failed")).toEqual({ kind: "glyph", bucket: "failed" });
  });

  it("shows an attention glyph when a workspace awaits review", () => {
    expect(getProjectStatusBadgeContent("attention")).toEqual({
      kind: "glyph",
      bucket: "attention",
    });
  });

  it("shows nothing when the project is done", () => {
    expect(getProjectStatusBadgeContent("done")).toBeNull();
  });

  it("shows nothing when there is no aggregate bucket to surface", () => {
    expect(getProjectStatusBadgeContent(null)).toBeNull();
  });
});
