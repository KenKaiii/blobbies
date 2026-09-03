/** localStorage-backed preferences that degrade to defaults when unavailable. */

import { useState } from "react";

/** Experimental features gated behind a Settings toggle. Off until proven. */
export type LabFlagName = "channels" | "projects" | "workflows";

/** Same `pref:*` key namespace as every other preference. */
const LAB_FLAG_KEYS: Record<LabFlagName, string> = {
  channels: "pref:labs.channels",
  projects: "pref:labs.projects",
  workflows: "pref:labs.workflows",
};

/** Only "on" enables: unset or garbage reads as the default, off. */
export function readLabFlag(name: LabFlagName): boolean {
  return readPreference(LAB_FLAG_KEYS[name], "off") === "on";
}

export function writeLabFlag(name: LabFlagName, on: boolean): void {
  writePreference(LAB_FLAG_KEYS[name], on ? "on" : "off");
}

/** Flag state for routing/panes, persisted on change like every other pref. */
export function useLabFlag(name: LabFlagName): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => readLabFlag(name));
  return [
    on,
    (next: boolean) => {
      setOn(next);
      writeLabFlag(name, next);
    },
  ];
}

export function readPreference(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preferences simply don't persist when storage is unavailable.
  }
}
