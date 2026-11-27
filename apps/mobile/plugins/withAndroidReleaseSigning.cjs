const { withAppBuildGradle } = require("expo/config-plugins");

const RELEASE_SIGNING_CONFIG_BLOCK = `
        release {
            def keystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (keystorePath) {
                storeFile file(keystorePath)
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }`;

const RELEASE_SIGNING_ASSIGNMENT =
  'signingConfig System.getenv("ANDROID_KEYSTORE_PATH") ? signingConfigs.release : signingConfigs.debug';

function addReleaseSigningConfig(contents) {
  if (
    contents.includes('System.getenv("ANDROID_KEYSTORE_PATH")') &&
    /signingConfigs\s*\{[\s\S]*?release\s*\{/.test(contents)
  ) {
    return contents;
  }
  const match = /^([ \t]*signingConfigs\s*\{)/m.exec(contents);
  if (!match) {
    throw new Error(
      "withAndroidReleaseSigning: could not find signingConfigs block in android/app/build.gradle.",
    );
  }
  const index = match.index + match[0].length;
  return contents.slice(0, index) + RELEASE_SIGNING_CONFIG_BLOCK + contents.slice(index);
}

function wireReleaseBuildTypeSigning(contents) {
  const buildTypesIndex = contents.indexOf("buildTypes");
  if (buildTypesIndex === -1) {
    throw new Error(
      "withAndroidReleaseSigning: could not find buildTypes block in android/app/build.gradle.",
    );
  }
  const head = contents.slice(0, buildTypesIndex);
  const tail = contents.slice(buildTypesIndex);
  if (tail.includes(RELEASE_SIGNING_ASSIGNMENT)) {
    return contents;
  }
  const releaseBlockMatch = /(release\s*\{[\s\S]*?)(signingConfig\s+signingConfigs\.debug)/.exec(
    tail,
  );
  if (!releaseBlockMatch) {
    throw new Error(
      "withAndroidReleaseSigning: could not find release signingConfig in buildTypes.",
    );
  }
  const updatedTail = tail.replace(
    /(release\s*\{[\s\S]*?)(signingConfig\s+signingConfigs\.debug)/,
    `$1${RELEASE_SIGNING_ASSIGNMENT}`,
  );
  return head + updatedTail;
}

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("withAndroidReleaseSigning: app/build.gradle must use Groovy DSL.");
    }
    let contents = nextConfig.modResults.contents;
    contents = addReleaseSigningConfig(contents);
    contents = wireReleaseBuildTypeSigning(contents);
    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
