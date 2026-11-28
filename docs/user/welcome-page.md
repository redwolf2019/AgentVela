# Welcome page

The Welcome page runs on a fresh local installation to help you verify an agent, optionally import existing projects and conversations, and connect the mobile app. Only one ready agent is required to start.

- Reopen it anytime from **Settings → About → Welcome page → Open**.
- To import more projects later, open **Settings → Projects → Import projects and their threads**. It scans the environment shown there and opens the full project list; pick another environment in Settings to import from it.
- A hosted web UI (`agent-vela-relay` with `serve_web_ui = true`) skips this page: signing in with your relay account shows environments linked to your account.

## Agents

AgentVela lists detected agents first (ready ones on top), followed by **Add more agents** for all other supported providers:

- **Turn on**: Enables a disabled provider and checks its install and sign-in status.
- **Claude Code**: **Install** or **Sign in** opens a setup terminal using the vendor's installer (so **Update now** keeps working in Settings).
- **Codex**: **Set up** offers ChatGPT sign-in or your existing Codex CLI.
- **Outdated or other agents**: **Update** or selecting the agent opens its page in **Settings → Providers**. **Browse** opens the ACP Registry.
- **Desktop CLI**: Click **Add to PATH** if the `t3` command isn't yet on your shell `PATH`.

Click **Start** once at least one agent is ready, or **Start without an agent** to enter the app immediately (checked projects still import).

## Phone

If you build and install the mobile app from source, connect it via **Settings → Sharing & access** using a pairing link or QR code, or sign in to the same self-hosted relay URL (`t3 relay link` on the host) under **Settings → Environments**.

## Projects and conversation import

AgentVela scans directories used by Claude Code, Codex, and Pi (turn on Pi under **Add more agents** to include Pi sessions).

- Git repositories active in the last 30 days with at least three conversations are pre-selected (excluding already-added projects, Codex scratch directories, and `Downloads`). Use **Review all** to customize the selection.
- Conversations active in the last 30 days are imported so you can continue them in AgentVela.

### Import limits

Conversation import is best-effort:

- Keeps the first user prompt and the most recent visible user/assistant messages (up to 200 messages total), omitting tool activity and attachments.
- Skips malformed/empty sessions, files over 4 GiB, sessions over 32 MiB of kept text/metadata, or sessions with over 100,000 records.
- Each import pass reads up to 100 conversations and 4 GiB per project. Reopen the Welcome page and select the project in **Review all** to continue importing a larger batch; already-imported conversations are skipped.
