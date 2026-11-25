import { describe, expect, it } from "vite-plus/test";

import { hashTelemetryId } from "./telemetryId.ts";

describe("telemetry ids", () => {
  it("produces a stable lowercase sha256 hex digest", () => {
    const hashed = hashTelemetryId("user_connect");
    expect(hashed).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashed).toBe(hashTelemetryId("user_connect"));
  });
});
