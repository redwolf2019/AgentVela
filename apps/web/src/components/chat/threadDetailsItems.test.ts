import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const context = THREAD_DETAILS_ITEMS.find((item) => item.id === "context")!;
const servers = THREAD_DETAILS_ITEMS.find((item) => item.id === "servers")!;

describe("thread details items", () => {
  it.each([
    { items: {}, context: false },
    { items: { context: true, retired: false }, context: true },
  ])("resolves Context from overrides and defaults: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: row.items,
    });
    expect(visibility.context).toBe(row.context);
    expect(visibility.servers).toBe(true);
  });

  it("stores only choices that differ from the default", () => {
    expect(setThreadDetailsItem({ threadDetailsItems: {} }, context, true)).toEqual({
      context: true,
    });
    expect(setThreadDetailsItem({ threadDetailsItems: { context: true } }, context, false)).toEqual(
      {},
    );

    const hidden = { threadDetailsItems: { servers: false } };
    expect(setThreadDetailsItem(hidden, servers, true)).toEqual({});
  });
});
