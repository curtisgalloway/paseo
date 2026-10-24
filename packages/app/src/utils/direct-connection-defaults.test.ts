import { describe, expect, it } from "vitest";
import {
  directConnectionDefaults,
  resolveDirectConnectionDefaults,
} from "./direct-connection-defaults";

const httpsPage = { protocol: "https:", hostname: "hub.example.test", port: "" };

describe("directConnectionDefaults", () => {
  it("keeps the local defaults without a page location", () => {
    expect(directConnectionDefaults(undefined)).toEqual({
      host: "",
      port: "6767",
      useTls: false,
    });
  });

  it("keeps the local defaults on a plain http page", () => {
    expect(
      directConnectionDefaults({ protocol: "http:", hostname: "localhost", port: "8090" }),
    ).toEqual({ host: "", port: "6767", useTls: false });
  });

  it("uses the page origin with port 443 over https", () => {
    expect(directConnectionDefaults(httpsPage)).toEqual({
      host: "hub.example.test",
      port: "443",
      useTls: true,
    });
  });

  it("uses the explicit page port over https", () => {
    expect(directConnectionDefaults({ ...httpsPage, port: "8443" })).toEqual({
      host: "hub.example.test",
      port: "8443",
      useTls: true,
    });
  });
});

describe("resolveDirectConnectionDefaults", () => {
  it("applies the page origin in a browser", () => {
    expect(
      resolveDirectConnectionDefaults({ isWeb: true, isElectron: false }, httpsPage).useTls,
    ).toBe(true);
  });

  it("keeps local defaults in Electron", () => {
    expect(resolveDirectConnectionDefaults({ isWeb: true, isElectron: true }, httpsPage).host).toBe(
      "",
    );
  });

  it("keeps local defaults on native", () => {
    expect(
      resolveDirectConnectionDefaults({ isWeb: false, isElectron: false }, httpsPage).port,
    ).toBe("6767");
  });
});
