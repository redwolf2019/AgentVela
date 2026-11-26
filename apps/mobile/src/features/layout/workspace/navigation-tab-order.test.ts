import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_TAB_ORDER,
  navigationCustomizationAvailable,
  moveNavigationTab,
  overflowNavigationTabs,
  enabledNavigationTabs,
  sharedSlotAbsentee,
  toggleNavigationTabVisibility,
  resolveSelectedNavigationTab,
  resolveNavigationTabOrder,
  selectedNavigationTab,
  visibleNavigationTabs,
} from "./navigation-tab-order";

describe("navigation tab order", () => {
  it("enables customization only above four registered sections, excluding Settings", () => {
    expect(navigationCustomizationAvailable()).toBe(false);
    expect(navigationCustomizationAvailable(3)).toBe(false);
    expect(navigationCustomizationAvailable(4)).toBe(false);
    expect(navigationCustomizationAvailable(5)).toBe(true);
    expect(navigationCustomizationAvailable(6)).toBe(true);
  });

  it("fills missing sections and drops removed placeholders, duplicates, and Settings", () => {
    expect(
      resolveNavigationTabOrder(["issues", "home", "usage", "settings", "issues", null]),
    ).toEqual(["issues", "threads", "pullRequests"]);
    expect(resolveNavigationTabOrder()).toEqual(NAVIGATION_TAB_ORDER);
  });

  it("gives the shared slot to the open list, or else the one opened last", () => {
    expect(sharedSlotAbsentee("issues", "pullRequests")).toBe("pullRequests");
    expect(sharedSlotAbsentee("pullRequests", "issues")).toBe("issues");
    expect(sharedSlotAbsentee("threads", "issues")).toBe("pullRequests");
    expect(sharedSlotAbsentee("threads", undefined)).toBe("issues");
  });

  it("moves a section without changing the relative order of the others", () => {
    for (const tab of NAVIGATION_TAB_ORDER) {
      for (let position = 0; position < NAVIGATION_TAB_ORDER.length; position++) {
        const order = moveNavigationTab(NAVIGATION_TAB_ORDER, tab, position);
        expect(order[position]).toBe(tab);
        expect(order.filter((other) => other !== tab)).toEqual(
          NAVIGATION_TAB_ORDER.filter((other) => other !== tab),
        );
      }
    }
  });

  it("shows every real section without overflow and keeps Settings selected during editing", () => {
    // Pull requests and issues share a place, so the bar is always given one of them as hidden.
    const absent = ["issues"];
    expect(visibleNavigationTabs(undefined, absent)).toEqual(
      NAVIGATION_TAB_ORDER.filter((tab) => tab !== "issues"),
    );
    expect(overflowNavigationTabs(undefined, absent)).toEqual([]);
    expect(selectedNavigationTab(undefined, "threads", true)).toBe("settings");
    expect(selectedNavigationTab(undefined, "pullRequests", false, absent)).toBe("pullRequests");
    expect(selectedNavigationTab(undefined, "pullRequests", false, absent, 1)).toBe("settings");
  });

  it("removes hidden sections from navigation and restores their saved positions", () => {
    const order = moveNavigationTab(undefined, "issues", 0);
    const hidden = toggleNavigationTabVisibility([], "issues");
    expect(enabledNavigationTabs(order, hidden)).toEqual(["threads", "pullRequests"]);
    expect(toggleNavigationTabVisibility(hidden, "issues")).toEqual([]);
    expect(visibleNavigationTabs(order, [], 5)).toEqual(order);
    expect(enabledNavigationTabs(undefined, ["home", "inbox", "settings"])).toEqual(
      NAVIGATION_TAB_ORDER,
    );
  });

  it("falls back when the selected section is hidden, including when all are hidden", () => {
    expect(resolveSelectedNavigationTab(undefined, ["threads"], "threads")).toBe("pullRequests");
    expect(resolveSelectedNavigationTab(undefined, ["threads"], "pullRequests")).toBe(
      "pullRequests",
    );
    expect(
      resolveSelectedNavigationTab(undefined, NAVIGATION_TAB_ORDER, "threads"),
    ).toBeUndefined();
  });
});
