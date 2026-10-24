export interface DirectConnectionDefaults {
  host: string;
  port: string;
  useTls: boolean;
}

export interface PageLocation {
  protocol: string;
  hostname: string;
  port: string;
}

const NATIVE_DEFAULTS: DirectConnectionDefaults = { host: "", port: "6767", useTls: false };

/**
 * Initial values for the "Direct connection" form. A page served over https
 * (the daemon behind a TLS reverse proxy) can only open wss:// sockets, so it
 * defaults to the page's own origin. Pass undefined outside a browser page
 * (native, Electron, tests).
 */
export function directConnectionDefaults(
  location: PageLocation | undefined,
): DirectConnectionDefaults {
  if (!location || location.protocol !== "https:") {
    return NATIVE_DEFAULTS;
  }
  return { host: location.hostname, port: location.port || "443", useTls: true };
}

export function resolveDirectConnectionDefaults(
  env: { isWeb: boolean; isElectron: boolean },
  location: PageLocation | undefined,
): DirectConnectionDefaults {
  if (!env.isWeb || env.isElectron) {
    return NATIVE_DEFAULTS;
  }
  return directConnectionDefaults(location);
}
