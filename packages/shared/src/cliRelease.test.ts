import { describe, expect, it } from "vite-plus/test";

import {
  CLI_RELEASES_PAGE_URL,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseAssetUrl,
  cliReleaseDownloadBaseUrl,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("maps supported archive platform keys", () => {
    expect(cliArchivePlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(cliArchivePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(cliArchivePlatformKey("linux", "arm64")).toBe("linux-arm64");
    expect(cliArchivePlatformKey("win32", "x64")).toBe("win32-x64");
    expect(cliArchivePlatformKey("win32", "arm64")).toBeUndefined();
    expect(cliArchivePlatformKey("darwin", "x64")).toBeUndefined();
  });

  it("defaults release URLs to redwolf2019/AgentVela and normalizes /releases bases", () => {
    expect(CLI_RELEASES_PAGE_URL).toBe("https://github.com/redwolf2019/AgentVela/releases");
    expect(cliReleaseDownloadBaseUrl("1.2.3")).toBe(
      "https://github.com/redwolf2019/AgentVela/releases/download/v1.2.3",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example.com/releases")).toBe(
      "https://mirror.example.com/releases/download/v1.2.3",
    );
    expect(
      cliReleaseAssetUrl("1.2.3", "SHA256SUMS", "https://updates.example.com/t3code/?token=abc"),
    ).toBe("https://updates.example.com/t3code/v1.2.3/SHA256SUMS?token=abc");
  });
});
