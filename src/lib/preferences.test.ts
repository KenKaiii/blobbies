import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type LabFlagName, readLabFlag, useLabFlag, writeLabFlag } from "@/lib/preferences";

const FLAGS: LabFlagName[] = ["channels", "projects", "workflows"];

describe("lab flags", () => {
  it("defaults every flag to off", () => {
    for (const flag of FLAGS) {
      expect(readLabFlag(flag)).toBe(false);
    }
  });

  it("writes and reads back under the pref: labs keys", () => {
    writeLabFlag("channels", true);
    expect(window.localStorage.getItem("pref:labs.channels")).toBe("on");
    expect(readLabFlag("channels")).toBe(true);

    writeLabFlag("channels", false);
    expect(window.localStorage.getItem("pref:labs.channels")).toBe("off");
    expect(readLabFlag("channels")).toBe(false);
  });

  it('treats anything but "on" as off (validation)', () => {
    window.localStorage.setItem("pref:labs.projects", "yes");
    expect(readLabFlag("projects")).toBe(false);

    window.localStorage.setItem("pref:labs.workflows", "");
    expect(readLabFlag("workflows")).toBe(false);
  });

  it("hydrates useLabFlag from storage and persists toggles", () => {
    window.localStorage.setItem("pref:labs.workflows", "on");
    const { result } = renderHook(() => useLabFlag("workflows"));
    expect(result.current[0]).toBe(true);

    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem("pref:labs.workflows")).toBe("off");

    act(() => result.current[1](true));
    expect(window.localStorage.getItem("pref:labs.workflows")).toBe("on");
  });

  it("starts useLabFlag off when unset", () => {
    const { result } = renderHook(() => useLabFlag("projects"));
    expect(result.current[0]).toBe(false);
  });
});
