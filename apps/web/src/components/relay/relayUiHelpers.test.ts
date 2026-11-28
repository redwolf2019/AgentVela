import { describe, expect, it } from "vite-plus/test";

import {
  buildEnrollmentCommand,
  formatRelayBytes,
  formatRelayHostLabel,
  isValidRelayUsername,
  parsePositiveIntInput,
  parseTrimmedNonEmpty,
} from "./relayUiHelpers.ts";

describe("relayUiHelpers", () => {
  it("formats host labels and enrollment commands", () => {
    expect(formatRelayHostLabel("https://relay.example.com:8443/prefix")).toBe(
      "relay.example.com:8443",
    );
    expect(formatRelayHostLabel("not a url")).toBe("not a url");
    expect(formatRelayHostLabel(null)).toBe("");
    expect(buildEnrollmentCommand("https://relay.example.com", "enroll-123")).toBe(
      "agentvela relay link --url https://relay.example.com --token enroll-123",
    );
  });

  it("formats traffic byte counts", () => {
    expect(formatRelayBytes(-10)).toBe("0 B");
    expect(formatRelayBytes(512)).toBe("512 B");
    expect(formatRelayBytes(1536)).toBe("1.5 KB");
    expect(formatRelayBytes(1024 * 1024 * 120)).toBe("120 MB");
  });

  it("validates usernames and positive numeric/string inputs", () => {
    expect(isValidRelayUsername("alice-01")).toBe(true);
    expect(isValidRelayUsername("a")).toBe(false);
    expect(isValidRelayUsername("bad user!")).toBe(false);
    expect(parseTrimmedNonEmpty("  hello  ")).toBe("hello");
    expect(parseTrimmedNonEmpty("   ")).toBeNull();
    expect(parsePositiveIntInput(" 24 ")).toBe(24);
    expect(parsePositiveIntInput("0")).toBeNull();
    expect(parsePositiveIntInput("-3")).toBeNull();
  });
});
