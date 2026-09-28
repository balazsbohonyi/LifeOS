export type CapabilityStatus = "live" | "disabled" | "unsupported" | "degraded";

export interface Capability {
  status: CapabilityStatus;
  reason?: string;
}

export interface CapabilityRuntime {
  platform?: NodeJS.Platform;
  voiceLoaded?: boolean;
  observabilityLoaded?: boolean;
}

/** Additive capability metadata; the existing boolean modules map stays intact. */
export function buildCapabilities(
  modules: Record<string, boolean>,
  runtime: CapabilityRuntime = {},
): Record<string, Capability> {
  const platform = runtime.platform ?? process.platform;
  const capabilities: Record<string, Capability> = {};

  for (const [name, enabled] of Object.entries(modules)) {
    capabilities[name] = { status: enabled ? "live" : "disabled" };
  }

  if (platform === "win32") {
    if (modules.imessage) {
      capabilities.imessage = { status: "unsupported", reason: "iMessage requires macOS Messages" };
    }
    capabilities.menubar = { status: "unsupported", reason: "the native menu bar application is macOS-only" };
    capabilities.appFocusCapture = { status: "unsupported", reason: "app-focus capture is not ported to Windows" };
    capabilities.worksweep = { status: "unsupported", reason: "external background service is outside Windows v1" };
    capabilities.derivedsync = { status: "unsupported", reason: "external background service is outside Windows v1" };
    capabilities.deriver = { status: "unsupported", reason: "external background service is outside Windows v1" };
  }

  if (modules.voice && runtime.voiceLoaded === false) {
    capabilities.voice = { status: "degraded", reason: "voice module or playback executable is unavailable" };
  }
  if (runtime.observabilityLoaded === false) {
    capabilities.observability = { status: "degraded", reason: "dashboard backend failed to load" };
  } else if (runtime.observabilityLoaded === true) {
    capabilities.observability = { status: "live" };
  }

  return capabilities;
}
