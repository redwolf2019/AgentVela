import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  codexMessageResetAt,
  codexTimeZone,
  codexUsageLimitResetAt,
  mergeCodexRateLimits,
} from "./codexUsageLimits.ts";

describe("mergeCodexRateLimits", () => {
  it("keeps cumulative windows when partial rate-limit updates omit fields", () => {
    const snapshot = {
      limitId: "codex",
      primary: { usedPercent: 12 },
      individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
    };
    const individualLimit = { remainingPercent: 75, resetsAt: 1_787_000_000 };
    const changed = mergeCodexRateLimits(snapshot, { individualLimit });
    expect(changed).toEqual({ ...snapshot, individualLimit });

    const retained = mergeCodexRateLimits(changed, { primary: null });
    expect(retained).toEqual({ ...snapshot, primary: null, individualLimit });
    const cleared = mergeCodexRateLimits(retained, { individualLimit: null });
    expect(cleared).toEqual({ ...snapshot, primary: null, individualLimit: null });
  });

  it("ignores a model-specific snapshot so it cannot replace the main allowance", () => {
    const main = {
      limitId: "codex",
      primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    };
    expect(
      mergeCodexRateLimits(main, {
        limitId: "spark",
        individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
        primary: { usedPercent: 3, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      }),
    ).toBe(main);
  });
});

describe("codexUsageLimitResetAt", () => {
  it("waits for every exhausted window and never invents an unknown reset", () => {
    expect(
      codexUsageLimitResetAt({
        primary: { usedPercent: 100, resetsAt: 2000000000 },
        secondary: { usedPercent: 100, resetsAt: 2000100000 },
      }),
    ).toBe("2033-05-19T07:20:00.000Z");
    expect(codexUsageLimitResetAt({ primary: { usedPercent: 100 } })).toBeNull();
    expect(
      codexUsageLimitResetAt({ primary: { usedPercent: 50, resetsAt: 2000000000 } }),
    ).toBeNull();
  });
});

describe("codexMessageResetAt", () => {
  const dhaka = DateTime.zoneMakeNamedUnsafe("Asia/Dhaka");
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const failedAt = at("2026-11-07T03:00:00Z"); // 09:00 in Dhaka

  // Codex prints local time without seconds, so the parsed reset is the minute after.
  it("reads Codex's same-day and dated reset text in Codex's zone", () => {
    expect(
      codexMessageResetAt("You’ve hit your usage limit. Try again at 3:37 PM.", failedAt, dhaka),
    ).toBe("2026-11-07T09:38:00.000Z");
    expect(
      codexMessageResetAt("Upgrade, or try again at Dec 1st, 2026 12:05 AM.", failedAt, dhaka),
    ).toBe("2026-11-30T18:06:00.000Z");
    expect(codexMessageResetAt("Try again at 12:30 PM.", failedAt, dhaka)).toBe(
      "2026-11-07T06:31:00.000Z",
    );
  });

  it("dates today's form by when Codex failed, across local midnight", () => {
    expect(codexMessageResetAt("Try again at 11:59 PM.", at("2026-11-07T17:59:59Z"), dhaka)).toBe(
      "2026-11-07T18:00:00.000Z",
    );
  });

  it("takes the later instant of a repeated DST hour", () => {
    // 1:30 AM occurs twice in New York on Nov 1st, 2026: 05:30Z (EDT) and 06:30Z (EST).
    const newYork = DateTime.zoneMakeNamedUnsafe("America/New_York");
    for (const iso of ["2026-11-01T05:15:00Z", "2026-11-01T06:15:00Z"]) {
      expect(codexMessageResetAt("Try again at 1:30 AM.", at(iso), newYork)).toBe(
        "2026-11-01T06:31:00.000Z",
      );
    }
  });

  it("leaves the reset unknown without reset text or once it has passed", () => {
    expect(
      codexMessageResetAt("You’ve hit your usage limit. Try again later.", failedAt, dhaka),
    ).toBeNull();
    expect(
      codexMessageResetAt(
        "exceeded retry limit, last status: 429 Too Many Requests",
        failedAt,
        dhaka,
      ),
    ).toBeNull();
    expect(codexMessageResetAt("Try again at 8:15 AM.", failedAt, dhaka)).toBeNull();
  });
});

describe("codexTimeZone", () => {
  it("uses Codex's TZ and falls back to the server's zone", () => {
    const local = DateTime.zoneToString(DateTime.zoneMakeLocal());
    expect(DateTime.zoneToString(codexTimeZone({ TZ: ":Asia/Dhaka" }))).toBe("Asia/Dhaka");
    expect(DateTime.zoneToString(codexTimeZone({ TZ: "not/a-zone" }))).toBe(local);
    expect(DateTime.zoneToString(codexTimeZone({}))).toBe(local);
  });
});
