# Updating AgentVela

> Prebuilt desktop, CLI, and store release channels are not published yet for AgentVela. For installations built from source, pull new commits (`git pull`), run `vp i`, and restart or rebuild the app. The behavior below documents version-compatibility checks, restart recovery, and provider CLI updates across connected environments.

The app you use and the server running your agents can be on different machines. When a server is behind your web or desktop app, the update controls at the bottom of the sidebar and **Settings → Environments** coordinate updates when release channels are configured.

## Before you update

Server restarts disconnect active clients temporarily and can interrupt active agents and terminal commands. Saved threads, settings, and project files remain.

**Settings → Maintenance → Continue threads after restarts** is on by default. It resumes supported active threads after an update, crash, or machine restart. Changes are saved to connected environments that support this setting; update older servers first. If a supported environment was offline or has a different value, use **Apply to all** in Settings after it connects. AgentVela must start again on that machine; the setting does not enable automatic startup. Terminal commands may still be interrupted, and threads without saved provider resume state need a new message.

A thread that finished its turn to wait on a subagent, a background task, a Claude monitor or `sleep` timer, or a command or other monitor the agent said it was waiting on is woken and told that this work stopped. Other background shells and monitors, such as a dev server and its watchdog, do not wake it; the thread learns about them with your next message. A thread is not resumed while it waits for your approval, answer, or secret, or while it is archived, snoozed, or settled. After three consecutive crash recoveries of an unfinished turn, the thread waits for your next message, even when crashes are more than five minutes apart. A completed turn or a planned shutdown resets that limit.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry every kind of runtime history forward. Read [Threads from older versions](./thread-migration.md) before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update AgentVela on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

When running from source, pull the matching commit on that machine (`git pull && vp i`) and rebuild or restart the server process.

When running an installed service or CLI build:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Run the command on the named host to update the detected install, then restart the server with your usual options.                                                                              |
| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options.                                                                       |

For a server you started by hand, stop it and start it again afterwards with your usual options such as `--host` or `--tailscale-serve`.

Only one server can use an AgentVela home directory (`~/.t3` by default) at a time. If startup reports that another server owns it, stop that server before retrying, or use a separate `--base-dir` and pair with the running server.

## If the desktop app does not start

If the desktop app's server keeps failing at startup, AgentVela shows a startup error window instead of the app. Use **Copy details** to include the redacted error in a bug report.

## Registries and proxies

Each server checks providers installed with npm through its own npm, so the checks use npm's configured registry, authentication, and proxy settings. Providers installed with Homebrew or pnpm check through those tools. Configure npm on the server's machine if needed.

## Update providers

**Settings → Providers** shows provider updates for the selected environment. **Update all** updates every outdated provider on every connected environment at once. Hover it to see which providers it will update. A provider is left out when any of its enabled, outdated instances offers only a manual update command, or when its instances use different update commands, such as two instances that run different CLI installs. Update those by hand, or point every instance of the provider at the same CLI.

After a successful provider CLI update, AgentVela refreshes model discovery for every enabled instance of that provider using its own configuration. Connected clients receive the refreshed catalogs automatically. Provider update checks must be enabled to download updated model catalogs.

Provider updates do not restart running chats. An existing session can keep using the previous CLI until it ends. If discovery fails, check the provider status and refresh it again.

## Mobile updates

When running mobile builds from source, rebuild or pull matching OTA bundles from your own build environment. From **Settings → Environments** on mobile, you can still refresh provider status and trigger supported provider CLI updates on any connected environment where you hold permission to operate it.
