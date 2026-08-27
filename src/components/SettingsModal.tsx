import { CircleArrowDown, Cpu, Plug, Settings, X } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "@/components/ExternalLink";
import { PillSelect } from "@/components/PillSelect";
import { COMPOSIO_DASHBOARD_URL, composioSignedIn, forgetComposioSession } from "@/lib/composio";
import { composioLogIn, composioSignOut } from "@/lib/composio-oauth";
import { ffmpegPresent } from "@/lib/media";
import {
  getOllamaVersion,
  isOllamaInstalled,
  listOllamaModels,
  type OllamaModel,
  startOllama,
} from "@/lib/ollama";
import type { LabFlagName } from "@/lib/preferences";
import { deleteSecret, setSecret } from "@/lib/secrets";
import { listSkills, type Skill } from "@/lib/skills";
import { isTauri, openExternal } from "@/lib/tauri";
// Tinfoil's real module (attestation stack) is a lazy chunk: only the pure
// id helpers are imported statically; handlers `import()` the rest on use.
import type { TinfoilModel } from "@/lib/tinfoil";
import { isTinfoilModel, TINFOIL_MODEL_PREFIX } from "@/lib/tinfoil-model";
import {
  simulateUpdate,
  type UpdateState,
  updateActionLabel,
  updateClickAction,
  useUpdateState,
} from "@/lib/updater";
import { useExitAnimation } from "@/lib/useExitAnimation";

export const MAX_USER_NAME_LENGTH = 32;

export type ThemePreference = "system" | "light" | "dark";

/** The Updates tab status line under the version. One sentence per phase; the
 *  button beside it carries the action. */
function updateBlurb(update: UpdateState): string {
  switch (update.phase) {
    case "checking":
      return "Checking GitHub Releases…";
    case "up-to-date":
      return `Up to date (checked ${new Date(update.checkedAt).toLocaleTimeString()})`;
    case "available":
      return `Blobbies ${update.version} is ready to download.`;
    case "downloading":
      return `Downloading ${update.version}, ${update.percent}%`;
    case "ready":
      return `${update.version} downloaded. Install and restart when you are ready.`;
    case "installing":
      return `Installing ${update.version}…`;
    case "failed":
      return update.message;
    default:
      return "Updates arrive through GitHub Releases.";
  }
}

/** The dialog's tabs; also what the search palette can jump straight to. */
export type SettingsTab = "general" | "model" | "plugins" | "updates";

/** One row per lab flag: title for the toggle, blurb under it. */
const LAB_FLAG_META: { name: LabFlagName; title: string; blurb: string }[] = [
  {
    name: "channels",
    title: "Channels",
    blurb: "Channels: Slack-style rooms for your Blobs.",
  },
  {
    name: "projects",
    title: "Projects",
    blurb: "Projects: Kanban-lite task boards.",
  },
  {
    name: "workflows",
    title: "Workflows",
    blurb: "Workflows: multi-step automations.",
  },
];

interface SettingsModalProps {
  /** Tab to open on, for callers that jump to one. Defaults to General. */
  initialTab?: SettingsTab;
  userName: string;
  onUserNameChange: (name: string) => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  /** In-app sound effects (turn-end chime); default on. */
  sounds: boolean;
  onSoundsChange: (on: boolean) => void;
  timezone: string;
  onTimezoneChange: (timezone: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  /** Lab feature flags; off by default, toggled in the Labs section. */
  labFlags: Record<LabFlagName, boolean>;
  onLabFlagChange: (name: LabFlagName, on: boolean) => void;
  /** Dev action: replay the first-run flow once, right now. */
  onReplayOnboarding: () => void;
  /** The Editors (ACP) section, rendered under Plugins by the app. */
  acp: ReactNode;
  onClose: () => void;
}

/** What the Model tab knows about the local Ollama install right now. */
type OllamaStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "not-installed" }
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "start-failed" }
  | { kind: "running"; version: string; models: OllamaModel[] };

/** Status-dot tone per Ollama state. */
const OLLAMA_DOT_TONE: Record<OllamaStatus["kind"], "wait" | "err" | "warn" | "ok"> = {
  idle: "wait",
  checking: "wait",
  "not-installed": "err",
  stopped: "warn",
  starting: "wait",
  "start-failed": "err",
  running: "ok",
};

function ollamaBlurb(status: OllamaStatus): string {
  switch (status.kind) {
    case "idle":
    case "checking":
      return "Checking your local Ollama\u2026";
    case "not-installed":
      return "Not found on this machine. Blobbies runs models locally through Ollama, so nothing ever leaves your device.";
    case "stopped":
      return "Installed, but not running.";
    case "starting":
      return "Starting Ollama\u2026";
    case "start-failed":
      return "Couldn't start Ollama. Try opening the Ollama app yourself, then re-check.";
    case "running": {
      const count = status.models.length;
      return `Running v${status.version} \u00b7 ${count} ${count === 1 ? "model" : "models"} downloaded`;
    }
  }
}

function modelBlurb(status: OllamaStatus, tinfoilReady: boolean): string {
  if (status.kind === "running") {
    return status.models.length === 0
      ? "No models downloaded yet. Run `ollama pull gemma3`, then re-check."
      : "Your Blobs think with this model. Everything stays on your device.";
  }
  return tinfoilReady
    ? "Tinfoil models stay available while Ollama is off; local models return once it's running."
    : "Available once Ollama is installed and running.";
}

/** What the Model tab knows about the Tinfoil account right now. */
type TinfoilStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "configured"; models: TinfoilModel[] };

const TINFOIL_DOT_TONE: Record<TinfoilStatus["kind"], "wait" | "err" | "warn" | "ok"> = {
  idle: "wait",
  checking: "wait",
  none: "warn",
  configured: "ok",
};

function tinfoilBlurb(status: TinfoilStatus): string {
  switch (status.kind) {
    case "idle":
    case "checking":
      return "Checking for a saved Tinfoil key…";
    case "none":
      // Kept short so every state renders on one line: the row height must
      // not change when the save flips the status (and unmounts the link).
      return "Private cloud models in secure enclaves.";
    case "configured": {
      const count = status.models.length;
      return `API key saved · ${count} ${count === 1 ? "model" : "models"} available`;
    }
  }
}

/**
 * What the Plugins tab knows about Composio.
 *
 * Install and sign-in are tracked as one sequence rather than two flags: a
 * login is meaningless without the binary, and the pair would allow states
 * that cannot exist. `waiting` is the one that has to be visible — the
 * browser is open and this app is polling for up to ten minutes.
 */
/**
 * Composio is reached over its hosted MCP endpoint, so this is a key rather
 * than an installed binary plus a browser login. The CLI it replaced shipped
 * for macOS and Linux only, which left Windows with no way to finish setup.
 */
type ComposioStatus = {
  stage: "idle" | "checking" | "needsKey" | "verifying" | "signedIn";
  version: string;
  /** Empty unless something failed; shown verbatim. */
  error: string;
  installable: boolean;
};

const COMPOSIO_IDLE: ComposioStatus = {
  stage: "idle",
  version: "",
  error: "",
  installable: true,
};

/** Status-dot tone for the Composio row. */
function composioTone(status: ComposioStatus): "wait" | "err" | "warn" | "ok" {
  if (status.stage === "needsKey" || status.error !== "") {
    return "err";
  }
  if (status.stage === "signedIn") {
    return "ok";
  }
  // Everything left is a probe in flight; "needs a key" is handled above as a
  // warning, since it is the state a person has to act on.
  return "wait";
}

/**
 * What a pasted key must look like: one run of key characters, nothing else.
 *
 * Catches the mistakes a paste actually makes — wrapping quotes, a trailing
 * newline, `COMPOSIO_API_KEY=` copied along with the value, half a key. It
 * does not claim the key works; the handshake after saving does that.
 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;

function composioBlurb(status: ComposioStatus): string {
  if (status.error !== "") {
    return status.error;
  }
  switch (status.stage) {
    case "idle":
    case "checking":
      return "Checking\u2026";
    case "verifying":
      // Covers both routes in: a browser sign-in in flight and a pasted key
      // being checked. Naming only one would read as a stall for the other.
      return "Waiting for Composio\u2026";
    case "needsKey":
      // Names the primary action, which is the button beside it. Telling
      // people to paste a key while a Log in button sits next to the sentence
      // sends them to the fallback first.
      return "Log in to connect your apps.";
    case "signedIn":
      return "Connected. Your apps can connect now.";
  }
}

/**
 * Ask Composio whether the stored key works.
 *
 * A real handshake rather than a "is a key present" check: a revoked key is
 * indistinguishable from a good one until it is used, and this panel is where
 * someone comes to find out why their apps stopped working.
 */
async function probeComposio(
  setStatus: (update: (current: ComposioStatus) => ComposioStatus) => void,
): Promise<void> {
  setStatus((current) => ({ ...current, stage: "checking", error: "" }));
  const signedIn = await composioSignedIn();
  setStatus((current) => ({
    ...current,
    stage: signedIn ? "signedIn" : "needsKey",
    installable: true,
  }));
}

/** Check the keychain for a Tinfoil key and load the model catalog. */
async function probeTinfoil(
  setStatus: (status: TinfoilStatus) => void,
  force = false,
): Promise<void> {
  setStatus({ kind: "checking" });
  const tinfoil = await import("@/lib/tinfoil");
  if (await tinfoil.configureTinfoilFromKeychain(force)) {
    setStatus({ kind: "configured", models: await tinfoil.listTinfoilModels() });
    return;
  }
  setStatus({ kind: "none" });
}

/** Probe the local Ollama install/server and report the result. */
async function probeOllama(setStatus: (status: OllamaStatus) => void): Promise<void> {
  setStatus({ kind: "checking" });
  const version = await getOllamaVersion();
  if (version !== null) {
    setStatus({ kind: "running", version, models: await listOllamaModels() });
    return;
  }
  setStatus((await isOllamaInstalled()) ? { kind: "stopped" } : { kind: "not-installed" });
}

/** Settings dialog: General (account, appearance, agent), Model, and Updates tabs. */
export function SettingsModal({
  initialTab = "general",
  userName,
  onUserNameChange,
  theme,
  onThemeChange,
  sounds,
  onSoundsChange,
  timezone,
  onTimezoneChange,
  model,
  onModelChange,
  labFlags,
  onLabFlagChange,
  onReplayOnboarding,
  acp,
  onClose,
}: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  // The version row reads the running app, not a constant: a hardcoded string
  // here silently went stale across releases (showed 0.1.2 in 0.1.4). Null in
  // a plain browser or tests, where there is no bundle to ask.
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    void import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => {
        // Leaving null shows "Blobbies" alone — the Updates status line
        // below still says whether this build is current.
      });
  }, []);
  const update = useUpdateState();
  const [ollama, setOllama] = useState<OllamaStatus>({ kind: "idle" });
  const [tinfoil, setTinfoil] = useState<TinfoilStatus>({ kind: "idle" });
  const [tinfoilKeyDraft, setTinfoilKeyDraft] = useState("");
  const [composioKeyDraft, setComposioKeyDraft] = useState("");
  const [composio, setComposio] = useState<ComposioStatus>(COMPOSIO_IDLE);
  const [skills, setSkills] = useState<Skill[]>([]);
  // `undefined` until probed, so the row can say "checking" rather than
  // claiming ffmpeg is missing before it has looked.
  const [ffmpeg, setFfmpeg] = useState<boolean | undefined>(undefined);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { closing, requestClose, finishClose } = useExitAnimation(onClose);

  // Probe lazily: only once the Model tab is first opened.
  useEffect(() => {
    if (tab === "model" && ollama.kind === "idle") {
      void probeOllama(setOllama);
    }
    if (tab === "model" && tinfoil.kind === "idle") {
      void probeTinfoil(setTinfoil);
    }
    if (tab === "model" && ffmpeg === undefined) {
      void ffmpegPresent().then(setFfmpeg);
    }
    if (tab === "plugins" && composio.stage === "idle") {
      void probeComposio(setComposio);
      // Read here rather than from App's copy: this tab is where a user looks
      // after adding a folder, so it should reflect the disk, not the list
      // captured at startup.
      void listSkills().then(setSkills);
    }
  }, [tab, ollama.kind, tinfoil.kind, composio.stage, ffmpeg]);

  const availableModels = ollama.kind === "running" ? ollama.models : [];
  const tinfoilModels = tinfoil.kind === "configured" ? tinfoil.models : [];

  const saveTinfoilKey = async () => {
    const key = tinfoilKeyDraft.trim();
    if (key === "") {
      return;
    }
    await setSecret("tinfoil-api-key", key);
    setTinfoilKeyDraft("");
    // Force: the session probe may have cached "no key" before this save.
    await probeTinfoil(setTinfoil, true);
  };

  /**
   * Store the key, then prove it works before showing "Connected".
   *
   * Saving alone would report success for a mistyped key and fail later
   * inside a Blob's turn, where the person cannot see the cause. One
   * handshake here puts the error on the screen that can fix it.
   */
  /**
   * Browser sign-in: the path most people should take.
   *
   * Preferred over the key because it asks nothing of the user beyond a
   * click, and because the token it stores expires and refreshes rather than
   * sitting in a dashboard forever.
   */
  const logIn = async () => {
    setComposio((current) => ({ ...current, stage: "verifying", error: "" }));
    try {
      await composioLogIn(openExternal);
      forgetComposioSession();
      await probeComposio(setComposio);
    } catch (error) {
      setComposio((current) => ({
        ...current,
        stage: "needsKey",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const signOutComposio = async () => {
    await composioSignOut();
    forgetComposioSession();
    await probeComposio(setComposio);
  };

  const saveComposioKey = async () => {
    const key = composioKeyDraft.trim();
    if (!KEY_PATTERN.test(key)) {
      setComposio((current) => ({
        ...current,
        error: "That does not look like a Composio key.",
      }));
      return;
    }
    setComposio((current) => ({ ...current, stage: "verifying", error: "" }));
    try {
      await setSecret("composio-api-key", key);
      // The transport caches a session bound to the old credential.
      forgetComposioSession();
      setComposioKeyDraft("");
      await probeComposio(setComposio);
    } catch (error) {
      setComposio((current) => ({
        ...current,
        stage: "needsKey",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const removeTinfoilKey = async () => {
    await deleteSecret("tinfoil-api-key");
    // Refresh the session probe so pickers stop offering Tinfoil models.
    // Awaited before the clear below: an in-flight probe must not land after.
    const tinfoil = await import("@/lib/tinfoil");
    await tinfoil.configureTinfoilFromKeychain(true);
    tinfoil.configureTinfoil({ apiKey: null });
    setTinfoil({ kind: "none" });
    // A selected Tinfoil model is unusable without the key: back to unset.
    if (isTinfoilModel(model)) {
      onModelChange("");
    }
  };

  const turnOnOllama = async () => {
    setOllama({ kind: "starting" });
    if (await startOllama()) {
      await probeOllama(setOllama);
      return;
    }
    setOllama({ kind: "start-failed" });
  };

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Built once per open; ~400 entries with their current local time.
  const zones = useMemo(() => {
    const names =
      typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    const now = new Date();
    return names.map((zone) => {
      let time = "";
      try {
        time = new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: zone,
        }).format(now);
      } catch {
        // Skip the time preview for zones the runtime can't format.
      }
      return { zone, time };
    });
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      requestClose();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss mirrors the Escape path
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the dialog itself
    <div
      className={closing ? "modal-backdrop modal-backdrop-closing" : "modal-backdrop"}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
      onAnimationEnd={(event) => {
        // Wait for the backdrop's own fade-out, not bubbled child animations.
        if (closing && event.target === event.currentTarget) {
          finishClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={closing ? "settings-modal settings-modal-closing" : "settings-modal"}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <nav className="modal-rail" aria-label="Settings sections">
          <button
            type="button"
            className={tab === "general" ? "rail-item rail-item-active" : "rail-item"}
            aria-current={tab === "general" ? "true" : undefined}
            onClick={() => setTab("general")}
          >
            <Settings size={15} strokeWidth={1.8} aria-hidden="true" />
            General
          </button>
          <button
            type="button"
            className={tab === "model" ? "rail-item rail-item-active" : "rail-item"}
            aria-current={tab === "model" ? "true" : undefined}
            onClick={() => setTab("model")}
          >
            <Cpu size={15} strokeWidth={1.8} aria-hidden="true" />
            Model
          </button>
          <button
            type="button"
            className={tab === "plugins" ? "rail-item rail-item-active" : "rail-item"}
            aria-current={tab === "plugins" ? "true" : undefined}
            onClick={() => setTab("plugins")}
          >
            <Plug size={15} strokeWidth={1.8} aria-hidden="true" />
            Plugins
          </button>
          <button
            type="button"
            className={tab === "updates" ? "rail-item rail-item-active" : "rail-item"}
            aria-current={tab === "updates" ? "true" : undefined}
            onClick={() => setTab("updates")}
          >
            <CircleArrowDown size={15} strokeWidth={1.8} aria-hidden="true" />
            Updates
          </button>
        </nav>

        <div className="modal-content">
          <button
            type="button"
            className="icon-button modal-close"
            aria-label="Close settings"
            onClick={requestClose}
          >
            <X size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>

          {tab === "general" ? (
            <>
              <h2 className="modal-title">General</h2>

              <p className="modal-section-label">Account</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <label className="modal-row-title" htmlFor="account-name">
                      Name
                    </label>
                    <span className="modal-row-blurb">Your Blobs use this to address you.</span>
                  </span>
                  <span className="modal-name-wrap">
                    <input
                      id="account-name"
                      type="text"
                      className="modal-name-input"
                      maxLength={MAX_USER_NAME_LENGTH}
                      value={userName}
                      onChange={(event) => onUserNameChange(event.currentTarget.value)}
                    />
                    {userName.length >= MAX_USER_NAME_LENGTH - 6 ? (
                      <span className="modal-count" aria-live="polite">
                        {userName.length}/{MAX_USER_NAME_LENGTH}
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>

              <p className="modal-section-label">Appearance</p>
              <div className="modal-card">
                <div className="modal-row">
                  <span className="modal-row-label">Theme</span>
                  <PillSelect
                    id="theme-select"
                    label="Theme"
                    value={theme}
                    onChange={(value) => onThemeChange(value as ThemePreference)}
                  >
                    <option value="system">Follow System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </PillSelect>
                </div>
              </div>

              <p className="modal-section-label">Agent</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <label className="modal-row-title" htmlFor="timezone-select">
                      Timezone
                    </label>
                    <span className="modal-row-blurb">
                      Your Blobs schedule and time-stamp things in this timezone.
                    </span>
                  </span>
                  <PillSelect
                    id="timezone-select"
                    label="Timezone"
                    value={timezone}
                    onChange={onTimezoneChange}
                  >
                    <option value="auto">{`Auto-detect (${detectedZone})`}</option>
                    {zones.map(({ zone, time }) => (
                      <option key={zone} value={zone}>
                        {time.length > 0 ? `${zone}  ${time}` : zone}
                      </option>
                    ))}
                  </PillSelect>
                </div>
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <label className="modal-row-title" htmlFor="sounds-toggle">
                      Sounds
                    </label>
                    <span className="modal-row-blurb">
                      Play a chime when a Blob finishes its work. The notification banner's own
                      sound is controlled by macOS in System Settings.
                    </span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={sounds}
                    id="sounds-toggle"
                    className={sounds ? "toggle toggle-on" : "toggle"}
                    onClick={() => onSoundsChange(!sounds)}
                  >
                    <span className="toggle-knob" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <p className="modal-section-label">Developer</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title">Onboarding</span>
                    <span className="modal-row-blurb">
                      Replay the first-run flow once, right now. Future launches are unaffected.
                    </span>
                  </span>
                  <button type="button" className="modal-button" onClick={onReplayOnboarding}>
                    Replay
                  </button>
                </div>
              </div>

              <p className="modal-section-label">Labs</p>
              <div className="modal-card">
                {LAB_FLAG_META.map((flag, position) => (
                  <Fragment key={flag.name}>
                    {position === 0 ? null : <div className="modal-divider" />}
                    <div className="modal-row modal-row-multiline">
                      <span className="modal-row-text">
                        <label className="modal-row-title" htmlFor={`labs-${flag.name}-toggle`}>
                          {flag.title}
                        </label>
                        <span className="modal-row-blurb">{flag.blurb}</span>
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={labFlags[flag.name]}
                        id={`labs-${flag.name}-toggle`}
                        className={labFlags[flag.name] ? "toggle toggle-on" : "toggle"}
                        onClick={() => onLabFlagChange(flag.name, !labFlags[flag.name])}
                      >
                        <span className="toggle-knob" aria-hidden="true" />
                      </button>
                    </div>
                  </Fragment>
                ))}
                <div className="modal-divider" />
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-blurb">
                      Turning a lab off only hides its UI — anything you made stays on disk and
                      comes back when you turn it on again.
                    </span>
                  </span>
                </div>
              </div>
            </>
          ) : null}

          {tab === "plugins" ? (
            <>
              <h2 className="modal-title">Plugins</h2>

              <p className="modal-section-label">Composio</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title ollama-title">
                      <span
                        className={`ollama-dot ollama-dot-${composioTone(composio)}`}
                        aria-hidden="true"
                      />
                      Composio
                    </span>
                    <span className="modal-row-blurb" aria-live="polite">
                      {composioBlurb(composio)}
                    </span>
                  </span>
                  {composio.stage === "signedIn" ? (
                    <button
                      type="button"
                      className="modal-button"
                      onClick={() => void signOutComposio()}
                    >
                      Sign out
                    </button>
                  ) : composio.stage === "needsKey" ? (
                    <button type="button" className="modal-button" onClick={() => void logIn()}>
                      Log in
                    </button>
                  ) : (
                    <button type="button" className="modal-button" disabled>
                      {"Checking\u2026"}
                    </button>
                  )}
                </div>
                {composio.stage === "needsKey" ? (
                  <>
                    {/* Same shape as the Tinfoil key below: a divider, a
                        labelled stack, then the input and its button on one
                        `modal-field-row`. The hand-rolled row this replaced
                        used a class with no CSS behind it, so the button sat
                        flush against the input. */}
                    <div className="modal-divider" />
                    <div className="modal-stack">
                      <span className="modal-row-title" id="composio-key-label">
                        Or paste an API key
                      </span>
                      <span className="modal-row-blurb">
                        Only if the browser sign-in cannot finish.{" "}
                        <ExternalLink href={COMPOSIO_DASHBOARD_URL}>Get a key</ExternalLink>
                      </span>
                      <div className="modal-field-row">
                        <input
                          id="composio-key"
                          type="password"
                          className="modal-name-input"
                          autoComplete="off"
                          aria-labelledby="composio-key-label"
                          placeholder="Paste your API key"
                          value={composioKeyDraft}
                          onChange={(event) => setComposioKeyDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void saveComposioKey();
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="modal-button"
                          disabled={composioKeyDraft.trim() === ""}
                          onClick={() => void saveComposioKey()}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  </>
                ) : null}
              </div>

              {acp}

              <p className="modal-section-label">Skills</p>
              <div className="modal-card">
                {skills.length === 0 ? (
                  <div className="modal-row modal-row-multiline">
                    <span className="modal-row-text">
                      <span className="modal-row-blurb">
                        No skills yet. Add one in <code>~/.blobbies/skills</code>.
                      </span>
                    </span>
                  </div>
                ) : (
                  skills.map((skill, position) => (
                    <Fragment key={skill.name}>
                      {position === 0 ? null : <div className="modal-divider" />}
                      {/* Name only: this list answers "what is installed",
                          while a description answers "when should the model
                          use this". Showing it here buys a wall of text or an
                          ellipsis — and an ellipsis is the truncation refused
                          everywhere else. It stays whole in the file. */}
                      <div className="modal-row">
                        <span className="modal-row-title">{skill.name}</span>
                      </div>
                    </Fragment>
                  ))
                )}
              </div>
            </>
          ) : null}

          {tab === "model" ? (
            <>
              <h2 className="modal-title">Model</h2>

              <p className="modal-section-label">Ollama</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title ollama-title">
                      <span
                        className={`ollama-dot ollama-dot-${OLLAMA_DOT_TONE[ollama.kind]}`}
                        aria-hidden="true"
                      />
                      Ollama
                    </span>
                    <span className="modal-row-blurb" aria-live="polite">
                      {ollamaBlurb(ollama)}
                    </span>
                  </span>
                  {ollama.kind === "not-installed" ? (
                    <ExternalLink href="https://ollama.com/download" className="modal-button">
                      Get Ollama
                    </ExternalLink>
                  ) : ollama.kind === "stopped" ||
                    ollama.kind === "start-failed" ||
                    ollama.kind === "starting" ? (
                    <button
                      type="button"
                      className="modal-button"
                      disabled={ollama.kind === "starting"}
                      onClick={() => void turnOnOllama()}
                    >
                      {ollama.kind === "starting" ? "Starting\u2026" : "Turn On"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="modal-button"
                      disabled={ollama.kind !== "running"}
                      onClick={() => void probeOllama(setOllama)}
                    >
                      Re-check
                    </button>
                  )}
                </div>
              </div>

              {/* Not a model, but the same question the tabs above answer:
                  what can this machine actually do? A Blob's media tools are
                  hidden entirely without ffmpeg, so this is the only place
                  that says why they are missing. */}
              <p className="modal-section-label">Media</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title ollama-title">
                      <span
                        className={`ollama-dot ollama-dot-${ffmpeg === true ? "ok" : "warn"}`}
                        aria-hidden="true"
                      />
                      ffmpeg
                    </span>
                    <span className="modal-row-blurb" aria-live="polite">
                      {ffmpeg === undefined
                        ? "Checking…"
                        : ffmpeg
                          ? "Found. Your Blobs can describe, trim and pull the audio out of media files in their own folders."
                          : "Not found, so those tools are hidden. Install it with `brew install ffmpeg`, then re-check."}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="modal-button"
                    onClick={() => void ffmpegPresent().then(setFfmpeg)}
                  >
                    Re-check
                  </button>
                </div>
              </div>

              <p className="modal-section-label">Tinfoil</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title ollama-title">
                      <span
                        className={`ollama-dot ollama-dot-${TINFOIL_DOT_TONE[tinfoil.kind]}`}
                        aria-hidden="true"
                      />
                      Tinfoil
                    </span>
                    <span className="modal-row-blurb" aria-live="polite">
                      {tinfoilBlurb(tinfoil)}{" "}
                      {tinfoil.kind === "none" ? (
                        <ExternalLink href="https://docs.tinfoil.sh/get-api-key">
                          Get a key
                        </ExternalLink>
                      ) : null}
                    </span>
                  </span>
                </div>
                {/* The key section always renders — only its contents swap.
                    Unmounting it on save removed ~90px from the card and threw
                    every section below it up the page, which reads as the
                    dialog flinching at the moment the user succeeded. */}
                <div className="modal-divider" />
                <div className="modal-stack">
                  <span className="modal-row-title" id="tinfoil-key-label">
                    API key
                  </span>
                  <div className="modal-field-row">
                    {tinfoil.kind === "configured" ? (
                      <>
                        <span className="modal-name-input modal-name-input-static">
                          {"\u2022".repeat(24)}
                        </span>
                        <button
                          type="button"
                          className="modal-button"
                          onClick={() => void removeTinfoilKey()}
                        >
                          Remove Key
                        </button>
                      </>
                    ) : (
                      <>
                        <input
                          id="tinfoil-key"
                          type="password"
                          className="modal-name-input"
                          autoComplete="off"
                          aria-labelledby="tinfoil-key-label"
                          placeholder="Paste your API key"
                          value={tinfoilKeyDraft}
                          onChange={(event) => setTinfoilKeyDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void saveTinfoilKey();
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="modal-button"
                          disabled={tinfoilKeyDraft.trim() === ""}
                          onClick={() => void saveTinfoilKey()}
                        >
                          Save
                        </button>
                      </>
                    )}
                  </div>
                  <span className="modal-row-blurb">
                    Stored in your OS keychain, never in app files.
                  </span>
                </div>
              </div>

              <p className="modal-section-label">Model</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <label className="modal-row-title" htmlFor="model-select">
                      Chat model
                    </label>
                    <span className="modal-row-blurb">
                      {modelBlurb(ollama, tinfoilModels.length > 0)}
                    </span>
                  </span>
                  <PillSelect
                    id="model-select"
                    label="Chat model"
                    value={model}
                    onChange={onModelChange}
                  >
                    <option value="">Choose a model</option>
                    {model !== "" &&
                    !isTinfoilModel(model) &&
                    !availableModels.some((entry) => entry.name === model) ? (
                      <option value={model}>{`${model} (not downloaded)`}</option>
                    ) : null}
                    {availableModels.length > 0 ? (
                      <optgroup label="Ollama — local">
                        {availableModels.map((entry) => (
                          <option key={entry.name} value={entry.name}>
                            {entry.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    {tinfoilModels.length > 0 ? (
                      <optgroup label="Tinfoil — private cloud">
                        {tinfoilModels.map((entry) => (
                          <option key={entry.id} value={`${TINFOIL_MODEL_PREFIX}${entry.id}`}>
                            {entry.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </PillSelect>
                </div>
              </div>
            </>
          ) : null}

          {tab === "updates" ? (
            <>
              <h2 className="modal-title">Updates</h2>

              <p className="modal-section-label">Updates</p>
              <div className="modal-card">
                <div className="modal-row modal-row-multiline">
                  <span className="modal-row-text">
                    <span className="modal-row-title">
                      {appVersion === null ? "Blobbies" : `Blobbies ${appVersion}`}
                    </span>
                    <span className="modal-row-blurb">{updateBlurb(update)}</span>
                  </span>
                  {import.meta.env.DEV ? (
                    <button
                      type="button"
                      className="modal-button"
                      onClick={() => void simulateUpdate()}
                    >
                      Simulate Update
                    </button>
                  ) : null}
                  {/* One control through the whole flow, same as the sidebar
                      card and driven by the same state: check, download,
                      install and restart. Nobody should have to go hunting in
                      the sidebar to finish an update they started here. */}
                  <button
                    type="button"
                    className="modal-button"
                    disabled={
                      update.phase === "checking" ||
                      update.phase === "downloading" ||
                      update.phase === "installing"
                    }
                    onClick={updateClickAction}
                  >
                    {updateActionLabel(
                      update.phase,
                      update.phase === "downloading" ? update.percent : 0,
                    )}
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
