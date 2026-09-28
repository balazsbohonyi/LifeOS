import { describe, expect, test } from "bun:test";
import { buildCapabilities } from "./capabilities";

describe("capability metadata", () => {
  test("is additive and does not mutate legacy module booleans", () => {
    const modules = { voice: true, imessage: false, work: true };
    const before = structuredClone(modules);
    const capabilities = buildCapabilities(modules, { platform: "linux", voiceLoaded: true });
    expect(modules).toEqual(before);
    expect(capabilities.work.status).toBe("live");
    expect(capabilities.imessage.status).toBe("disabled");
  });

  test("reports Windows-only limitations explicitly", () => {
    const capabilities = buildCapabilities({ voice: true, imessage: true }, {
      platform: "win32",
      voiceLoaded: false,
      observabilityLoaded: true,
    });
    expect(capabilities.imessage.status).toBe("unsupported");
    expect(capabilities.menubar.status).toBe("unsupported");
    expect(capabilities.voice.status).toBe("degraded");
    expect(capabilities.observability.status).toBe("live");
  });
});
