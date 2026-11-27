import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { compileModsAsync } from "expo/config-plugins";
import { afterEach, describe, expect, it } from "vite-plus/test";

import withAndroidReleaseSigning from "./withAndroidReleaseSigning.cjs";

const SAMPLE_BUILD_GRADLE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`;

const projectRoots: string[] = [];

afterEach(() => {
  for (const root of projectRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

async function runPlugin(buildGradle = SAMPLE_BUILD_GRADLE): Promise<string> {
  const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-signing-"));
  projectRoots.push(projectRoot);
  const gradlePath = NodePath.join(projectRoot, "android/app/build.gradle");
  NodeFS.mkdirSync(NodePath.dirname(gradlePath), { recursive: true });
  NodeFS.writeFileSync(gradlePath, buildGradle);

  const config = withAndroidReleaseSigning({
    name: "T3 Code",
    slug: "t3-code",
  });
  await compileModsAsync(config, { projectRoot, platforms: ["android"] });
  return NodeFS.readFileSync(gradlePath, "utf8");
}

describe("withAndroidReleaseSigning", () => {
  it("adds env-backed release signing config without hardcoding secrets and stays idempotent", async () => {
    const first = await runPlugin();
    expect(first).toContain('System.getenv("ANDROID_KEYSTORE_PATH")');
    expect(first).toContain('System.getenv("ANDROID_KEYSTORE_PASSWORD")');
    expect(first).toContain('System.getenv("ANDROID_KEY_ALIAS")');
    expect(first).toContain('System.getenv("ANDROID_KEY_PASSWORD")');
    expect(first).toContain(
      'signingConfig System.getenv("ANDROID_KEYSTORE_PATH") ? signingConfigs.release : signingConfigs.debug',
    );

    const second = await runPlugin(first);
    expect(second).toBe(first);
  });
});
