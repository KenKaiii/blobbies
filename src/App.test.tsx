import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { App } from "@/App";
import { type Agent, MAX_BLOBS } from "@/data/agents";
import { loadPlugins } from "@/data/plugins";
import { readPreference } from "@/lib/preferences";
import { getSecret } from "@/lib/secrets";
import {
  flushRoster,
  loadBlobRoutines,
  loadRoster,
  loadUserMemories,
  saveBlobRoutines,
  saveBlobTranscript,
} from "@/lib/store";

/**
 * Let App's boot effect finish before asserting.
 *
 * `App` loads the roster, settings, groups, skills and Composio state across
 * several awaits (`src/App.tsx:530`). A test that renders and asserts purely
 * synchronously returns while that chain is still in flight, so the state
 * updates land with no act() scope open and React warns that the test ended
 * mid-update. Tests driven by `userEvent` never see this — every await gives
 * the chain a scope to settle in — so only the synchronous ones need it.
 *
 * Awaiting a macrotask covers the whole chain: the Tauri store mocks resolve
 * on the next tick rather than the microtask queue.
 */
async function settleBoot() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Completes the first-run creator with the given Blob name. */
async function createFirstBlob(user: UserEvent, name = "Ken") {
  await user.type(screen.getByLabelText("Name"), name);
  await user.click(screen.getByRole("button", { name: "Get started" }));
}

/** Roster row with a store-legal id, numbered so ids stay unique. */
function seedBlob(index: number, name: string, extra: Partial<Agent> = {}): Agent {
  return {
    id: `61ec34f1-9ba5-4eff-b8e1-7acefb21${String(index).padStart(4, "0")}`,
    name,
    time: "Now",
    snippet: "New Blob. Say hello",
    tone: "blue",
    shape: "sphere",
    ...extra,
  };
}

/** Open a sidebar row's context menu. */
async function openRowMenu(user: UserEvent, name: RegExp) {
  const conversations = screen.getByRole("navigation", { name: "Conversations" });
  await user.pointer({
    keys: "[MouseRight]",
    target: within(conversations).getByRole("button", { name }),
  });
}

/** Let the store's debounced writes land. */
async function flushWrites() {
  window.dispatchEvent(new Event("beforeunload"));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("App", () => {
  it("hydrates a persisted roster on startup", async () => {
    await flushRoster([
      {
        id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
        name: "Restored",
        time: "Now",
        snippet: "New Blob. Say hello",
        tone: "blue",
        shape: "sphere",
      },
    ]);
    render(<App />);

    // The persisted Blob replaces the empty first-run state.
    expect(await screen.findByRole("heading", { name: "Restored", level: 1 })).toBeInTheDocument();
  });

  it("restores the conversation of the Blob shown on startup", async () => {
    const id = "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea";
    await flushRoster([
      {
        id,
        name: "Ken",
        time: "Now",
        snippet: "Biscuit is a beagle",
        tone: "blue",
        shape: "sphere",
      },
    ]);
    saveBlobTranscript(id, [
      {
        id: "sent-1",
        kind: "text",
        author: "user",
        segments: [{ text: "My dog is called Biscuit." }],
      },
      {
        id: "agent-1",
        kind: "text",
        author: "agent",
        segments: [{ text: "Noted, Biscuit it is." }],
      },
    ]);
    // saveBlobTranscript is debounced; let the write land before mounting.
    await new Promise((resolve) => setTimeout(resolve, 400));

    render(<App />);

    // Nothing is clicked: the first Blob is shown by fallback, and its history
    // must load or the model is sent a conversation with no past turns.
    const log = await screen.findByRole("log");
    expect(await within(log).findByText("My dog is called Biscuit.")).toBeInTheDocument();
    expect(await within(log).findByText("Noted, Biscuit it is.")).toBeInTheDocument();
  });

  it("clears the draft when switching Blobs without remounting the pane", async () => {
    await flushRoster([
      {
        id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
        name: "Ken",
        time: "Now",
        snippet: "New Blob. Say hello",
        tone: "red",
        shape: "cloud",
      },
      {
        id: "7c1f34f1-9ba5-4eff-b8e1-7acefb2148eb",
        name: "Bob",
        time: "Now",
        snippet: "New Blob. Say hello",
        tone: "blue",
        shape: "sphere",
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    const composer = await screen.findByLabelText("Message Ken");
    await user.type(composer, "draft for ken");

    const conversations = screen.getByRole("navigation", { name: "Conversations" });
    await user.click(within(conversations).getByRole("button", { name: /Bob/ }));

    // Same pane, new conversation: title and placeholder switch, the
    // per-conversation draft resets (ChatPane resets state on agent.id
    // change instead of being remounted via a key).
    expect(screen.getByRole("heading", { name: "Bob", level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText("Message Bob")).toHaveValue("");
  });

  it("shows the first-run creator when no Blobs exist", async () => {
    render(<App />);
    await settleBoot();

    expect(screen.getByRole("heading", { name: "New Blob", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Create your first Blob")).toBeInTheDocument();
    expect(screen.getByText("No Blobs yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get started" })).toBeDisabled();
  });

  it("creates the first Blob, opens its conversation and persists the roster", async () => {
    const user = userEvent.setup();
    render(<App />);

    await createFirstBlob(user, "Ken");

    // Creation flushes the roster to the store immediately (not debounced),
    // with a UUID id the Rust store will accept.
    const roster = await loadRoster();
    expect(roster).toHaveLength(1);
    expect(roster?.[0]?.name).toBe("Ken");
    expect(roster?.[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    expect(screen.getByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();
    // The greeting question plus the setup hint that says what to answer with.
    const log = screen.getByRole("log");
    expect(within(log).getByText("What do you need me to do?")).toBeInTheDocument();
    expect(within(log).getByText(/To set me up/)).toBeInTheDocument();
    const conversations = screen.getByRole("navigation", { name: "Conversations" });
    // "Ken" the Blob row, not the "Ken Kai" account row in the footer.
    expect(
      within(conversations).getByRole("button", { name: /What do you need me to do\?/ }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message Ken")).toBeInTheDocument();
  });

  it("caps Blob names at the maximum length", async () => {
    const user = userEvent.setup();
    render(<App />);

    const longName = "A".repeat(40);
    await user.type(screen.getByLabelText("Name"), longName);

    const field = screen.getByLabelText("Name") as HTMLInputElement;
    expect(field.value).toHaveLength(24);
    expect(screen.getByText("24/24")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "A".repeat(24), level: 1 })).toBeInTheDocument();
  });

  it("prefills the creator from a suggestion card", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Writer Blob/ }));
    expect(screen.getByLabelText("Name")).toHaveValue("Writer Blob");

    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "Writer Blob", level: 1 })).toBeInTheDocument();
  });

  it("sends on Enter and inserts a newline on Shift+Enter", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user);

    const composer = screen.getByLabelText("Message Ken");
    await user.type(composer, "line one{Shift>}{Enter}{/Shift}line two");
    expect(composer).toHaveValue("line one\nline two");

    await user.type(composer, "{Enter}");
    expect(composer).toHaveValue("");
    expect(within(screen.getByRole("log")).getByText(/line one/)).toBeInTheDocument();
  });

  it("answers a sent message with the no-model fallback when none is chosen", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user);

    await user.type(screen.getByLabelText("Message Ken"), "hello{Enter}");

    // No model configured: the Blob must still respond, pointing at Settings.
    expect(
      await within(screen.getByRole("log")).findByText(/pick one in Settings/),
    ).toBeInTheDocument();
  });

  it("keeps one composer when replying inline", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user);

    await user.click(screen.getAllByRole("button", { name: "Reply" })[0] as HTMLElement);
    expect(screen.getByPlaceholderText("Reply...")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Message Ken")).toHaveLength(1);
  });

  it("reacts to a message from the picker", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user);

    const reactButtons = screen.getAllByRole("button", { name: "React" });
    await user.click(reactButtons[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "React with thumbs up" }));

    expect(screen.getByLabelText(/Reacted with/)).toBeInTheDocument();
  });

  it("puts the reaction on the bubble without moving the conversation", async () => {
    // The chip used to be a row of its own inside the message, so reacting
    // grew that message by a line and pushed every bubble below it down the
    // transcript — a reaction rearranged the conversation around it.
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user);

    const reactButtons = screen.getAllByRole("button", { name: "React" });
    await user.click(reactButtons[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "React with thumbs up" }));

    const chip = screen.getByLabelText(/Reacted with/);
    // Out of flow, so it occupies no height in the message column.
    expect(chip).toHaveClass("bubble-reaction");
    expect(chip.closest(".message-line")).not.toBeNull();
    // On the bubble's own line box, which hugs the bubble — not a sibling row
    // of it, which is what took up the space.
    expect(chip.parentElement).toHaveClass("message-line");
  });

  it("routes palette creation through the creator with the query prefilled", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "New chat" }));
    const toField = screen.getByLabelText("Search or create Blobs");
    expect(toField).toHaveFocus();

    await user.type(toField, "Zed");
    await user.click(screen.getByRole("button", { name: 'Create new Blob "Zed"' }));

    // Creator opens prefilled; finishing it lands in the new chat.
    expect(screen.getByLabelText("Name")).toHaveValue("Zed");
    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "Zed", level: 1 })).toBeInTheDocument();
  });

  it("starts a group chat from the palette, and drops the old empty section", async () => {
    // A leftover "New section" from the sidebar's removed add button: empty
    // scaffolding, so the migration must not seed a placeholder group with it.
    // Seeded onboarded: this stub replaces the setup file's preference store,
    // and without the flag the first-run flow covers the app.
    const store = new Map<string, string>([
      ["pref:onboarded", "true"],
      ["pref:sections", JSON.stringify(["New section"])],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    try {
      const user = userEvent.setup();
      render(<App />);
      await createFirstBlob(user, "Ken");

      await user.click(screen.getByRole("button", { name: "New chat" }));
      await user.type(screen.getByLabelText("Search or create Blobs"), "Launch");
      await user.click(screen.getByRole("button", { name: 'New group chat "Launch"' }));

      // The group opens on creation, named as typed and empty until Blobs are
      // dragged in — which the empty state has to say, since nothing else does.
      expect(screen.getByLabelText("Group name")).toHaveValue("Launch");
      const conversations = screen.getByRole("navigation", { name: "Conversations" });
      expect(within(conversations).getByText("Drag Blobs here to add them")).toBeInTheDocument();
      expect(within(conversations).queryByText("New section")).not.toBeInTheDocument();

      // A second group asking for the same name gets a suffix instead. The
      // name IS the membership key (a Blob's `section`), so two groups
      // sharing one would each claim the other's Blobs.
      await user.click(screen.getByRole("button", { name: "New chat" }));
      await user.type(screen.getByLabelText("Search or create Blobs"), "launch");
      await user.click(screen.getByRole("button", { name: 'New group chat "launch"' }));
      expect(screen.getByLabelText("Group name")).toHaveValue("launch 2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens an existing Blob from the palette and dismisses on Escape", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "New chat" }));
    const palette = screen.getByRole("region", { name: "New chat" });
    await user.click(within(palette).getByRole("button", { name: /Ken/ }));
    expect(screen.getByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New chat" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Search or create Blobs")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();
  });

  it("searches across Blobs and jumps to the one it finds", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");
    // A second Blob, so picking one is a real choice rather than the only row.
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await user.type(screen.getByLabelText("Search or create Blobs"), "Zed");
    await user.click(screen.getByRole("button", { name: 'Create new Blob "Zed"' }));
    await user.click(screen.getByRole("button", { name: "Get started" }));

    await user.click(screen.getByRole("button", { name: "Search" }));
    const palette = screen.getByRole("dialog", { name: "Search" });
    await user.type(within(palette).getByRole("textbox", { name: "Search" }), "ken");
    await user.click(await within(palette).findByRole("button", { name: /Ken/ }));

    // Picking a row closes the palette and opens that conversation.
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();
  });

  it("opens Settings on the tab the palette asked for", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByRole("button", { name: /Settings: Updates/ }));

    // Straight to Updates, not the General tab the dialog otherwise opens on.
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("button", { name: "Check for Updates" })).toBeInTheDocument();
  });

  it("opens Blob settings from the chat header identity", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Ken settings" }));

    const panel = screen.getByRole("complementary", { name: "Ken settings" });
    expect(within(panel).getByLabelText("Name")).toHaveValue("Ken");

    // Renaming updates the chat header and sidebar live.
    await user.clear(within(panel).getByLabelText("Name"));
    await user.type(within(panel).getByLabelText("Name"), "Kenji");
    expect(screen.getByRole("heading", { name: "Kenji", level: 1 })).toBeInTheDocument();

    // Notifications toggle flips.
    const toggle = within(panel).getByRole("switch", { name: "Notifications" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();

    // Back returns to the info view.
    await user.click(within(panel).getByRole("button", { name: "Back" }));
    expect(screen.getByRole("complementary", { name: "Kenji details" })).toBeInTheDocument();
  });

  it("keeps the avatar grids folded behind the avatar until asked", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");
    await user.click(screen.getByRole("button", { name: "Ken settings" }));
    const panel = screen.getByRole("complementary", { name: "Ken settings" });

    // Seventeen controls, touched once, sitting in front of the fields being
    // edited: closed by default so Name/Title/Description stay above the fold.
    const edit = within(panel).getByRole("button", { name: "Edit avatar" });
    expect(edit).toHaveAttribute("aria-expanded", "false");
    expect(within(panel).queryByLabelText("purple")).not.toBeInTheDocument();

    await user.click(edit);
    expect(edit).toHaveAttribute("aria-expanded", "true");
    // Both grids are there, and they write through to the Blob.
    await user.click(within(panel).getByLabelText("purple"));
    await user.click(within(panel).getByLabelText("triangle"));
    expect(within(panel).getByLabelText("purple")).toBeChecked();
    expect(within(panel).getByLabelText("triangle")).toBeChecked();

    // Escape closes the popover and hands focus back to what opened it — not
    // to <body>, where the next Tab would restart from the top of the panel.
    await user.keyboard("{Escape}");
    expect(within(panel).queryByLabelText("purple")).not.toBeInTheDocument();
    expect(edit).toHaveFocus();
    // ...and Escape was consumed here, so the panel behind it stayed open.
    expect(screen.getByRole("complementary", { name: "Ken settings" })).toBeInTheDocument();
  });

  it("never lets two Blobs answer to the same name", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Scout");

    // `@Scout` resolves to the first match, so a second one would be
    // permanently unmentionable and the user could not say which they meant.
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await user.type(screen.getByLabelText("Search or create Blobs"), "scout");
    await user.click(screen.getByRole("button", { name: 'Create new Blob "scout"' }));
    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("heading", { name: "scout 2", level: 1 })).toBeInTheDocument();

    // Renaming onto a taken name is refused the same way — the settings
    // field is the only rename UI, so this is the other half of the rule.
    await user.click(screen.getByRole("button", { name: "scout 2 settings" }));
    const panel = screen.getByRole("complementary", { name: "scout 2 settings" });
    const field = within(panel).getByLabelText("Name");
    await user.clear(field);
    // Typed in full first: settling per keystroke would fight the user — this
    // name passes the taken "Scout" on its way to "Scout Two".
    await user.type(field, "Scout Two");
    expect(field).toHaveValue("Scout Two");
    await user.tab();
    expect(screen.getByRole("heading", { name: "Scout Two", level: 1 })).toBeInTheDocument();

    // But landing on the taken name itself is still refused.
    await user.clear(field);
    await user.type(field, "Scout");
    await user.tab();
    expect(screen.getByRole("heading", { name: "Scout 2", level: 1 })).toBeInTheDocument();
  });

  it("opens app settings from the account menu and edits preferences", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Ken Kai/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Ken Kai");

    // Rename updates the footer account row live.
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "Kenny");
    expect(screen.getByRole("button", { name: /Kenny/ })).toBeInTheDocument();

    // Theme switch applies to the document root.
    await user.selectOptions(within(dialog).getByLabelText("Theme"), "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    // Timezone select defaults to auto-detect.
    expect(within(dialog).getByLabelText("Timezone")).toHaveValue("auto");

    // Sounds defaults on, and one toggle-off persists.
    const soundsToggle = within(dialog).getByRole("switch", { name: "Sounds" });
    expect(soundsToggle).toHaveAttribute("aria-checked", "true");
    await user.click(soundsToggle);
    expect(window.localStorage.getItem("pref:sounds")).toBe("off");
    await user.click(soundsToggle);
    expect(window.localStorage.getItem("pref:sounds")).toBe("on");

    // Updates tab is Blobbies-branded; outside the Tauri webview the updater
    // stays idle, the blurb says where updates come from, and the version row
    // has no bundle to ask — so it shows the bare name (the number is read
    // from the running app at runtime, never a constant that could go stale).
    await user.click(within(dialog).getByRole("button", { name: "Updates" }));
    expect(within(dialog).getByText(/^Blobbies$/)).toBeInTheDocument();
    expect(within(dialog).getByText(/GitHub Releases/)).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the Channels lab pane only while the flag is on", async () => {
    await flushRoster([seedBlob(1, "Ken")]);
    const user = userEvent.setup();

    // Off by default: no pane, even with nothing selected.
    render(<App />);
    expect(screen.queryByRole("region", { name: "Channels (Labs)" })).not.toBeInTheDocument();

    // The Labs section persists the flag under the same pref: namespace.
    await user.click(screen.getByRole("button", { name: /Ken Kai/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByText(/Turning a lab off only hides its UI/)).toBeInTheDocument();

    const channelsToggle = within(dialog).getByRole("switch", { name: "Channels" });
    expect(channelsToggle).toHaveAttribute("aria-checked", "false");
    await user.click(channelsToggle);
    expect(window.localStorage.getItem("pref:labs.channels")).toBe("on");
    expect(within(dialog).getByRole("switch", { name: "Channels" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(within(dialog).getByRole("button", { name: "Close settings" }));

    // Nothing selected on launch, so the stub pane appears beside the chat.
    expect(screen.getByRole("region", { name: "Channels (Labs)" })).toBeInTheDocument();

    // Selecting a conversation routes away from the lab pane.
    await user.click(
      within(screen.getByRole("navigation", { name: "Conversations" })).getAllByRole("button")[0],
    );
    expect(screen.queryByRole("region", { name: "Channels (Labs)" })).not.toBeInTheDocument();
  });

  it("creates one channel composer and persists channel renames", async () => {
    window.localStorage.setItem("pref:labs.channels", "on");
    await flushRoster([seedBlob(1, "Ken")]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "New channel" }));
    expect(screen.getAllByRole("textbox", { name: /Message new-channel/ })).toHaveLength(1);

    const name = screen.getByRole("textbox", { name: "Group name" });
    await user.clear(name);
    await user.type(name, "launch{Enter}");
    expect(screen.getByRole("textbox", { name: "Group name" })).toHaveValue("launch");
    await expect(
      (await import("@/lib/store"))
        .loadChannels()
        .then((channels) => channels?.some((channel) => channel.name === "launch")),
    ).resolves.toBe(true);
  });

  it("imports group chats as channels when the Channels lab is first enabled", async () => {
    // A pre-existing group (via the legacy sections migration path) and the
    // flag already on at launch: the group must survive untouched while a
    // channel copy appears beside it — the one-way import.
    const store = new Map<string, string>([
      ["pref:onboarded", "true"],
      ["pref:labs.channels", "on"],
      ["pref:sections", JSON.stringify(["Work"])],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    try {
      await flushRoster([
        seedBlob(1, "Ken", { section: "Work" }),
        seedBlob(2, "Ada", { section: "Work" }),
      ]);
      const user = userEvent.setup();
      render(<App />);
      const conversations = await screen.findByRole("navigation", { name: "Conversations" });

      // The imported channel is its own row, and opening it routes the chat
      // there (aria-current) without disturbing the group it came from.
      const channelRow = await within(conversations).findByRole("button", { name: /# Work/ });
      await user.click(channelRow);
      expect(channelRow).toHaveAttribute("aria-current", "true");
      // The group's own chat is still one click away: nothing was moved.
      await user.click(within(conversations).getByRole("button", { name: "Work" }));
      expect(channelRow).not.toHaveAttribute("aria-current", "true");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks for a Composio key in the Plugins tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Ken Kai/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("button", { name: "Plugins" }));

    // Composio is reached over its hosted MCP endpoint now: no binary to
    // install, a browser sign-in. The CLI this replaced had no Windows build
    // at all, so the old "Install" button was unreachable on a supported
    // platform.
    expect(await within(dialog).findByText(/Log in to connect your apps/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Install" })).not.toBeInTheDocument();

    // The pasted key stays as the fallback, and says so: leading with it sends
    // people to the harder path first.
    const keyField = within(dialog).getByLabelText(/API key/);
    expect(keyField).toBeInTheDocument();
    // JSX attributes are raw text, not JS strings, so a \u2026 escape here
    // renders as those six characters. It shipped that way once.
    expect(keyField.getAttribute("placeholder")).not.toContain("\\u");

    // Skills read from disk, which jsdom has none of — the empty state must
    // say where to put one rather than showing a blank card.
    expect(within(dialog).getByText("Skills")).toBeInTheDocument();
    expect(await within(dialog).findByText(/No skills yet/)).toBeInTheDocument();
  });

  it("keeps the editor bridge off until it is switched on", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Ken Kai/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("button", { name: "Plugins" }));

    // A local control surface that can run a Blob's shell tools must not be
    // reachable by default, and nothing about it is shown until it is on.
    const toggle = within(dialog).getByRole("switch", {
      name: "Let editors talk to your Blobs",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(within(dialog).queryByText("Command")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("lists downloaded Ollama models and frees the outgoing one on switch", async () => {
    // Deterministic local server: version probe succeeds, two models pulled.
    const unloads: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/version")) {
          return new Response(JSON.stringify({ version: "0.5.0" }));
        }
        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "llama3.2:latest",
                  size: 2_000_000_000,
                  details: { parameter_size: "3.2B" },
                },
                {
                  name: "qwen3.5:9b",
                  size: 6_600_000_000,
                  details: { parameter_size: "9B" },
                },
              ],
            }),
          );
        }
        if (url.endsWith("/api/chat")) {
          // The only /api/chat traffic settings may produce is the unload.
          unloads.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ done: true }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    try {
      const user = userEvent.setup();
      render(<App />);

      await user.click(screen.getByRole("button", { name: /Ken Kai/ }));
      await user.click(screen.getByRole("menuitem", { name: "Settings" }));
      const dialog = screen.getByRole("dialog", { name: "Settings" });
      await user.click(within(dialog).getByRole("button", { name: "Model" }));

      // Section 1: install/server status.
      expect(await within(dialog).findByText(/Running v0\.5\.0/)).toBeInTheDocument();

      // Section 2: choosing between the downloaded models.
      const select = within(dialog).getByLabelText("Chat model");
      await user.selectOptions(select, "llama3.2:latest");
      expect(select).toHaveValue("llama3.2:latest");
      // First pick came from "no model": nothing to free yet.
      expect(unloads).toEqual([]);

      // Switching models must release the outgoing one immediately —
      // keep_alive: 0 — or it idles in RAM beside the new model for 30m.
      await user.selectOptions(select, "qwen3.5:9b");
      expect(unloads).toEqual([{ model: "llama3.2:latest", messages: [], keep_alive: 0 }]);
    } finally {
      vi.unstubAllGlobals();
      // This test persists a model choice; later tests assume none is set.
      // (When jsdom lacks localStorage, writePreference already no-oped and
      // there is nothing to clean.)
      try {
        window.localStorage.removeItem("pref:model");
      } catch {
        // Storage unavailable: the preference never stuck.
      }
    }
  });

  it("collapses and expands the sidebar via the resize splitter", async () => {
    const user = userEvent.setup();
    render(<App />);

    const splitter = screen.getByRole("separator", { name: "Resize sidebar" });
    const sidebar = screen.getByRole("navigation", { name: "Conversations" });

    splitter.focus();
    await user.keyboard("{Enter}");
    expect(sidebar.className).toContain("sidebar-collapsed");

    await user.keyboard("{ArrowRight}");
    expect(sidebar.className).not.toContain("sidebar-collapsed");
  });

  it("creates a routine from the empty state and lists it afterwards", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    expect(
      within(details).getByText(/Routines are recurring tasks this agent runs on a schedule/),
    ).toBeInTheDocument();

    await user.click(within(details).getByRole("button", { name: "Create Routine" }));

    // Editor opens; fill it in and add a schedule trigger.
    const editor = screen.getByRole("complementary", { name: "Routine" });
    await user.type(within(editor).getByLabelText("Name"), "Test routine");
    await user.click(within(editor).getByRole("button", { name: "Add trigger" }));
    await user.click(within(editor).getByRole("menuitem", { name: "On a schedule" }));
    await user.click(within(editor).getByRole("menuitem", { name: "Every hour" }));
    expect(within(editor).getByText("Every hour")).toBeInTheDocument();

    // Back shows the routine listed with its trigger.
    await user.click(within(editor).getByRole("button", { name: "Back" }));
    const list = screen.getByRole("complementary", { name: "Ken details" });
    expect(within(list).getByRole("button", { name: /Test routine/ })).toBeInTheDocument();
    expect(within(list).getByText("Every hour")).toBeInTheDocument();
  });

  it("schedules a routine at a specific time through the custom picker", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    await user.click(within(details).getByRole("button", { name: "Create Routine" }));

    const editor = screen.getByRole("complementary", { name: "Routine" });
    await user.type(within(editor).getByLabelText("Name"), "Afternoon check-in");
    await user.type(within(editor).getByLabelText("Instruction"), "Ask how the day went.");
    await user.click(within(editor).getByRole("button", { name: "Add trigger" }));
    await user.click(within(editor).getByRole("menuitem", { name: "On a schedule" }));
    // Not a preset: a real time of day.
    await user.click(within(editor).getByRole("menuitem", { name: "Custom…" }));
    await user.selectOptions(within(editor).getByLabelText("Repeat"), "daily");
    await user.selectOptions(within(editor).getByLabelText("Hour"), "15");
    await user.selectOptions(within(editor).getByLabelText("Minute"), "30");
    await user.click(within(editor).getByRole("menuitem", { name: "Apply" }));

    // The trigger chip and the schedule line both show the chosen time — the
    // preset era hardcoded 9:00 and never said which 9:00. The "next" half
    // only renders when the scheduler armed a real fire time.
    expect(
      within(editor).getByText("Every day at 15:30", { selector: ".trigger-row" }),
    ).toBeInTheDocument();
    expect(within(editor).getByText(/Every day at 15:30 · next/)).toBeInTheDocument();
  });

  it("adds a GitHub listener, and stacks a second one beside it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    await user.click(within(details).getByRole("button", { name: "Create Routine" }));

    const editor = screen.getByRole("complementary", { name: "Routine" });
    await user.type(within(editor).getByLabelText("Name"), "Watch the repo");
    await user.click(within(editor).getByRole("button", { name: "Add trigger" }));
    await user.click(within(editor).getByRole("menuitem", { name: "On a GitHub event" }));
    await user.type(within(editor).getByLabelText("Repository"), "acme/app");
    await user.click(within(editor).getByRole("menuitem", { name: "Apply" }));

    // The chip says exactly what will fire it, in the reference's words.
    expect(within(editor).getByText("When a PR opens in acme/app")).toBeInTheDocument();

    // Listeners stack rather than replacing each other — a routine woken by
    // several things at once is the whole point of the model.
    await user.click(within(editor).getByRole("button", { name: "Add another" }));
    await user.click(within(editor).getByRole("menuitem", { name: "On a Slack message" }));
    await user.type(within(editor).getByLabelText("Channel"), "#ops");
    await user.click(within(editor).getByRole("menuitem", { name: "Apply" }));

    expect(within(editor).getByText("When a PR opens in acme/app")).toBeInTheDocument();
    expect(within(editor).getByText("When @mentioned in #ops")).toBeInTheDocument();
  });

  it("refuses a repository that is not owner/name", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    await user.click(within(details).getByRole("button", { name: "Create Routine" }));

    const editor = screen.getByRole("complementary", { name: "Routine" });
    await user.click(within(editor).getByRole("button", { name: "Add trigger" }));
    await user.click(within(editor).getByRole("menuitem", { name: "On a GitHub event" }));
    await user.type(within(editor).getByLabelText("Repository"), "just-a-name");
    await user.click(within(editor).getByRole("menuitem", { name: "Apply" }));

    // Nothing is stored and the editor says why, rather than saving a
    // listener that could never match anything.
    expect(within(editor).getByText(/owner\/name/)).toBeInTheDocument();
    expect(within(editor).queryByText(/When a PR opens/)).toBeNull();
  });

  it("drops a listener the user removes", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    await user.click(within(details).getByRole("button", { name: "Create Routine" }));

    const editor = screen.getByRole("complementary", { name: "Routine" });
    await user.click(within(editor).getByRole("button", { name: "Add trigger" }));
    await user.click(within(editor).getByRole("menuitem", { name: "On a Slack message" }));
    await user.type(within(editor).getByLabelText("Channel"), "#ops");
    await user.click(within(editor).getByRole("menuitem", { name: "Apply" }));
    expect(within(editor).getByText("When @mentioned in #ops")).toBeInTheDocument();

    await user.click(
      within(editor).getByRole("button", { name: "Stop watching: When @mentioned in #ops" }),
    );
    expect(within(editor).queryByText("When @mentioned in #ops")).toBeNull();
  });

  it("schedules a counted burst — every minute, five times — through the custom picker", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    const details = screen.getByRole("complementary", { name: "Ken details" });
    await user.click(within(details).getByRole("button", { name: "Create Routine" }));

    const editor = screen.getByRole("complementary", { name: "Routine" });
    await user.type(within(editor).getByLabelText("Name"), "UI tips");
    await user.click(within(editor).getByRole("button", { name: "Add trigger" }));
    await user.click(within(editor).getByRole("menuitem", { name: "On a schedule" }));
    await user.click(within(editor).getByRole("menuitem", { name: "Custom…" }));
    await user.selectOptions(within(editor).getByLabelText("Repeat"), "interval");
    await user.clear(within(editor).getByLabelText("Minutes"));
    await user.type(within(editor).getByLabelText("Minutes"), "1");
    // Empty "Times" means unbounded; filling it bounds the burst to five runs.
    await user.type(within(editor).getByLabelText("Times"), "5");
    await user.click(within(editor).getByRole("menuitem", { name: "Apply" }));

    expect(
      within(editor).getByText("Every minute, 5 times", { selector: ".trigger-row" }),
    ).toBeInTheDocument();
    expect(within(editor).getByText(/Every minute, 5 times · 5 left · next/)).toBeInTheDocument();
  });

  it("browses plugins and reports why a connect failed, on the row that failed", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Plugins" }));
    const dialog = screen.getByRole("dialog", { name: "Plugins" });

    // The catalog chunk loads async (the long tail is too heavy for the
    // startup bundle), so the list's controls appear a beat after the dialog.
    await within(dialog).findByLabelText("Search plugins");

    // Each tab carries its own total: how many apps exist, and how many are
    // the user's. Asserted against the real catalog rather than a literal,
    // which would need editing on every `pnpm plugins` run.
    const catalog = await loadPlugins();
    const marketplaceTab = within(dialog).getByRole("tab", { name: "Marketplace" });
    expect(marketplaceTab).toHaveTextContent(String(catalog.length));
    // Nothing is connected outside Tauri, and an empty "Yours" says that by
    // itself — a "0" beside it would be decoration, so the badge only appears
    // once there is something to count.
    expect(within(dialog).getByRole("tab", { name: "Yours" })).toHaveTextContent(/^Yours$/);

    // Search narrows the marketplace. The phrase is Gmail's own hand-written
    // description rather than "gmail", which in a 900-app catalog also matches
    // long-tail apps whose blurbs happen to mention Gmail. Connecting runs
    // through Composio, so outside Tauri nothing can be connected — and a tile
    // must never read "Connected" unless Composio said so.
    await user.type(within(dialog).getByLabelText("Search plugins"), "Triage the inbox");
    expect(within(dialog).queryByText("Connected")).not.toBeInTheDocument();
    // The count is a total, so it stays put while the list beneath it
    // narrows — otherwise it would just be the row count restated.
    expect(marketplaceTab).toHaveTextContent(String(catalog.length));

    // A failed connect explains itself on the row that was clicked. Without
    // this, a missing account and an abandoned browser tab are both just a
    // button that appeared to do nothing. Signed out, that is what it says.
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByText(/No Composio account yet/)).toBeInTheDocument();
    expect(within(dialog).queryByText("Connected")).not.toBeInTheDocument();

    // The detail view lists real accounts. With none connected it says so
    // rather than inventing a "Default" row that was never real.
    await user.clear(within(dialog).getByLabelText("Search plugins"));
    // By now the failed connect has swapped this row's description for its
    // error line, so the button's name is "GmailConnecting apps only works…" —
    // match on the name alone. No other app in the catalog starts with
    // "Gmail", so the prefix stays unique.
    await user.click(within(dialog).getByRole("button", { name: /^Gmail/ }));
    expect(within(dialog).getByText(/No account connected yet/)).toBeInTheDocument();

    // Naming a second account comes before the browser opens, because the CLI
    // requires an alias to tell two accounts on one app apart.
    await user.click(within(dialog).getByRole("button", { name: /Add Another Account/ }));
    expect(within(dialog).getByLabelText("Name for the new account")).toBeInTheDocument();

    // No "View Source" here: a link to someone else's repo answers a question
    // nobody asked while connecting an app. (`ExternalLink`'s navigation-
    // cancelling behaviour is covered by its own test.)
    expect(within(dialog).queryByRole("link", { name: /View Source/ })).not.toBeInTheDocument();

    // No per-account "Reconnect" either: `composio link` only creates, and
    // demands a new alias once an account exists, so the button added a row
    // instead of repairing one.
    expect(within(dialog).queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();

    // Nothing is stated before it is known. The panel used to render "Connect"
    // and a "Disconnected account" row while the probe was still out, then
    // correct itself — a label that changes under the user reads as a bug even
    // when the final state is right. Outside Tauri the probe resolves to
    // nothing, so the settled state is the empty one.
    expect(await within(dialog).findByText(/No account connected yet/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Disconnected account/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/gmail_/)).not.toBeInTheDocument();

    // Escape steps back to the list before closing.
    await user.keyboard("{Escape}");
    expect(within(dialog).getByRole("tab", { name: "Yours" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Plugins" })).not.toBeInTheDocument();
  });

  /** Open Settings → Memories, where the facts now live. */
  const openMemories = async (user: ReturnType<typeof userEvent.setup>, blobName: string) => {
    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.click(screen.getByRole("button", { name: /^Memories/ }));
    return screen.getByRole("dialog", { name: `${blobName} memories` });
  };

  it("promotes a memory from this Blob to all Blobs", async () => {
    // Seeded on disk rather than typed in: the dialog has no add button, and
    // it should not — a fact is something the Blob saved while you talked.
    await flushRoster([
      seedBlob(1, "Ken", {
        memories: [{ id: "aaa11111", text: "Biscuit is a beagle", createdAt: 1 }],
      }),
    ]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("navigation", { name: "Conversations" });

    const memories = await openMemories(user, "Ken");

    // Numbered to match renderMemories, so "forget 1" in chat means this row.
    const row = within(memories).getByRole("row", { name: /Biscuit is a beagle/ });
    expect(within(row).getByRole("cell", { name: "1" })).toBeInTheDocument();
    expect(within(row).getByRole("cell", { name: "Ken" })).toBeInTheDocument();
    expect(await loadUserMemories()).toBeNull();

    // Promote: the fact leaves the Blob's config for the shared `user` slice.
    await user.click(within(memories).getByRole("button", { name: "Share with all Blobs" }));
    const shared = within(memories).getByRole("row", { name: /Biscuit is a beagle/ });
    expect(within(shared).getByRole("cell", { name: "All Blobs" })).toBeInTheDocument();
    // Shared facts are unnumbered: the model addresses one list by position.
    expect(within(shared).getByRole("cell", { name: "\u2014" })).toBeInTheDocument();

    window.dispatchEvent(new Event("beforeunload"));
    expect(await loadUserMemories()).toEqual([
      expect.objectContaining({ text: "Biscuit is a beagle" }),
    ]);
    const roster = await loadRoster();
    expect(roster?.[0]?.memories ?? []).toEqual([]);

    // And back again, so the toggle is not one-way.
    await user.click(within(memories).getByRole("button", { name: "Keep to this Blob only" }));
    expect(
      within(within(memories).getByRole("row", { name: /Biscuit is a beagle/ })).getByRole("cell", {
        name: "Ken",
      }),
    ).toBeInTheDocument();
  });

  it("deletes a memory from the memories dialog", async () => {
    await flushRoster([
      seedBlob(1, "Ken", {
        memories: [{ id: "bbb22222", text: "Temporary", createdAt: 1 }],
      }),
    ]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("navigation", { name: "Conversations" });

    const memories = await openMemories(user, "Ken");

    // Arming is not deleting: the fact survives until the pill is clicked, and
    // the pill is not where the delete button was, so a stray double-click
    // cannot destroy a memory the Blob spent a conversation learning.
    await user.click(within(memories).getByRole("button", { name: "Delete memory: Temporary" }));
    expect(within(memories).getByText("Temporary")).toBeInTheDocument();

    // And it can be called off.
    await user.click(within(memories).getByRole("button", { name: "Keep memory" }));
    expect(within(memories).getByText("Temporary")).toBeInTheDocument();

    await user.click(within(memories).getByRole("button", { name: "Delete memory: Temporary" }));
    await user.click(within(memories).getByRole("button", { name: "Confirm delete: Temporary" }));
    expect(within(memories).queryByText("Temporary")).not.toBeInTheDocument();
    expect(
      within(memories).getByText(/Facts this Blob learns as you talk show up here/),
    ).toBeInTheDocument();
  });

  it("hides a Blob from the sidebar and brings it back", async () => {
    await flushRoster([seedBlob(1, "Ken"), seedBlob(2, "Bob")]);
    const user = userEvent.setup();
    render(<App />);
    const conversations = await screen.findByRole("navigation", { name: "Conversations" });

    await openRowMenu(user, /Bob/);
    await user.click(screen.getByRole("menuitem", { name: "Hide from sidebar" }));
    // A hidden Blob must stay reachable, or it is gone from the UI forever.
    // The collapsed rows stay mounted (the slot animates by CSS grid, which
    // jsdom cannot see) — the toggle's count is the observable contract.
    expect(
      within(conversations).getByRole("button", { name: "Show hidden blobs (1)" }),
    ).toBeInTheDocument();

    await user.click(within(conversations).getByRole("button", { name: /Show hidden blobs/ }));
    await openRowMenu(user, /Bob/);
    await user.click(screen.getByRole("menuitem", { name: "Unhide" }));

    expect(within(conversations).getByRole("button", { name: /Bob/ })).toBeInTheDocument();
    expect(
      within(conversations).queryByRole("button", { name: /Show hidden blobs/ }),
    ).not.toBeInTheDocument();
  });

  it("duplicates a Blob's profile and routines, but not its memories", async () => {
    const source = seedBlob(1, "Ken", {
      tone: "pink",
      shape: "cloud",
      title: "Inbox triage",
      description: "Reads the inbox every morning",
      instructions: "Be terse",
      memories: [{ id: "m1", text: "Biscuit is a beagle", createdAt: 1 }],
      usage: { inputTokens: 100, outputTokens: 20, runs: 3 },
    });
    await flushRoster([source]);
    saveBlobRoutines(source.id, [
      {
        id: "routine-1",
        name: "Morning sweep",
        instruction: "Check the inbox",
        triggers: ["Every hour"],
        active: true,
        schedule: { kind: "interval", minutes: 60 },
        nextRunAt: 1,
        lastRunAt: 1,
        lastRunStatus: "done",
      },
      {
        id: "routine-2",
        name: "Burst",
        instruction: "Ping once",
        triggers: ["Every minute, 5 times"],
        active: true,
        schedule: { kind: "interval", minutes: 1, count: 5 },
        nextRunAt: 1,
        // Mid-burst with one fire left: the copy must start over at five, not
        // inherit the source's last run.
        runsLeft: 1,
      },
    ]);
    await flushWrites();

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Ken", level: 1 });

    // By snippet: "Ken" alone also matches the "Ken Kai" account row.
    await openRowMenu(user, /Say hello/);
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    // The copy lands in Edit Profile, so it is renamed before anything fires.
    expect(
      await screen.findByRole("complementary", { name: "Ken copy settings" }),
    ).toBeInTheDocument();

    const roster = await loadRoster();
    const copy = roster?.find((row) => row.name === "Ken copy");
    expect(copy).toMatchObject({
      tone: "pink",
      shape: "cloud",
      title: "Inbox triage",
      description: "Reads the inbox every morning",
      instructions: "Be terse",
    });
    // Learned memory and lifetime usage belong to the original.
    expect(copy?.memories).toBeUndefined();
    expect(copy?.usage).toBeUndefined();

    await flushWrites();
    const copied = await loadBlobRoutines(copy?.id ?? "");
    expect(copied).toHaveLength(2);
    const sweep = copied?.find((routine) => routine.name === "Morning sweep");
    expect(sweep).toMatchObject({ active: true });
    expect(sweep?.id).not.toBe("routine-1");
    expect(sweep?.lastRunAt).toBeUndefined();
    expect(sweep?.lastRunStatus).toBeUndefined();
    // Re-armed: armRoutines only runs at startup, so a stale nextRunAt would
    // mean the copy's routine never fires.
    expect(sweep?.nextRunAt ?? 0).toBeGreaterThan(Date.now());
    const burst = copied?.find((routine) => routine.name === "Burst");
    expect(burst?.runsLeft).toBe(5);
  });

  it("refuses to create or duplicate past the Blob cap", async () => {
    await flushRoster(
      Array.from({ length: MAX_BLOBS }, (_, index) => seedBlob(index, `Blob${index}`)),
    );
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Blob0", level: 1 });

    // Duplicate is not offered: the copy would silently never appear.
    await openRowMenu(user, /Blob0/);
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "New chat" }));
    await user.type(screen.getByLabelText("Search or create Blobs"), "Zed");
    await user.click(screen.getByRole("button", { name: 'Create new Blob "Zed"' }));

    expect(screen.getByRole("button", { name: "Get started" })).toBeDisabled();
    expect(
      screen.getByText(`You have the maximum of ${MAX_BLOBS} Blobs. Delete one to make room.`),
    ).toBeInTheDocument();
    expect((await loadRoster())?.length).toBe(MAX_BLOBS);
  });

  it("collapses a group and keeps its Blobs out of the list", async () => {
    // Seeded as a pre-group-chat "section" — which also proves the migration
    // into real groups keeps the Blobs that were in it.
    // Preferences live in localStorage, which this jsdom build does not provide.
    const store = new Map<string, string>([
      ["pref:onboarded", "true"],
      ["pref:sections", JSON.stringify(["Work"])],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    try {
      await flushRoster([seedBlob(1, "Ken", { section: "Work" })]);
      const user = userEvent.setup();
      render(<App />);
      const conversations = await screen.findByRole("navigation", { name: "Conversations" });

      // The rows animate shut rather than unmounting — the group has to stay a
      // drop target — so `inert` is what takes them off the tab order.
      const rows = () =>
        conversations.querySelector('[data-drop="section:Work"] .agent-group-rows');
      // The name opens the group's chat now; collapsing is the chevron beside it.
      const toggle = within(conversations).getByRole("button", {
        name: /^(Collapse|Expand) Work$/,
      });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(rows()).not.toHaveAttribute("inert");

      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(rows()).toHaveAttribute("inert");
      expect(store.get("pref:sectionsCollapsed")).toBe('["Work"]');

      await user.click(toggle);
      expect(rows()).not.toHaveAttribute("inert");
      expect(within(conversations).getByRole("button", { name: /Say hello/ })).toBeVisible();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates, renames and deletes a group from the right-click menu", async () => {
    const store = new Map<string, string>([["pref:onboarded", "true"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    try {
      await flushRoster([seedBlob(1, "Ken")]);
      const user = userEvent.setup();
      render(<App />);
      const conversations = await screen.findByRole("navigation", { name: "Conversations" });

      // With no groups yet there is no group header to right-click, so the
      // first one has to come from a Blob's menu — otherwise groups are a
      // feature you can only use if you already have one.
      fireEvent.contextMenu(within(conversations).getByRole("button", { name: /Say hello/ }));
      await user.click(screen.getByRole("menuitem", { name: "New group" }));

      // Created and dropped straight into rename: "New Group" is nobody's
      // intended name.
      const field = await screen.findByLabelText("Rename group New Group");
      await user.clear(field);
      await user.type(field, "Launch{Enter}");
      expect(within(conversations).getByRole("button", { name: /^Launch/ })).toBeInTheDocument();

      // A second group off the first's own menu, and its name must not collide
      // — the name is the membership key, so two "New Group"s would share rows.
      fireEvent.contextMenu(within(conversations).getByRole("button", { name: /^Launch/ }));
      await user.click(screen.getByRole("menuitem", { name: "New group" }));
      expect(await screen.findByLabelText("Rename group New Group")).toBeInTheDocument();
      await user.keyboard("{Escape}");

      // Delete asks first — same dialog a Blob's delete uses.
      fireEvent.contextMenu(within(conversations).getByRole("button", { name: /^Launch/ }));
      await user.click(screen.getByRole("menuitem", { name: "Delete group" }));
      const confirm = await screen.findByRole("alertdialog", { name: "Delete group Launch" });
      expect(within(conversations).getByRole("button", { name: /^Launch/ })).toBeInTheDocument();

      await user.click(within(confirm).getByRole("button", { name: "Delete" }));
      expect(
        within(conversations).queryByRole("button", { name: /^Launch/ }),
      ).not.toBeInTheDocument();
      expect(within(conversations).getByRole("button", { name: /Say hello/ })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a deleted group does not hand its Blobs to the next group", async () => {
    // Membership is the group NAME. Deleting a group without clearing that
    // name off its members leaves it on disk, and the next group to take the
    // same name silently adopts Blobs the user never put in it — "I deleted
    // the group and the Blob came back".
    const store = new Map<string, string>([
      ["pref:onboarded", "true"],
      ["pref:sections", JSON.stringify(["Work"])],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    try {
      await flushRoster([seedBlob(1, "Ken", { section: "Work" })]);
      const user = userEvent.setup();
      render(<App />);
      const conversations = await screen.findByRole("navigation", { name: "Conversations" });

      fireEvent.contextMenu(within(conversations).getByRole("button", { name: /^Work/ }));
      await user.click(screen.getByRole("menuitem", { name: "Delete group" }));
      const confirm = await screen.findByRole("alertdialog", { name: "Delete group Work" });
      // The member is named, because deleting the group moves it out.
      expect(within(confirm).getByText(/1 Blob/)).toBeInTheDocument();
      await user.click(within(confirm).getByRole("button", { name: "Delete" }));

      // Released, not left pointing at a group that no longer exists.
      window.dispatchEvent(new Event("beforeunload"));
      expect((await loadRoster())?.[0]?.section ?? "").toBe("");

      // And a fresh group starts empty rather than re-adopting it.
      fireEvent.contextMenu(within(conversations).getByRole("button", { name: /Say hello/ }));
      await user.click(screen.getByRole("menuitem", { name: "New group" }));
      const field = await screen.findByLabelText("Rename group New Group");
      await user.clear(field);
      await user.type(field, "Work{Enter}");
      expect(conversations.querySelector('[data-drop="section:Work"] .agent-row')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renaming a group carries its members with it", async () => {
    // A Blob's `section` stores the group NAME, so a rename that only touched
    // the group would orphan every member into the ungrouped run.
    const store = new Map<string, string>([
      ["pref:onboarded", "true"],
      ["pref:sections", JSON.stringify(["Work"])],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    try {
      await flushRoster([seedBlob(1, "Ken", { section: "Work" })]);
      const user = userEvent.setup();
      render(<App />);
      const conversations = await screen.findByRole("navigation", { name: "Conversations" });

      fireEvent.contextMenu(within(conversations).getByRole("button", { name: /^Work/ }));
      await user.click(screen.getByRole("menuitem", { name: "Rename" }));
      const field = await screen.findByLabelText("Rename group Work");
      await user.clear(field);
      await user.type(field, "Launch{Enter}");

      // The member moved with the name rather than being left behind.
      expect(conversations.querySelector('[data-drop="section:Launch"] .agent-row')).not.toBeNull();
      window.dispatchEvent(new Event("beforeunload"));
      expect((await loadRoster())?.[0]?.section).toBe("Launch");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens the compose palette on Cmd+N", async () => {
    await flushRoster([seedBlob(1, "Ken")]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Ken", level: 1 });

    await user.keyboard("{Meta>}n{/Meta}");
    expect(screen.getByLabelText("Search or create Blobs")).toBeInTheDocument();
  });

  it("changes a Blob's avatar from Edit Profile", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    await user.click(screen.getByRole("button", { name: "Ken settings" }));
    const panel = screen.getByRole("complementary", { name: "Ken settings" });
    // The grids live behind the avatar now, so the write path starts there.
    await user.click(within(panel).getByRole("button", { name: "Edit avatar" }));
    await user.click(within(panel).getByRole("radio", { name: "red" }));
    await user.click(within(panel).getByRole("radio", { name: "egg" }));

    await flushWrites();
    const roster = await loadRoster();
    expect(roster?.[0]).toMatchObject({ tone: "red", shape: "egg" });
  });

  it("keeps the details panel hidden until opened from the chat header", async () => {
    const user = userEvent.setup();
    render(<App />);
    await createFirstBlob(user, "Ken");

    // Hidden by default; only the monitor button reveals it.
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    expect(screen.getByRole("complementary", { name: "Ken details" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide details panel" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});

describe("onboarding", () => {
  it("is off by default, so the rest of the suite sees the app", () => {
    // The setup file seeds this through localStorage. CI's jsdom provides one
    // and the local build does not, and a shim that skipped the provided one
    // seeded a Map nothing read: green locally, every other test drowned in
    // the onboarding overlay on CI.
    expect(readPreference("pref:onboarded", "false")).toBe("true");
  });

  /** Undo the suite default: this describe is about the un-onboarded app. */
  function clearOnboarded() {
    window.localStorage.removeItem("pref:onboarded");
    window.localStorage.removeItem("pref:plugins");
  }

  it("walks a first run through to the app's own Blob creator", async () => {
    const user = userEvent.setup();
    clearOnboarded();
    render(<App />);

    // Scoped to the flow throughout: the app it covers has a creator pane
    // carrying some of the same labels.
    const flow = () => within(screen.getByRole("dialog", { name: "Welcome to Blobbies" }));
    await user.click(flow().getByRole("button", { name: /Get started/ }));

    // What a Blob is, then the profile steps (name, timezone), then
    // permissions: notifications are never requested on render, only from
    // Allow.
    expect(flow().getByRole("heading", { name: "Every Blob gets one job" })).toBeInTheDocument();
    await user.click(flow().getByRole("button", { name: "Next" }));
    expect(
      flow().getByRole("heading", { name: "Who are your Blobs working for?" }),
    ).toBeInTheDocument();
    await user.click(flow().getByRole("button", { name: "Next" }));
    expect(flow().getByRole("heading", { name: "What time is it for you?" })).toBeInTheDocument();
    await user.click(flow().getByRole("button", { name: "Next" }));
    expect(flow().getByRole("heading", { name: "A few things to settle" })).toBeInTheDocument();
    await user.click(flow().getByRole("button", { name: "Next" }));

    // Tinfoil is optional, but only through Skip. Next is not a second way
    // past an empty field: someone who pressed it would believe they had set
    // something up, and find out at the first model that will not answer.
    expect(flow().getByLabelText("API key")).toHaveValue("");
    expect(flow().getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(flow().getByRole("button", { name: /Skip, I'll use the local model/ }));
    expect(await getSecret("tinfoil-api-key")).toBeNull();

    // Composio is optional in the same way. One button, not two paths: the key
    // field is the fallback for when browser sign-in cannot work, so it stays
    // hidden until sign-in has actually failed — offered up front, it read as
    // "log in, THEN fetch a key, THEN paste it": three chores for one click.
    expect(flow().getByRole("button", { name: "Log in" })).toBeEnabled();
    expect(flow().queryByLabelText("Composio API key")).not.toBeInTheDocument();
    // Skip is still the only way past, and the primary button stays shut.
    expect(flow().getByRole("button", { name: "Make your first Blob" })).toBeDisabled();
    // And it is the last step: picking plugins is not part of setup, because
    // it asks which apps you want before you have a Blob to use them with.
    // The Plugins modal owns that list.
    expect(flow().queryByLabelText("Search plugins")).not.toBeInTheDocument();

    // Skipping hands over to the real creator rather than carrying a second
    // copy of it, so the Blob is made by the same code every other path uses.
    await user.click(flow().getByRole("button", { name: /Skip, I'll connect my apps later/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const creator = screen.getByRole("region", { name: "New Blob" });

    await user.type(within(creator).getByLabelText("Name"), "Ken");
    await user.click(within(creator).getByRole("button", { name: "Get started" }));
    expect(await screen.findByRole("heading", { name: "Ken", level: 1 })).toBeInTheDocument();

    await flushWrites();
    expect((await loadRoster())?.[0]).toMatchObject({ name: "Ken" });
    // Completed once is completed for good.
    expect(window.localStorage.getItem("pref:onboarded")).toBe("true");
  });

  it("refuses a malformed Tinfoil key instead of storing it", async () => {
    const user = userEvent.setup();
    clearOnboarded();
    render(<App />);

    const flow = () => within(screen.getByRole("dialog", { name: "Welcome to Blobbies" }));
    await user.click(flow().getByRole("button", { name: /Get started/ }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: "Next" }));

    // What a fumbled paste looks like: the env-var name dragged along with
    // the value. Nothing may reach the keychain.
    await user.type(flow().getByLabelText("API key"), "TINFOIL_API_KEY=tk_abc");
    await user.click(flow().getByRole("button", { name: "Save" }));
    expect(await getSecret("tinfoil-api-key")).toBeNull();
    expect(flow().getByRole("status")).toHaveTextContent(/does not look like a key/);

    // A clean key is accepted and kept.
    await user.clear(flow().getByLabelText("API key"));
    await user.type(flow().getByLabelText("API key"), "tk_abcdefghijklmnop");
    await user.click(flow().getByRole("button", { name: "Save" }));
    expect(await getSecret("tinfoil-api-key")).toBe("tk_abcdefghijklmnop");
  });

  it("steps back to the previous screen", async () => {
    const user = userEvent.setup();
    clearOnboarded();
    render(<App />);

    const flow = () => within(screen.getByRole("dialog", { name: "Welcome to Blobbies" }));
    await user.click(flow().getByRole("button", { name: /Get started/ }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    expect(flow().getByRole("heading", { name: "A few things to settle" })).toBeInTheDocument();

    await user.click(flow().getByRole("button", { name: "Back" }));
    expect(flow().getByRole("heading", { name: "What time is it for you?" })).toBeInTheDocument();
  });

  it("opens the creator on a replay, where a roster already exists", async () => {
    // A replay with Blobs already on disk, so its exit
    // cannot rely on the empty-roster fallback that renders the creator.
    await flushRoster([seedBlob(1, "Ken")]);
    const user = userEvent.setup();
    clearOnboarded();
    render(<App />);

    const flow = () => within(screen.getByRole("dialog", { name: "Welcome to Blobbies" }));
    await user.click(flow().getByRole("button", { name: /Get started/ }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: /Skip, I'll use the local model/ }));
    // Composio is the last step, so declining it ends the flow.
    await user.click(flow().getByRole("button", { name: /Skip, I'll connect my apps later/ }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "New Blob" })).toBeInTheDocument();
  });

  it("saves the name and timezone chosen during the flow", async () => {
    const user = userEvent.setup();
    clearOnboarded();
    window.localStorage.removeItem("pref:userName");
    window.localStorage.removeItem("pref:timezone");
    render(<App />);

    const flow = () => within(screen.getByRole("dialog", { name: "Welcome to Blobbies" }));
    await user.click(flow().getByRole("button", { name: /Get started/ }));
    await user.click(flow().getByRole("button", { name: "Next" }));

    // Name is committed on Next, trimmed, so agents never meet the padding.
    // Cleared first: the field offers the stored name as a starting point.
    await user.clear(flow().getByLabelText("Your name"));
    await user.type(flow().getByLabelText("Your name"), "  Nova  ");
    await user.click(flow().getByRole("button", { name: "Next" }));

    // Timezone starts at auto-detect and stays there until a zone is picked.
    expect(flow().getByLabelText("Timezone")).toHaveValue("auto");
    await user.selectOptions(flow().getByLabelText("Timezone"), "Europe/Berlin");
    await user.click(flow().getByRole("button", { name: "Next" }));
    // The rest of the flow is declined, which must not un-write the profile.
    await user.click(flow().getByRole("button", { name: "Next" }));
    await user.click(flow().getByRole("button", { name: /Skip, I'll use the local model/ }));
    await user.click(flow().getByRole("button", { name: /Skip, I'll connect my apps later/ }));

    expect(window.localStorage.getItem("pref:userName")).toBe("Nova");
    expect(window.localStorage.getItem("pref:timezone")).toBe("Europe/Berlin");
  });

  it("replays for VITE_ONBOARDING without writing a preference", async () => {
    // Registered before the stub: a failed assertion below must not leave
    // the flag set for every test that follows.
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    // The dev flag behind `VITE_ONBOARDING=1 pnpm tauri dev`, which is how
    // the flow is reopened in the Tauri window (no editable URL there).
    vi.stubEnv("VITE_ONBOARDING", "1");
    // The suite default marks the app onboarded; the flag must win.
    render(<App />);
    await settleBoot();

    expect(screen.getByRole("dialog", { name: "Welcome to Blobbies" })).toBeInTheDocument();
    // Replaying is not completing: the completed flag is untouched.
    expect(window.localStorage.getItem("pref:onboarded")).toBe("true");
  });

  it("is skipped once completed, and replayed once by the dev button", async () => {
    const user = userEvent.setup();
    // The suite default marks the app onboarded.
    const { unmount } = render(<App />);
    await settleBoot();
    expect(screen.queryByRole("dialog", { name: "Welcome to Blobbies" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Ken Kai/ }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Replay" }));

    // Visible where it was triggered — and, being momentary, never again on
    // the next launch, no matter how the replay ends.
    expect(screen.getByRole("dialog", { name: "Welcome to Blobbies" })).toBeInTheDocument();
    unmount();
    render(<App />);
    await settleBoot();
    expect(screen.queryByRole("dialog", { name: "Welcome to Blobbies" })).not.toBeInTheDocument();
  });
});
