import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTelemetryPref,
  setTelemetryPref,
  shouldTrack,
  __setEnvAllowedForTest,
} from "./analytics";

const TAURI = "__TAURI_INTERNALS__";

beforeEach(() => {
  localStorage.clear();
  __setEnvAllowedForTest(false);
  delete (window as unknown as Record<string, unknown>)[TAURI];
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[TAURI];
});

describe("telemetry preference", () => {
  it("defaults to on", () => {
    expect(getTelemetryPref()).toBe("on");
  });

  it("persists a change to localStorage", () => {
    setTelemetryPref("off");
    expect(getTelemetryPref()).toBe("off");
    expect(localStorage.getItem("delta.telemetry")).toBe("off");
  });
});

describe("shouldTrack gate", () => {
  it("is false when not in a Tauri webview", () => {
    __setEnvAllowedForTest(true);
    setTelemetryPref("on");
    // no __TAURI_INTERNALS__ on window
    expect(shouldTrack()).toBe(false);
  });

  it("is true only when in Tauri, env-allowed, and pref on", () => {
    (window as unknown as Record<string, unknown>)[TAURI] = {};
    __setEnvAllowedForTest(true);
    setTelemetryPref("on");
    expect(shouldTrack()).toBe(true);
  });

  it("is false when the user turned it off", () => {
    (window as unknown as Record<string, unknown>)[TAURI] = {};
    __setEnvAllowedForTest(true);
    setTelemetryPref("off");
    expect(shouldTrack()).toBe(false);
  });

  it("is false when build/env disallows", () => {
    (window as unknown as Record<string, unknown>)[TAURI] = {};
    __setEnvAllowedForTest(false);
    setTelemetryPref("on");
    expect(shouldTrack()).toBe(false);
  });
});
