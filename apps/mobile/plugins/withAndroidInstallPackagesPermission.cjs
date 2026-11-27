const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

const INSTALL_PACKAGES_PERMISSION = "android.permission.REQUEST_INSTALL_PACKAGES";

module.exports = function withAndroidInstallPackagesPermission(config) {
  return withAndroidManifest(config, (nextConfig) => {
    AndroidConfig.Permissions.ensurePermission(nextConfig.modResults, INSTALL_PACKAGES_PERMISSION);
    return nextConfig;
  });
};
