import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { MCP_APPS } from "./mcpApps";
import { PrimaryAction } from "./UseInAnotherAppDialog";

const { openExternal, writeTextToClipboard } = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => {}),
  writeTextToClipboard: vi.fn(async () => true),
}));

vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal } }),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  namedClipboardTarget: (title: string) => title,
  writeTextToClipboard,
}));

const MCP_URL = "https://relay.example.com/mcp?env=1";

function acquireMocks() {
  openExternal.mockClear();
  writeTextToClipboard.mockClear();
  return {
    [Symbol.dispose]: () => {
      openExternal.mockClear();
      writeTextToClipboard.mockClear();
    },
  };
}

describe("PrimaryAction", () => {
  it("discloses outbound host and requires confirmation for Poke and Claude links", async () => {
    using _mocks = acquireMocks();
    const poke = MCP_APPS.find((app) => app.id === "poke")!;
    const claude = MCP_APPS.find((app) => app.id === "claude")!;
    await using screen = await render(<PrimaryAction key="poke" app={poke} mcpUrl={MCP_URL} />);

    await expect
      .element(page.getByText("Opens poke.com with this server's MCP URL in the link."))
      .toBeVisible();

    await page.getByRole("button", { name: "Open in Poke" }).click();
    expect(openExternal).not.toHaveBeenCalled();

    const alert = page.getByRole("alert");
    await expect.element(alert).toBeVisible();
    await expect
      .element(page.getByText("This sends your server's MCP URL to poke.com. Continue?"))
      .toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(alert).not.toBeInTheDocument();
    expect(openExternal).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Open in Poke" }).click();
    await page.getByRole("button", { name: "Continue to Poke" }).click();
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(
      `https://poke.com/integrations/new?name=T3%20Code&url=${encodeURIComponent(MCP_URL)}`,
    );

    await screen.rerender(<PrimaryAction key="claude" app={claude} mcpUrl={MCP_URL} />);
    await expect
      .element(page.getByText("Opens claude.ai with this server's MCP URL in the link."))
      .toBeVisible();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });

  it("opens copy-url apps directly without extra outbound link confirmation", async () => {
    using _mocks = acquireMocks();
    const chatgpt = MCP_APPS.find((app) => app.id === "chatgpt")!;
    await using _screen = await render(
      <PrimaryAction key="chatgpt" app={chatgpt} mcpUrl={MCP_URL} />,
    );

    await expect
      .element(page.getByText(/with this server's MCP URL in the link/i))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: "Copy URL and open ChatGPT" }).click();
    expect(writeTextToClipboard).toHaveBeenCalledWith(MCP_URL, "URL copied");
    expect(openExternal).toHaveBeenCalledWith("https://chatgpt.com/plugins");
  });
});
