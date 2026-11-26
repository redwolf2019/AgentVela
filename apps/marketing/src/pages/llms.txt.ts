import type { APIRoute } from "astro";

import { ANDROID_PLAY_STORE_URL, GITHUB_REPOSITORY_URL, IOS_APP_STORE_URL } from "../lib/site";
import { absoluteUrl, SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index that tells AI agents which domain and links are official.
export const GET: APIRoute = () => {
  const body = `# AgentVela

> ${SITE_TAGLINE}. AgentVela is free and MIT-licensed. It runs Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, and other coding agents from one desktop, web, and mobile app.

Official builds come from ${GITHUB_REPOSITORY_URL}/releases and the repository source at ${GITHUB_REPOSITORY_URL}.

## Official links

- [Download AgentVela](${absoluteUrl("/download")}): macOS, Windows, and Linux installers
- [Source code](${GITHUB_REPOSITORY_URL}): the MIT-licensed repository
- [Releases](${GITHUB_REPOSITORY_URL}/releases): release builds and changelogs
- [iOS app](${IOS_APP_STORE_URL})
- [Android app](${ANDROID_PLAY_STORE_URL})

## Policies

- [Security policy](${GITHUB_REPOSITORY_URL}/blob/main/SECURITY.md)
- [Privacy policy](${absoluteUrl("/privacy-policy")})
- [Terms of service](${absoluteUrl("/terms-of-service")})
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
