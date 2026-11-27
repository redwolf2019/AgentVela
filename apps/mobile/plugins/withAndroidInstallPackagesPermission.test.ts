import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AndroidConfig, compileModsAsync, XML } from "expo/config-plugins";
import { afterEach, describe, expect, it } from "vite-plus/test";

import withAndroidInstallPackagesPermission from "./withAndroidInstallPackagesPermission.cjs";

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET"/>
  <application android:name=".MainApplication" />
</manifest>`;

const projectRoots: string[] = [];

afterEach(() => {
  for (const root of projectRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

async function runPlugin(manifest = MANIFEST): Promise<string> {
  const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "install-perm-"));
  projectRoots.push(projectRoot);
  const manifestPath = NodePath.join(projectRoot, "android/app/src/main/AndroidManifest.xml");
  NodeFS.mkdirSync(NodePath.dirname(manifestPath), { recursive: true });
  NodeFS.writeFileSync(manifestPath, manifest);

  const config = withAndroidInstallPackagesPermission({
    name: "T3 Code",
    slug: "t3-code",
  });
  await compileModsAsync(config, { projectRoot, platforms: ["android"] });
  return NodeFS.readFileSync(manifestPath, "utf8");
}

describe("withAndroidInstallPackagesPermission", () => {
  it("adds REQUEST_INSTALL_PACKAGES once and stays idempotent across prebuilds", async () => {
    const first = await runPlugin();
    const parsed = (await XML.parseXMLAsync(first)) as AndroidConfig.Manifest.AndroidManifest;
    const permissions = AndroidConfig.Permissions.getPermissions(parsed);
    expect(permissions).toContain("android.permission.REQUEST_INSTALL_PACKAGES");
    expect(
      permissions.filter((name) => name === "android.permission.REQUEST_INSTALL_PACKAGES"),
    ).toHaveLength(1);

    const second = await runPlugin(first);
    expect(second).toBe(first);
  });
});
