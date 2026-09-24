import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardOsaColorScheme, osaColorSchemeFor } from "./osa-theme";

describe("osaColorSchemeFor", () => {
  it("passes the reader's explicit choice through", () => {
    expect(osaColorSchemeFor("light")).toBe("light");
    expect(osaColorSchemeFor("dark")).toBe("dark");
  });

  it("is auto (follow the device) when the site follows the device", () => {
    // The theme bootstrap and the theme button remove the attribute for "system".
    expect(osaColorSchemeFor(null)).toBe("auto");
    expect(osaColorSchemeFor(undefined)).toBe("auto");
  });

  it("is auto for a value the site never sets, rather than passing it on", () => {
    for (const value of ["system", "", "Dark", "dark "]) {
      expect(osaColorSchemeFor(value)).toBe("auto");
    }
  });
});

describe("forwardOsaColorScheme", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tells a loaded widget that has setColorScheme", () => {
    const received: unknown[] = [];
    const win = { OSAChatWidget: { setColorScheme: (v: unknown) => received.push(v) } };
    expect(forwardOsaColorScheme(win, "dark")).toBe(true);
    expect(received).toEqual(["dark"]);
  });

  it("does nothing before the widget has loaded", () => {
    expect(forwardOsaColorScheme({}, "light")).toBe(false);
  });

  it("does nothing, and does not throw, for a widget without setColorScheme (a pin before OSA #472)", () => {
    expect(forwardOsaColorScheme({ OSAChatWidget: {} }, "light")).toBe(false);
    expect(
      forwardOsaColorScheme({ OSAChatWidget: { setColorScheme: "not-a-function" } }, "light"),
    ).toBe(false);
  });

  it("warns and does not throw when setColorScheme throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const win = {
      OSAChatWidget: {
        setColorScheme: () => {
          throw new Error("widget internals exploded");
        },
      },
    };
    expect(forwardOsaColorScheme(win, "auto")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "[osa-theme] widget's setColorScheme threw:",
      expect.any(Error),
    );
  });
});
