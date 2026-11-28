# Updating AgentVela

AgentVela checks and installs updates directly from [`redwolf2019/AgentVela`](https://github.com/redwolf2019/AgentVela/releases) GitHub Releases (or a configured mirror URL). All release surfaces use a single `stable` channel (`vX.Y.Z`) backed by `release-manifest.json` and mandatory SHA-256 verification before install.

## Automatic checks & mirror priority

In packaged/release builds, Desktop, Server, and Android check `release-manifest.json` automatically 15 seconds after startup and every 4 hours afterward (disabled in source/dev runs, under `T3CODE_DISABLE_AUTO_UPDATE=1`, or when `ManagedPolicy` disables updates).

All surfaces pick the release feed base URL in strict fail-closed precedence:

1. Enterprise `ManagedPolicy` (`limits.updates.feedUrl`)
2. `T3CODE_RELEASE_BASE_URL` environment variable
3. Custom **Update mirror** configured in Desktop Settings, Server Settings, or Mobile Settings → About
4. Default: `https://github.com/redwolf2019/AgentVela/releases`

If an override is invalid, update checks stop cleanly with an error rather than falling back to the default origin.

## Before you update

Server restarts disconnect active clients temporarily and can interrupt active agents and terminal commands. Saved threads, settings, and project files remain.

**Settings → Maintenance → Continue threads after restarts** is on by default. It resumes supported active threads after an update, crash, or machine restart. Changes are saved to connected environments that support this setting; update older servers first. If a supported environment was offline or has a different value, use **Apply to all** in Settings after it connects. AgentVela must start again on that machine; the setting does not enable automatic startup.

## Desktop & connected servers

- **Desktop (Linux AppImage / `.deb`, Windows NSIS `.exe`):** Click **Download** then **Install** in the sidebar update pill or **Settings → About**. The updater verifies SHA-256 before launching the platform update installer.
- **Desktop (macOS `darwin-arm64` DMG):** Because macOS builds may be unsigned, AgentVela downloads and SHA-256-verifies `AgentVela-<version>-arm64.dmg` into Downloads and opens it in Finder (**Open Installer**) without quitting active desktop backends. Drag `AgentVela.app` into `/Applications` when ready.
- **CLI & background service (`agentvela`):** Run `agentvela update` (or `agentvela update --version X.Y.Z`) to download, verify `SHA256SUMS`, and install the matching platform archive from the configured release feed.
- **Remote / connected server:** Use **Update server** in the sidebar update pill, **Settings → About**, or Mobile **Settings → Environments**.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update AgentVela on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Run the command on the named host to update the detected install, then restart the server with your usual options.                                                                              |
| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options.                                                                       |

For a server you started by hand, stop it and start it again afterwards with your usual options such as `--host` or `--tailscale-serve`. Only one server can use an AgentVela home directory (`~/.agentvela` by default) at a time.

## Providers

**Settings → Providers** shows provider updates for the selected environment. **Update all** updates every outdated provider on every connected environment at once. After a provider CLI update succeeds, AgentVela refreshes model discovery for enabled instances of that provider. Provider updates do not restart active threads.

## Mobile updates

- **Android (`arm64-v8a` APK):** Open **Settings → About → Updates** to check `release-manifest.json`, download and SHA-256-verify the signed APK, and launch Android's package installer (you will be guided to grant **Install unknown apps** once if needed). You can also configure a custom **Update mirror** there. Android background checks never download APKs automatically.
- **iOS:** Automated GitHub Release updates and Expo OTA are disabled on iOS; update iOS builds from your local Xcode build environment. From **Settings → Environments**, both Android and iOS can check and trigger remote server and provider updates on connected hosts.
