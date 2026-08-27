import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatPane } from "@/components/ChatPane";
import type { Agent, Message } from "@/data/agents";
import type { PickedFile } from "@/lib/attachments";
import * as store from "@/lib/store";

/** Revealing a file is an OS call; what matters here is that it is asked for. */
const revealFile = vi.fn(async (_path: string) => {});
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  revealFile: (path: string) => revealFile(path),
}));

const agent: Agent = {
  id: "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea",
  name: "Ken",
  time: "Now",
  snippet: "New Blob. Say hello",
  tone: "blue",
  shape: "sphere",
};

const messages: Message[] = [
  { id: "m1", kind: "text", author: "user", segments: [{ text: "So what can you do" }] },
  { id: "m2", kind: "text", author: "agent", segments: [{ text: "Plenty." }] },
];
/** ChatPane with everything that is not under test held constant. */
const pane = (
  thinking: boolean,
  onStop: () => void,
  withMessages: Message[] = [],
  onSend: (
    text: string,
    options?: { replyTo?: string; replyToId?: string; files?: readonly PickedFile[] },
  ) => void = () => {},
) => (
  <ChatPane
    agent={agent}
    messages={withMessages}
    thinking={thinking}
    model=""
    onModelChange={() => {}}
    reasoning={false}
    onReasoningChange={() => {}}
    onSend={onSend}
    onStop={onStop}
    detailOpen={false}
    onToggleDetail={() => {}}
    onOpenSettings={() => {}}
  />
);

/**
 * End the jelly pop on a row, the way the browser does.
 *
 * jsdom implements no `AnimationEvent`, so React's feature detection falls
 * back to the prefixed `webkitAnimationEnd` there while a real browser fires
 * `animationend`. Both are dispatched so this asserts the app's behaviour
 * rather than jsdom's.
 */
const endPop = (target: Element, animationName = "message-jelly") => {
  for (const type of ["animationend", "webkitAnimationEnd"]) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "animationName", { value: animationName });
    act(() => {
      target.dispatchEvent(event);
    });
  }
};

describe("ChatPane", () => {
  it("uses persistent thread actions and counts only when requested", async () => {
    const onOpenThread = vi.fn();
    const { rerender } = render(pane(false, vi.fn(), [messages[0] as Message]));
    expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument();

    rerender(
      <ChatPane
        agent={agent}
        messages={[messages[0] as Message]}
        onOpenThread={onOpenThread}
        threadReplyCounts={{ m1: 2 }}
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open thread" }));
    expect(onOpenThread).toHaveBeenCalledWith(messages[0]);
    expect(screen.getByRole("button", { name: "2 replies" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reply" })).not.toBeInTheDocument();
  });

  it("turns the send circle into Stop while replying, and takes Escape", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const { rerender } = render(pane(false, onStop));

    // Idle: the circle is Send (disabled until something is typed), and
    // nothing offers to stop.
    expect(screen.queryByRole("button", { name: "Stop replying" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    rerender(pane(true, onStop));
    // The thinking blob is a status only; the control lives in the composer,
    // where the same circle that started the turn now ends it.
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    const stop = screen.getByRole("button", { name: "Stop replying" });
    // The red styling hangs off this attribute, so it must be the string CSS
    // matches, not a dropped boolean.
    expect(stop).toHaveAttribute("data-stop", "true");
    await user.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(onStop).toHaveBeenCalledTimes(2);

    // Unlistened once the reply lands: Escape belongs to the composer again.
    rerender(pane(false, onStop));
    await user.keyboard("{Escape}");
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("suppresses the latched hover on every row the cursor has left", () => {
    render(pane(false, vi.fn(), messages));
    const [first, second] = screen
      .getAllByRole("toolbar", { name: "Message actions" })
      // The bar lives inside .message-line beside its bubble; the state it
      // asserts (message-row-stale) is on the row above that.
      .map((toolbar) => toolbar.closest(".message-row") as HTMLElement);
    const move = (over: HTMLElement) => fireEvent.pointerOver(over, { bubbles: true });

    // Before the cursor has entered anything, nothing is suppressed: plain
    // :hover still reveals, so this can never subtract the actions entirely.
    expect(first).not.toHaveClass("message-row-stale");
    expect(second).not.toHaveClass("message-row-stale");

    move(first as HTMLElement);
    expect(first).not.toHaveClass("message-row-stale");
    expect(second).toHaveClass("message-row-stale");

    // Cursor moves on: the row left behind is suppressed even though no leave
    // event ever fired for it, so two bars can't show at once.
    move(second as HTMLElement);
    expect(first).toHaveClass("message-row-stale");
    expect(second).not.toHaveClass("message-row-stale");

    // Off the rows entirely (another pane fires nothing on the row at all).
    move(document.body);
    expect(second).toHaveClass("message-row-stale");

    // Cursor leaves the window — no move event lands anywhere.
    move(second as HTMLElement);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(second).toHaveClass("message-row-stale");
  });

  it("marks the transcript with a time divider after a silence or a day change, not every message", () => {
    // 09:00, a reply seconds later, then 09:20 after a silence, then the next
    // day — the shape a real conversation takes.
    const day1 = new Date(2026, 7, 12, 9, 0).getTime();
    render(
      pane(false, vi.fn(), [
        {
          id: "t1",
          kind: "text",
          author: "user",
          segments: [{ text: "morning" }],
          timestampMs: day1,
        },
        {
          id: "t2",
          kind: "text",
          author: "agent",
          segments: [{ text: "hi" }],
          timestampMs: day1 + 4_000,
        },
        {
          id: "t3",
          kind: "text",
          author: "user",
          segments: [{ text: "back now" }],
          timestampMs: day1 + 20 * 60_000,
        },
        {
          id: "t4",
          kind: "text",
          author: "agent",
          segments: [{ text: "welcome back" }],
          timestampMs: day1 + 26 * 60 * 60_000,
        },
      ]),
    );
    const dividers = screen.getAllByText(/AM|PM|August|Wednesday/i, {
      selector: ".timestamp-divider",
    });
    // One above the first message, one after the 20-minute silence, one for
    // the new day — and none between the seconds-apart pair.
    expect(dividers).toHaveLength(3);
    expect(dividers[0]?.textContent).toMatch(/9:00/);
    expect(dividers[1]?.textContent).toMatch(/9:20/);
    expect(dividers[2]?.textContent).toMatch(/Wednesday|Thursday/);
  });

  it("attaches picked files to the next message, and lets one be removed", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(pane(false, vi.fn(), [], onSend));

    const keep = new File(["columns"], "data.csv", { type: "text/csv" });
    const drop = new File(["draft"], "notes.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Attach files"), [keep, drop]);

    // Both chips show; removing one leaves the other attached.
    expect(screen.getByText("data.csv")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove notes.md" }));
    expect(screen.queryByText("notes.md")).not.toBeInTheDocument();

    // Files alone are a message: no typing needed for Send to appear.
    await user.click(screen.getByRole("button", { name: "Send message" }));
    // Sent clears the composer on the same frame, however long the thumbnails
    // take — so the next message cannot resend this file.
    expect(screen.queryByText("data.csv")).not.toBeInTheDocument();
    // The send waits for the thumbnail (jsdom renders none, so the file goes
    // on its own) and hands the file over with it, not bare.
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("", { files: [{ file: keep }] }));
  });

  it("gives a table its own bubble, so it is not squeezed by the prose around it", () => {
    const reply = [
      "Here you go:",
      "",
      "| Date | Model |",
      "| --- | --- |",
      "| Aug 14 | GLM-5.3 |",
      "",
      "Anything else?",
    ].join("\n");
    render(
      pane(false, vi.fn(), [
        { id: "t1", kind: "text", author: "agent", segments: [{ text: reply }] },
      ]),
    );

    // One message, three bubbles: prose, the table on its own, prose.
    const stack = document.querySelector(".bubble-stack") as HTMLElement;
    expect(stack.querySelectorAll(":scope > .bubble")).toHaveLength(3);
    expect(stack.querySelectorAll(".bubble-table")).toHaveLength(1);
    // The table bubble holds the table and nothing else.
    const table = stack.querySelector(".bubble-table") as HTMLElement;
    expect(within(table).getByRole("table")).toBeInTheDocument();
    expect(table.textContent).not.toMatch(/Anything else/);
  });

  it("leaves a reply without a table as a single bubble", () => {
    render(
      pane(false, vi.fn(), [
        { id: "t1", kind: "text", author: "agent", segments: [{ text: "Just words." }] },
      ]),
    );
    const stack = document.querySelector(".bubble-stack") as HTMLElement;
    expect(stack.querySelectorAll(":scope > .bubble")).toHaveLength(1);
    expect(stack.querySelector(".bubble-table")).toBeNull();
  });

  it("offers Blobs whose name has a space, all the way through typing it", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const social: Agent = { ...agent, id: "social", name: "Social Blob" };
    const news: Agent = { ...agent, id: "news", name: "AI News Blob" };
    render(
      <ChatPane
        agent={agent}
        group={{ id: "g1", name: "Launch", members: [social, news] }}
        messages={[]}
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={onSend}
        onStop={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    const field = screen.getByRole("textbox", { name: "Message Launch" });

    // A bare "@" lists everyone available — the menu is how you learn who is
    // in the room without memorising names.
    await user.type(field, "@");
    expect(screen.getByRole("button", { name: "Social Blob" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI News Blob" })).toBeInTheDocument();
    // Nothing highlighted yet: with a first option pre-selected the list reads
    // as a choice already made before the user expressed one.
    expect(document.querySelectorAll(".composer-mention-active")).toHaveLength(0);

    // Almost every real Blob name has a space in it. The menu has to survive
    // typing one, or it disappears halfway through the name it completes.
    await user.type(field, "Soc");
    // And the colour arrives with the word, not on its last character: once
    // only one Blob can complete what is typed, it is already that colour.
    expect(document.querySelector(".composer-mirror .mention")?.textContent).toBe("@Soc");

    await user.type(field, "ial B");
    expect(screen.queryByRole("button", { name: "AI News Blob" })).not.toBeInTheDocument();
    // Narrowing IS the preference, so now the best match is highlighted and
    // Enter takes it.
    expect(document.querySelectorAll(".composer-mention-active")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(field).toHaveValue("@Social Blob ");

    // The coloured mirror renders the draft as you type, so a mention is in
    // its Blob's colour before the message is even sent.
    expect(document.querySelector(".composer-mirror .mention")?.textContent).toBe("@Social Blob");

    // And prose after an @ closes the menu rather than latching it open.
    await user.type(field, "mail me @ later today");
    expect(screen.queryByRole("button", { name: "Social Blob" })).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("@Social Blob mail me @ later today", {});
  });

  it("in a group, names the speaker and completes an @mention", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const zed: Agent = { ...agent, id: "zed", name: "Zed" };
    render(
      <ChatPane
        agent={agent}
        group={{ id: "g1", name: "Launch", members: [agent, zed] }}
        messages={[
          {
            id: "m1",
            kind: "text",
            author: "agent",
            authorId: zed.id,
            segments: [{ text: "Done." }],
          },
        ]}
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={onSend}
        onStop={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    // Several Blobs share the transcript, so a reply that does not say who
    // sent it is unreadable.
    expect(screen.getByText("Done.").closest(".message-row")).toHaveTextContent("Zed");
    // No attach button: a file is saved in one Blob's home folder, and a group
    // has none of its own.
    expect(screen.queryByLabelText("Attach files")).not.toBeInTheDocument();

    // Typing "@Z" offers the member; Enter completes rather than sending a
    // half-typed mention that would address nobody.
    const field = screen.getByRole("textbox", { name: "Message Launch" });
    await user.type(field, "@Z");
    expect(screen.getByRole("button", { name: "Zed" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(field).toHaveValue("@Zed ");

    await user.keyboard("take it{Enter}");
    expect(onSend).toHaveBeenCalledWith("@Zed take it", {});
  });

  it("labels a Blob's bubble with its name alone, no second avatar", () => {
    const zed: Agent = { ...agent, id: "zed", name: "Zed", tone: "pink" };
    render(
      <ChatPane
        agent={agent}
        group={{ id: "g1", name: "Launch", members: [agent, zed] }}
        messages={[
          {
            id: "m1",
            kind: "text",
            author: "agent",
            authorId: zed.id,
            segments: [{ text: "done" }],
          },
        ]}
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    const label = document.querySelector(".message-author");
    expect(label?.textContent).toBe("Zed");
    // The avatar is the @mention's job — pointing at a Blob mid-sentence. Here
    // it would repeat down every run of messages from one speaker.
    expect(label?.querySelector("svg")).toBeNull();
  });

  it("colours an @mention in the mentioned Blob's own colour, both ways", () => {
    const zed: Agent = { ...agent, id: "zed", name: "Zed", tone: "pink" };
    render(
      <ChatPane
        agent={agent}
        group={{ id: "g1", name: "Launch", members: [agent, zed] }}
        messages={[
          { id: "m1", kind: "text", author: "user", segments: [{ text: "@Zed take this" }] },
          {
            id: "m2",
            kind: "text",
            author: "agent",
            authorId: agent.id,
            segments: [{ text: "On it. @Zed draft it once I'm done." }],
          },
        ]}
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    // Both bubble kinds: the user's words render verbatim, a Blob's through
    // markdown, and an unhighlighted mention in either would misreport who
    // is being addressed.
    const mentions = document.querySelectorAll(".mention");
    // The Blob's face replaces the "@", so the name stands alone. Kept
    // identical across the two paths — the same mention rendering differently
    // in a user bubble and a reply would read as two different things.
    expect([...mentions].map((node) => node.textContent)).toEqual(["Zed", "Zed"]);
    for (const node of mentions) {
      expect(node).toHaveClass("mention-with-avatar");
      // Its own avatar, not a generic dot: same silhouette and tone the
      // sidebar draws for that Blob.
      expect(node.querySelector("svg.blob-avatar")).not.toBeNull();
      // Two colours, not one: the theme flips without React re-rendering the
      // transcript, so CSS — not JS — has to choose between them.
      const style = node.getAttribute("style") ?? "";
      expect(style).toContain("--mention-on-light");
      expect(style).toContain("--mention-on-dark");
    }
  });

  it("leaves an @ alone in a one-to-one chat, where it addresses nobody", () => {
    render(
      <ChatPane
        agent={agent}
        messages={[
          {
            id: "m1",
            kind: "text",
            author: "user",
            segments: [{ text: "mail me @ ken@x.example" }],
          },
        ]}
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    expect(document.querySelectorAll(".mention")).toHaveLength(0);
  });

  it("keeps Send reachable mid-reply, so a follow-up can steer the turn", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(pane(true, onStop));

    await user.type(screen.getByRole("textbox", { name: "Message Ken" }), "actually, in French");
    // A typed draft is a follow-up: the circle goes back to Send, never a
    // dead Stop that swallows the message the user just wrote.
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop replying" })).not.toBeInTheDocument();
  });

  it("opens another conversation at its bottom instantly, never on a glide", () => {
    // The chat shooting upward out of sight when clicking into another
    // session. `prevMessageCount` belongs to the conversation being left, so
    // switching to a longer one whose last line is the user's own (sent, then
    // clicked away) read as "the user just sent a message" and glided there.
    // A smooth scroll animates toward the extent it measured when it started,
    // while the incoming transcript is still settling into a shorter one — so
    // it sails past the end into blank, and only a real scroll re-clamps it.
    const other: Agent = { ...agent, id: "9b0f0ac6-6b7c-4c33-8a0e-0b7b3e1d2f44", name: "Robin" };
    const longer: Message[] = [
      ...messages,
      { id: "m3", kind: "text", author: "agent", segments: [{ text: "Ask away." }] },
      { id: "m4", kind: "text", author: "user", segments: [{ text: "one sec" }] },
    ];
    const { rerender } = render(pane(false, vi.fn(), messages));
    const el = document.querySelector(".message-scroll");
    expect(el).not.toBeNull();
    if (el === null) return;
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
    Object.defineProperty(el, "scrollHeight", { get: () => 1200, configurable: true });

    rerender(
      <ChatPane
        agent={other}
        messages={longer}
        thinking={false}
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: "instant" });
    for (const call of scrollTo.mock.calls) {
      expect(call[0]).not.toMatchObject({ behavior: "smooth" });
    }
  });

  it("pops in the first message sent to a brand new Blob", async () => {
    // A Blob with no history looks exactly like one whose transcript has not
    // loaded yet — both are an empty pane. The pane waits for stored messages
    // before deciding what counts as "already on screen", so on a new Blob it
    // would still be waiting when the user's own first message arrived, take
    // it for history, and skip the pop-in every later message gets. Sending is
    // the signal that settles it: you cannot type into a conversation that has
    // not opened.
    const user = userEvent.setup();
    const onSend = vi.fn();
    const blank: Agent = { ...agent, id: "2b6e1d94-3f52-4a8b-b0c7-9d4e5f6a7b81" };
    const paneFor = (withMessages: Message[]) => (
      <ChatPane
        agent={blank}
        messages={withMessages}
        thinking={false}
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={onSend}
        onStop={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />
    );
    const { rerender } = render(paneFor([]));

    await user.type(screen.getByRole("textbox", { name: "Message Ken" }), "hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalled();

    // The app echoes the sent message back through props.
    const sent: Message[] = [
      { id: "s1", kind: "text", author: "user", segments: [{ text: "hello" }] },
    ];
    rerender(paneFor(sent));

    expect(document.querySelectorAll(".message-fresh")).toHaveLength(1);
  });

  it("opens a conversation whose transcript lands a render later, still at its bottom", () => {
    // The blank pane, and why it came and went. `App` hydrates a Blob's
    // transcript from disk in an effect, so clicking a session renders this
    // pane EMPTY first and the messages arrive one or more renders later — but
    // only when that Blob is cold. Open it a second time and the transcript is
    // already in memory, so it switches in a single pass and nothing is wrong.
    //
    // The switch was treated as that single pass. By the time the transcript
    // landed the pane had stopped considering itself "opening", so a history
    // whose last line is the user's own (sent, then clicked away) read as "the
    // user just sent a message" and glided to it — a smooth scroll toward an
    // extent measured while the transcript was still laying out, which sails
    // past the end into blank and stays there until a stray scroll re-clamps.
    const other: Agent = { ...agent, id: "1f3c9a02-77d8-4f0e-9c31-2a5b6e8d4c10", name: "Robin" };
    const longer: Message[] = [
      ...messages,
      { id: "m3", kind: "text", author: "agent", segments: [{ text: "Ask away." }] },
      { id: "m4", kind: "text", author: "user", segments: [{ text: "one sec" }] },
    ];
    const paneFor = (who: Agent, withMessages: Message[]) => (
      <ChatPane
        agent={who}
        messages={withMessages}
        thinking={false}
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />
    );
    const { rerender } = render(pane(false, vi.fn(), messages));
    const el = document.querySelector(".message-scroll");
    expect(el).not.toBeNull();
    if (el === null) return;
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
    Object.defineProperty(el, "scrollHeight", { get: () => 1200, configurable: true });

    // Clicked into the other session: selected, but nothing hydrated yet.
    rerender(paneFor(other, []));
    // Disk hands the transcript over a beat later.
    rerender(paneFor(other, longer));

    for (const call of scrollTo.mock.calls) {
      expect(call[0]).not.toMatchObject({ behavior: "smooth" });
    }
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: "instant" });

    // And the transcript it just loaded is history, not new arrivals: every
    // row playing the pop-in animation at once is the same wrong premise
    // showing itself visually.
    expect(document.querySelectorAll(".message-fresh")).toHaveLength(0);
  });

  it("rebuilds the transcript's rendering after a resize, keeping its place", () => {
    // The paint lane, which is a different bug from every scroll fix above.
    //
    // A ⌘⇧D probe reading taken while the pane was blank on the reporter's
    // machine (release build, 1080x728 @ dpr 2) showed geometry was already
    // perfect: drift=0, gap=0, scrollTop === max, every on-screen row opaque,
    // and the fault survived a layout flush. The rows were positioned exactly
    // where they belong and had not been drawn.
    //
    // The mechanism is not a guess. The reporter tried the candidates live on
    // a blank pane: an opacity compositing layer did nothing, `translateZ(0)`
    // did nothing, and detaching the scroller from the render tree brought
    // the whole transcript back. So re-compositing an existing layer is not
    // enough — the renderer has to be destroyed and rebuilt.
    //
    // Two invariants here, and the second is the one that would hurt a user:
    // `display: none` resets scrollTop, so the position must come back, and
    // the scroll event that restore fires must not be mistaken for the user
    // scrolling to the top (which would page in history every repair).
    vi.useFakeTimers();
    const callbacks: (() => void)[] = [];
    class FakeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      render(pane(false, vi.fn(), messages));
      const el = document.querySelector(".message-scroll");
      expect(el).not.toBeNull();
      if (el === null) return;
      if (!(el instanceof HTMLElement)) return;

      const VIEWPORT = 200;
      const HEIGHT = 1000;
      let top = HEIGHT - VIEWPORT;
      Object.defineProperty(el, "scrollHeight", { get: () => HEIGHT, configurable: true });
      Object.defineProperty(el, "clientHeight", { get: () => VIEWPORT, configurable: true });
      Object.defineProperty(el, "scrollTop", {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, HEIGHT - VIEWPORT));
        },
        configurable: true,
      });
      el.scrollTo = ((options: ScrollToOptions) => {
        top = Math.max(0, Math.min(options.top ?? top, HEIGHT - VIEWPORT));
      }) as unknown as typeof el.scrollTo;

      // Every display value the element passes through, so a re-render that
      // never happens and one that never restores both fail.
      const seenDisplay: string[] = [];
      const realSet = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "display");
      Object.defineProperty(el.style, "display", {
        get: () => realSet?.get?.call(el.style) ?? "",
        set: (value: string) => {
          seenDisplay.push(value);
          realSet?.set?.call(el.style, value);
        },
        configurable: true,
      });

      const drainOneFrame = () => {
        const due = frames.splice(0);
        act(() => {
          for (const cb of due) cb(0);
        });
      };

      // Mounting also re-renders — opening a conversation is the other half of
      // the report. Drain that first and assert on it separately, or the
      // resize below is checked against the mount's work and passes even when
      // the resize path does nothing at all.
      for (let guard = 0; frames.length > 0 && guard < 10; guard += 1) {
        drainOneFrame();
      }
      expect(seenDisplay).toContain("none");
      expect(el.style.display).toBe("");
      seenDisplay.length = 0;

      // Now the sidebar's width transition, on its own.
      act(() => {
        for (const callback of callbacks) callback();
      });
      act(() => {
        vi.advanceTimersByTime(320);
      });
      for (let guard = 0; frames.length > 0 && guard < 10; guard += 1) {
        drainOneFrame();
      }

      // The renderer was torn down — that is the repair.
      expect(seenDisplay).toContain("none");
      // ...and put back. Anything else leaves the chat invisible for real.
      expect(el.style.display).toBe("");
      // And the reader is still where they were, not thrown to the top by the
      // detach.
      expect(top).toBe(HEIGHT - VIEWPORT);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("puts the transcript back instantly after a repair, never on a glide", () => {
    // Why the blank pane kept coming back after the repair shipped.
    //
    // `.message-scroll` sets `scroll-behavior: smooth` in CSS, and per spec an
    // *assignment* to `scrollTop` obeys it — every other correction in this
    // file goes through `scrollTo({ behavior: "instant" })` for exactly that
    // reason. The repair's restore did not, so detaching the scroller (which
    // resets scrollTop to 0) started a smooth glide from the top of the
    // transcript back down to where the reader was:
    //
    //   • the glide outlives `rerenderingRef`, which clears after one frame,
    //     so its scroll events land as "the user scrolled up" — the pane stops
    //     pinning the bottom and raises the jump pill on its own,
    //   • it passes `scrollTop < 200` on the way down and pages in another 50
    //     messages, growing the content under an animation already aimed at
    //     the old extent,
    //   • and it lands against an extent measured before that growth — the
    //     stale-extent blank the repair exists to cure, re-created by the
    //     repair itself. Longer transcript, longer glide, more damage, which
    //     is why it returned after a long back-and-forth and on every session
    //     opened afterwards.
    //
    // The old test modelled `scrollTop = x` as landing instantly, so it could
    // not see any of this. Here the setter animates, like the browser's.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      render(pane(false, vi.fn(), messages));
      const el = document.querySelector(".message-scroll");
      expect(el).not.toBeNull();
      if (!(el instanceof HTMLElement)) return;

      const VIEWPORT = 200;
      const HEIGHT = 1000;
      const clamp = (value: number) => Math.max(0, Math.min(value, HEIGHT - VIEWPORT));
      let top = HEIGHT - VIEWPORT;
      // Set by the smooth path: a position the pane asked for that has NOT
      // arrived, and will crawl there over the coming frames.
      let gliding: number | null = null;
      Object.defineProperty(el, "scrollHeight", { get: () => HEIGHT, configurable: true });
      Object.defineProperty(el, "clientHeight", { get: () => VIEWPORT, configurable: true });
      Object.defineProperty(el, "scrollTop", {
        get: () => top,
        // The CSS behaviour: an assignment animates.
        set: (value: number) => {
          gliding = clamp(value);
        },
        configurable: true,
      });
      el.scrollTo = ((options: ScrollToOptions) => {
        if (options.behavior === "smooth") {
          gliding = clamp(options.top ?? top);
          return;
        }
        gliding = null;
        top = clamp(options.top ?? top);
      }) as unknown as typeof el.scrollTo;

      // Opening the conversation runs the repair; drain its frames.
      for (let guard = 0; frames.length > 0 && guard < 10; guard += 1) {
        const due = frames.splice(0);
        act(() => {
          for (const cb of due) cb(0);
        });
      }

      // Detaching reset the position to 0 in a real browser; by the time the
      // repair returns, the reader must already be back where they were — not
      // watching the whole transcript slide past.
      expect(gliding).toBeNull();
      expect(top).toBe(HEIGHT - VIEWPORT);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops dressing a row for the jelly pop once it has popped", () => {
    // The pop is the row's arrival, so it belongs to the row's first moment.
    // A CSS animation replays whenever its element is re-inserted into the
    // DOM, so a class left on forever means every later reflow — a divider
    // appearing above, any re-layout while the agent works — re-pops every row
    // still wearing it: the whole live part of the transcript jiggling for as
    // long as the turn ran.
    const { rerender } = render(pane(false, vi.fn(), messages));
    const rowOf = (id: string) => document.querySelector(`[data-message-id="${id}"]`);
    const arrived: Message[] = [
      ...messages,
      { id: "m3", kind: "text", author: "agent", segments: [{ text: "Working on it." }] },
    ];
    rerender(pane(true, vi.fn(), arrived));

    const row = rowOf("m3");
    expect(row).toHaveClass("message-fresh");
    // Rows already on screen when it opened never claimed the animation.
    expect(rowOf("m1")).not.toHaveClass("message-fresh");

    // The pop plays out.
    if (row !== null) {
      endPop(row);
    }
    expect(rowOf("m3")).not.toHaveClass("message-fresh");

    // And it stays retired as the turn goes on — the state the bug lived in.
    rerender(
      pane(true, vi.fn(), [
        ...arrived,
        { id: "m4", kind: "text", author: "agent", segments: [{ text: "Done." }] },
      ]),
    );
    expect(rowOf("m3")).not.toHaveClass("message-fresh");
    // The genuinely new one still gets its pop.
    expect(rowOf("m4")).toHaveClass("message-fresh");
  });

  it("ignores a child's animation ending \u2014 only the row's own arrival retires it", () => {
    // Animations bubble. A reaction badge or an avatar finishing its own
    // animation is not this row arriving, and treating it as one would cut the
    // pop short on a row that had only just appeared.
    const { rerender } = render(pane(false, vi.fn(), messages));
    const arrived: Message[] = [
      ...messages,
      { id: "m3", kind: "text", author: "agent", segments: [{ text: "Working on it." }] },
    ];
    rerender(pane(true, vi.fn(), arrived));
    const bubble = document.querySelector('[data-message-id="m3"] .bubble');
    expect(bubble).not.toBeNull();
    if (bubble !== null) {
      endPop(bubble);
    }
    expect(document.querySelector('[data-message-id="m3"]')).toHaveClass("message-fresh");
  });

  it("does not rebuild the transcript's rendering for each message a turn produces", () => {
    // Why the repair has to be opening-only. Detaching the scroller destroys
    // the renderer of everything inside it, and a rebuilt renderer restarts
    // every CSS animation it holds. The only rows carrying one are the newest
    // — `.message-fresh`, the jelly pop — so running the repair on each
    // arrival made exactly the last user prompt and the Blob's replies pop
    // again on every bubble of a working turn: a transcript flickering for as
    // long as the agent kept talking.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      const { rerender } = render(pane(false, vi.fn(), messages));
      const el = document.querySelector(".message-scroll");
      expect(el).not.toBeNull();
      if (!(el instanceof HTMLElement)) return;
      Object.defineProperty(el, "scrollHeight", { get: () => 1200, configurable: true });
      el.scrollTo = (() => {}) as unknown as typeof el.scrollTo;

      const seenDisplay: string[] = [];
      const realSet = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "display");
      Object.defineProperty(el.style, "display", {
        get: () => realSet?.get?.call(el.style) ?? "",
        set: (value: string) => {
          seenDisplay.push(value);
          realSet?.set?.call(el.style, value);
        },
        configurable: true,
      });
      const drain = () => {
        for (let guard = 0; frames.length > 0 && guard < 10; guard += 1) {
          const due = frames.splice(0);
          act(() => {
            for (const cb of due) cb(0);
          });
        }
      };
      // Opening is allowed its repair; the turn below is measured on its own.
      drain();
      seenDisplay.length = 0;

      // A turn talking: one finished bubble after another, user at the bottom.
      const spoken: Message[] = ["Working on it.", "Read the file.", "Done."].map(
        (text, position) => ({
          id: `b${position}`,
          kind: "text",
          author: "agent",
          segments: [{ text }],
        }),
      );
      for (let count = 1; count <= spoken.length; count += 1) {
        rerender(pane(true, vi.fn(), [...messages, ...spoken.slice(0, count)]));
        drain();
      }

      expect(seenDisplay).not.toContain("none");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not page in history when its own re-render restores the scroll", () => {
    // The sharp edge on the re-render repair. Detaching the scroller resets
    // scrollTop to 0, and putting it back fires a scroll event. Unguarded,
    // that event arrives looking exactly like the user having scrolled to the
    // very top — so every repair would page in another slab of history, and a
    // user toggling the sidebar a few times would silently load the entire
    // transcript.
    vi.useFakeTimers();
    const callbacks: (() => void)[] = [];
    class FakeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      // More messages than one page, so there is history left to page in.
      const many: Message[] = Array.from({ length: 90 }, (_, i) => ({
        id: `p${i}`,
        kind: "text",
        author: i % 2 === 0 ? "agent" : "user",
        segments: [{ text: `Line ${i}` }],
      }));
      render(pane(false, vi.fn(), many));
      const el = document.querySelector(".message-scroll");
      expect(el).not.toBeNull();
      if (el === null) return;
      if (!(el instanceof HTMLElement)) return;

      const shown = () => el.querySelectorAll(".message-row").length;
      const before = shown();
      expect(before).toBeGreaterThan(0);

      const VIEWPORT = 200;
      const HEIGHT = 4000;
      let top = HEIGHT - VIEWPORT;
      Object.defineProperty(el, "scrollHeight", { get: () => HEIGHT, configurable: true });
      Object.defineProperty(el, "clientHeight", { get: () => VIEWPORT, configurable: true });
      Object.defineProperty(el, "scrollTop", {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, HEIGHT - VIEWPORT));
          // Every write fires a scroll event, exactly like a browser.
          el.dispatchEvent(new Event("scroll"));
        },
        configurable: true,
      });
      // jsdom has no layout, so it does not do the one thing that makes this
      // dangerous: a real browser drops the scroll position of an element it
      // removes from the render tree. Without modelling that, the restore
      // writes back the value it already had and nothing is exercised.
      const realDisplay = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "display");
      Object.defineProperty(el.style, "display", {
        get: () => realDisplay?.get?.call(el.style) ?? "",
        set: (value: string) => {
          realDisplay?.set?.call(el.style, value);
          if (value === "none") {
            top = 0;
            el.dispatchEvent(new Event("scroll"));
          }
        },
        configurable: true,
      });
      el.scrollTo = ((options: ScrollToOptions) => {
        el.scrollTop = options.top ?? top;
      }) as unknown as typeof el.scrollTo;

      const drain = () => {
        for (let guard = 0; frames.length > 0 && guard < 10; guard += 1) {
          const due = frames.splice(0);
          act(() => {
            for (const cb of due) cb(0);
          });
        }
      };
      drain();

      // Toggle the sidebar several times: each settle triggers a re-render,
      // and each re-render's restore passes a scrollTop of 0 through the
      // handler on its way back up.
      for (let round = 0; round < 4; round += 1) {
        act(() => {
          for (const callback of callbacks) callback();
        });
        act(() => {
          vi.advanceTimersByTime(320);
        });
        drain();
      }

      // No extra history was revealed by the repair alone.
      expect(shown()).toBe(before);
      // And the reader is still at the bottom, where they were.
      expect(top).toBe(HEIGHT - VIEWPORT);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps the reader where they were when older messages load above", () => {
    // Paging in 50 bubbles adds their height ABOVE the viewport, so leaving
    // scrollTop alone moves every line the reader was looking at down the
    // page. The fix is arithmetic: put back the height that was added.
    const many: Message[] = Array.from({ length: 120 }, (_, i) => ({
      id: `q${i}`,
      kind: "text",
      author: i % 2 === 0 ? "agent" : "user",
      segments: [{ text: `Line ${i}` }],
    }));
    render(pane(false, vi.fn(), many));
    const el = document.querySelector(".message-scroll");
    if (!(el instanceof HTMLElement)) throw new Error("no scroller");

    const shown = () => el.querySelectorAll(".message-row").length;
    const before = shown();
    const VIEWPORT = 200;
    // Each mounted row is worth this much; the grown height is derived from
    // the rows actually rendered, which is what a browser would report.
    const ROW = 40;
    let top = 100;
    Object.defineProperty(el, "scrollHeight", { get: () => shown() * ROW, configurable: true });
    Object.defineProperty(el, "clientHeight", { get: () => VIEWPORT, configurable: true });
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (value: number) => {
        top = value;
      },
      configurable: true,
    });
    el.scrollTo = ((options: ScrollToOptions) => {
      top = options.top ?? top;
    }) as unknown as typeof el.scrollTo;

    const heightBefore = shown() * ROW;
    // Near the top: the page-in trigger.
    act(() => {
      el.scrollTop = 120;
      el.dispatchEvent(new Event("scroll"));
    });

    // Older messages did mount...
    expect(shown()).toBeGreaterThan(before);
    // ...and the viewport moved down by exactly what they added, so the line
    // the reader was on is still under their eyes.
    expect(top).toBe(120 + (shown() * ROW - heightBefore));
  });

  it("lets the re-clamping nudge actually land instead of erasing it", () => {
    // The defect behind four failed fixes, and the reason each one looked
    // right in tests and wrong on the machine.
    //
    // After a width transition WebKit can hand back a stale scroll extent
    // together with a scrollTop produced by that same stale extent: they agree
    // with each other and disagree with the pixels, so the pane shows blank
    // until a stray scroll makes the engine re-clamp. Only a real scroll fixes
    // it — forcing layout does not, because the cached scrollable overflow is
    // not layout.
    //
    // The code knew that and still did nothing, because it wrote the nudge and
    // the intended position in the SAME frame. WebKit coalesces same-frame
    // scroll updates into one commit (verified against WebKit 26.5: that pair
    // fires exactly one scroll event, carrying only the final value), so
    // whenever the target was where we already were — every "already at the
    // bottom" case, the entire reason the nudge exists — net movement was
    // zero and nothing was ever re-clamped.
    //
    // So the invariant is about ORDERING, not position: the nudge must be the
    // last scroll written in its frame.
    vi.useFakeTimers();
    const callbacks: (() => void)[] = [];
    class FakeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      render(pane(false, vi.fn(), messages));
      const el = document.querySelector(".message-scroll");
      expect(el).not.toBeNull();
      if (el === null) return;

      const VIEWPORT = 200;
      const HEIGHT = 1000;
      const bottom = HEIGHT - VIEWPORT;
      let top = bottom; // already sitting at the bottom
      Object.defineProperty(el, "scrollHeight", { get: () => HEIGHT, configurable: true });
      Object.defineProperty(el, "clientHeight", { get: () => VIEWPORT, configurable: true });
      Object.defineProperty(el, "scrollTop", {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, bottom));
        },
        configurable: true,
      });

      // Every scroll write, tagged with the frame it happened in. A frame ends
      // when the rAF queue is drained.
      let frame = 0;
      const writes: { frame: number; top: number }[] = [];
      el.scrollTo = ((options: ScrollToOptions) => {
        const next = options.top ?? top;
        writes.push({ frame, top: next });
        top = Math.max(0, Math.min(next, bottom));
      }) as unknown as typeof el.scrollTo;

      // A resize burst that changes nothing: the transcript is the same height
      // and we are already at the bottom. Nothing to correct — which is
      // precisely when the old code's nudge cancelled itself out.
      act(() => {
        for (const callback of callbacks) callback();
      });
      act(() => {
        vi.advanceTimersByTime(320);
      });

      const settleStart = writes.length;
      act(() => {
        for (let guard = 0; frames.length > 0 && guard < 10; guard += 1) {
          frame += 1;
          for (const cb of frames.splice(0)) cb(0);
        }
      });

      const settleWrites = writes.slice(settleStart);
      expect(settleWrites.length).toBeGreaterThanOrEqual(2);

      // The nudge: a write that is not the final resting position.
      const nudge = settleWrites.find((write) => write.top !== bottom);
      expect(nudge).toBeDefined();
      if (nudge === undefined) return;

      // Nothing may follow it inside its own frame, or the engine coalesces
      // the pair and performs no scroll at all.
      expect(settleWrites.filter((write) => write.frame === nudge.frame)).toHaveLength(1);

      // And it still ends where the reader was: at the bottom.
      expect(settleWrites.at(-1)?.top).toBe(bottom);
      expect(top).toBe(bottom);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("holds the bottom when showing the sidebar reflows the transcript taller", () => {
    // The second reported repro: hiding or showing the sidebar shoots the
    // chat up out of sight, and a small scroll brings it back.
    //
    // A narrower pane wraps the same text into more lines, so the transcript
    // grows *below* a fixed scrollTop and the engine fires a scroll event for
    // it. That event is not the user: it arrives before the ResizeObserver
    // callback for the same frame, and it flips `nearBottom` to false — so the
    // burst's one decision ("was the user following?") reads a flag the
    // reflow itself just falsified, declines to pin, and the newest message
    // is left walked off the top of the viewport.
    vi.useFakeTimers();
    const callbacks: (() => void)[] = [];
    class FakeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      render(pane(false, vi.fn(), messages));
      const el = document.querySelector(".message-scroll");
      expect(el).not.toBeNull();
      if (el === null) return;

      const VIEWPORT = 200;
      let height = 1000;
      let top = height - VIEWPORT;
      const seat = (value: number) => {
        top = Math.max(0, Math.min(value, height - VIEWPORT));
      };
      Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
      Object.defineProperty(el, "clientHeight", { get: () => VIEWPORT, configurable: true });
      Object.defineProperty(el, "scrollTop", {
        get: () => top,
        set: seat,
        configurable: true,
      });
      el.scrollTo = ((options: ScrollToOptions) =>
        seat(options.top ?? top)) as unknown as typeof el.scrollTo;

      // At rest at the bottom, with a real scroll event behind us: this is the
      // honest baseline the pane is allowed to trust.
      fireEvent.scroll(el);

      // The reflow. Same text, narrower pane, more lines — the transcript
      // grows below a scrollTop that has not moved, and the engine fires a
      // scroll event for the geometry change.
      height = 1400;
      fireEvent.scroll(el);
      // The ResizeObserver callback for that same frame, after the event.
      act(() => {
        for (const callback of callbacks) callback();
      });
      act(() => {
        vi.advanceTimersByTime(320);
      });
      act(() => {
        for (let guard = 0; frames.length > 0 && guard < 10; guard += 1) {
          for (const cb of frames.splice(0)) cb(0);
        }
      });

      // Still following the conversation: the newest message is on screen, and
      // no jump arrow is offered over a chat nobody left.
      expect(top).toBe(1400 - VIEWPORT);
      expect(screen.queryByRole("button", { name: "Scroll to bottom" })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("holds the bottom when the sidebar is toggled on a cold session", () => {
    // The two halves of the original report, together, which is how it was
    // actually hit: click a session that has never been opened this run (its
    // transcript arrives a render after mount), then show or hide the right
    // sidebar. Either alone can look fine; the cold open is what poisons the
    // resize that follows.
    //
    // A cold open used to glide, and a glide is *in flight* — it has not
    // landed when the width transition starts. `autoScrollRef` is set for its
    // duration, so every scroll event the reflow fires is swallowed as "our
    // own animation passing through", and the pane enters the burst seated
    // wherever the glide had got to. That is the empty chat: content below the
    // viewport, nothing on screen, until any scroll re-clamps it.
    vi.useFakeTimers();
    const callbacks: (() => void)[] = [];
    class FakeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      const cold: Agent = { ...agent, id: "5c2d8e77-41ab-4f60-9d02-8ea1b6c73f95", name: "Robin" };
      const history: Message[] = [
        ...messages,
        { id: "m3", kind: "text", author: "agent", segments: [{ text: "Ask away." }] },
        { id: "m4", kind: "text", author: "user", segments: [{ text: "one sec" }] },
      ];
      const paneFor = (withMessages: Message[]) => (
        <ChatPane
          agent={cold}
          messages={withMessages}
          thinking={false}
          model=""
          onModelChange={() => {}}
          reasoning={false}
          onReasoningChange={() => {}}
          onSend={() => {}}
          onStop={() => {}}
          detailOpen={true}
          onToggleDetail={() => {}}
          onOpenSettings={() => {}}
        />
      );
      // Mounted with nothing: the session is selected, the disk read is still
      // in flight.
      const { rerender } = render(paneFor([]));
      const el = document.querySelector(".message-scroll");
      expect(el).not.toBeNull();
      if (el === null) return;

      const VIEWPORT = 200;
      let height = VIEWPORT;
      let top = 0;
      const seat = (value: number) => {
        top = Math.max(0, Math.min(value, height - VIEWPORT));
      };
      Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
      Object.defineProperty(el, "clientHeight", { get: () => VIEWPORT, configurable: true });
      Object.defineProperty(el, "scrollTop", { get: () => top, set: seat, configurable: true });
      // A smooth scroll is an animation: it is asked for now and lands later,
      // so it must not move the position within this test's frames. An instant
      // one is a write, and lands immediately. Modelling that difference is
      // the whole point — it is what makes a glide observable as "in flight".
      el.scrollTo = ((options: ScrollToOptions) => {
        if (options.behavior !== "smooth") {
          seat(options.top ?? top);
        }
      }) as unknown as typeof el.scrollTo;

      // The mount's own frames run first, on the empty pane — a disk read is
      // many frames slower than the two this schedules. Draining them after
      // the transcript arrives would let the mount's settling re-pin rescue a
      // conversation it never measured, and the app gets no such rescue.
      const drainFrames = () => {
        act(() => {
          for (let guard = 0; frames.length > 0 && guard < 10; guard += 1) {
            for (const cb of frames.splice(0)) cb(0);
          }
        });
      };
      drainFrames();

      // The transcript lands. Taller than the viewport now, and its last line
      // is the user's own — the shape that used to read as "you just sent a
      // message" and glide.
      height = 1000;
      rerender(paneFor(history));
      drainFrames();
      // Opened at its bottom, on a write rather than an animation.
      expect(top).toBe(1000 - VIEWPORT);

      // Now hide the right sidebar. The pane widens over 260ms; the same text
      // re-wraps into fewer lines, so the transcript SHRINKS under a scrollTop
      // that is already past the new end — the stale-extent case.
      fireEvent.scroll(el);
      height = 700;
      fireEvent.scroll(el);
      act(() => {
        for (const callback of callbacks) callback();
      });
      act(() => {
        vi.advanceTimersByTime(320);
      });
      drainFrames();

      // Sitting on the newest message, on geometry that exists — not parked
      // past the end showing blank, and no jump arrow over a chat nobody left.
      expect(top).toBe(700 - VIEWPORT);
      expect(screen.queryByRole("button", { name: "Scroll to bottom" })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("still lets the user scroll away while a reply is streaming in", () => {
    // The guard above ignores a scroll event whose height changed while the
    // position did not — that is a reflow, not a person. Streaming growth
    // changes the height too, so the pane must not use it to ignore someone
    // deliberately scrolling up mid-reply and yank them back down.
    render(pane(true, vi.fn(), messages));
    const el = document.querySelector(".message-scroll");
    expect(el).not.toBeNull();
    if (el === null) return;

    const VIEWPORT = 200;
    let height = 1000;
    let top = height - VIEWPORT;
    Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(el, "clientHeight", { get: () => VIEWPORT, configurable: true });
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (value: number) => {
        top = value;
      },
      configurable: true,
    });
    el.scrollTo = (() => {}) as unknown as typeof el.scrollTo;

    fireEvent.scroll(el);
    expect(screen.queryByRole("button", { name: "Scroll to bottom" })).not.toBeInTheDocument();

    // A delta lands (height grows) and the user drags upward in the same
    // breath: the position moved, so this is intent however the content
    // shifted underneath it.
    height = 1100;
    top = 300;
    fireEvent.scroll(el);

    expect(screen.getByRole("button", { name: "Scroll to bottom" })).toBeInTheDocument();
  });

  it("clamps a stale scroll extent when a panel resize settles", () => {
    // WebKit (the Tauri webview) can leave scrollTop past the content end
    // after the sidebar's width transition: the per-frame pin reads
    // scrollHeight mid-reflow, and on close the re-wrapped transcript ends
    // up shorter — a blank pane until the user scrolls and the engine
    // re-clamps (seen live, 2026-08-19). jsdom has no layout, so the burst
    // is driven through a stubbed ResizeObserver and faked metrics.
    vi.useFakeTimers();
    const callbacks: (() => void)[] = [];
    class FakeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      render(pane(false, vi.fn()));
      const el = document.querySelector(".message-scroll");
      expect(el).not.toBeNull();
      if (el === null) return;
      const scrollTo = vi.fn();
      // Instance-level: the pane calls el.scrollTo, which jsdom does not
      // implement on elements at all.
      el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
      // The burst pinned to a mid-reflow extent (scrollTop 900); after the
      // transition the content settled shorter (scrollHeight 1000, viewport
      // 200 → real max 800).
      Object.defineProperty(el, "scrollHeight", { get: () => 1000, configurable: true });
      Object.defineProperty(el, "clientHeight", { get: () => 200, configurable: true });
      Object.defineProperty(el, "scrollTop", { get: () => 900, configurable: true });

      act(() => {
        for (const callback of callbacks) callback();
      });
      act(() => {
        vi.advanceTimersByTime(320);
      });
      // The clamp deliberately spans two frames: the nudge has to land on its
      // own before the intended position is written, or WebKit coalesces the
      // pair and performs no scroll at all.
      act(() => {
        for (let guard = 0; frames.length > 0 && guard < 10; guard += 1) {
          for (const cb of frames.splice(0)) cb(0);
        }
      });
      // The settle clamp ends the burst on a position that exists.
      expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "instant" });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("clamps against fresh geometry, not the stale extent it is meant to detect", () => {
    // The bug the clamp above was written for, in its actual shape. WebKit
    // keeps reporting the pre-transition scrollHeight for a beat after the
    // panel's width animation, so a clamp computed from that number is
    // compared against a scrollTop the same staleness produced: `scrollTop >
    // max` reads false, the correction no-ops, and the pane stays blank until
    // a stray scroll makes the engine re-clamp. Reading offsetHeight flushes
    // layout, which is what makes the guard see real geometry.
    //
    // Modelled here as a scrollHeight that reports the stale 1600 until
    // offsetHeight is read, then the settled 900 (viewport 700 → real max
    // 200). A clamp that never flushes computes max 900, finds 900 > 900
    // false, and calls nothing at all.
    vi.useFakeTimers();
    const callbacks: (() => void)[] = [];
    class FakeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      render(pane(false, vi.fn()));
      const el = document.querySelector(".message-scroll");
      expect(el).not.toBeNull();
      if (el === null) return;
      const scrollTo = vi.fn();
      el.scrollTo = scrollTo as unknown as typeof el.scrollTo;

      let flushed = false;
      let reads = 0;
      Object.defineProperty(el, "offsetHeight", {
        get: () => {
          flushed = true;
          return 700;
        },
        configurable: true,
      });
      Object.defineProperty(el, "scrollHeight", {
        get: () => {
          reads += 1;
          return flushed ? 900 : 1600;
        },
        configurable: true,
      });
      Object.defineProperty(el, "clientHeight", { get: () => 700, configurable: true });
      Object.defineProperty(el, "scrollTop", { get: () => 900, configurable: true });

      act(() => {
        for (const callback of callbacks) callback();
      });
      act(() => {
        vi.advanceTimersByTime(320);
      });

      // Layout was flushed before the extent was trusted...
      expect(flushed).toBe(true);
      expect(reads).toBeGreaterThan(0);
      // ...so the pane lands on the only position that still has content.
      // Without the flush this assertion fails: max reads 900, 900 > 900 is
      // false, and scrollTo is never called with the real max.
      expect(scrollTo).toHaveBeenCalledWith({ top: 200, behavior: "instant" });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("settles on real geometry when flushing layout does not refresh the extent", () => {
    // The shape the two tests above get wrong, and the reason the pane still
    // went blank after they were both green.
    //
    // They model WebKit's staleness as something a layout flush cures, so
    // reading offsetHeight is enough to see the settled scrollHeight. Live in
    // the Tauri webview it is not: the scroller caches its scrollable overflow
    // and a flush recomputes layout without rebuilding that cache. The extent
    // stays stale, `scrollTop > max` compares two numbers that agree with each
    // other and disagree with the pixels, the correction no-ops, and the
    // transcript stays pushed up out of view — until the user's small scroll
    // makes the engine rebuild it. That is why the symptom survived the flush.
    //
    // Modelled as an extent that ignores offsetHeight entirely and refreshes
    // only once a scroll actually moves the element: stale 1600 before, the
    // settled 900 after (viewport 700 → real max 200).
    vi.useFakeTimers();
    const callbacks: (() => void)[] = [];
    class FakeObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      render(pane(false, vi.fn()));
      const el = document.querySelector(".message-scroll");
      expect(el).not.toBeNull();
      if (el === null) return;

      let top = 900;
      let moved = false;
      const tops: number[] = [];
      const reportedHeight = () => (moved ? 900 : 1600);
      el.scrollTo = ((options: ScrollToOptions) => {
        if (options.top === undefined) return;
        // Writes clamp against the extent the engine currently believes in —
        // the stale one. This is what defeats the per-frame pin: asking for
        // scrollHeight lands on the stale max, which is where we already are,
        // so nothing moves and nothing is rebuilt.
        const clamped = Math.min(Math.max(0, options.top), reportedHeight() - 700);
        if (clamped !== top) {
          // Only a position that actually changes rebuilds the extent — the
          // engine's rescue is the movement itself, not the measuring near it.
          moved = true;
          top = clamped;
        }
        tops.push(top);
      }) as unknown as typeof el.scrollTo;
      // Deliberately does NOT clear staleness: that is the whole point.
      Object.defineProperty(el, "offsetHeight", { get: () => 700, configurable: true });
      Object.defineProperty(el, "scrollHeight", { get: reportedHeight, configurable: true });
      Object.defineProperty(el, "clientHeight", { get: () => 700, configurable: true });
      Object.defineProperty(el, "scrollTop", { get: () => top, configurable: true });

      act(() => {
        for (const callback of callbacks) callback();
      });
      act(() => {
        vi.advanceTimersByTime(320);
      });

      // Lands on the only position that still has content under it. A settle
      // that merely flushes and compares never calls scrollTo at all here, and
      // leaves the pane sitting at 900 with nothing to show.
      expect(top).toBe(200);
      expect(tops.at(-1)).toBe(200);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("re-pins the instant scroll two frames later, so a stale extent self-heals", async () => {
    // Same WebKit family as the resize clamp: on a conversation switch the
    // instant pin can read scrollHeight mid-swap and land past the settled
    // content — the pushed-up/blank pane until the first user scroll. The
    // fix re-pins on the next-next frame. jsdom has no layout, so frames are
    // driven through stubbed rAF and faked metrics: first pin reads the
    // stale 1200, the settled re-pin reads the true 900.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      const user = userEvent.setup();
      render(pane(false, vi.fn()));
      const el = document.querySelector(".message-scroll");
      expect(el).not.toBeNull();
      if (el === null) return;
      const scrollTo = vi.fn();
      el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
      let height = 1200;
      Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });

      await user.type(screen.getByRole("textbox", { name: "Message Ken" }), "hi{enter}");

      // The user's own message glides (smooth), streaming growth pins
      // (instant): at least one instant pin already happened, reading the
      // stale extent. Now let both frames of the re-pin run past the swap.
      height = 900;
      act(() => {
        // Drain every queued frame, including the one the inner callback
        // schedules once it runs (double-rAF).
        for (let guard = 0; frames.length > 0 && guard < 10; guard += 1) {
          const queued = frames.splice(0);
          for (const cb of queued) cb(0);
        }
      });
      expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "instant" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("holds the transcript still while the composer measures itself", async () => {
    // The jump seen while typing (measured live, 271 position reversals in one
    // typing burst before the fix). Auto-grow measures by setting the
    // textarea's height to `auto`, which on a `rows={1}` field collapses it to
    // a single line rather than resolving to the content height. For that
    // instant the pane above is taller, its max scroll offset is smaller, and
    // the engine clamps scrollTop down to fit. Restoring the height does not
    // undo a clamp — so every keystroke dropped the transcript a line and some
    // later resize sprang it back.
    //
    // jsdom has no layout, so the clamp is modelled where a browser applies
    // it: every time the composer's height changes, the transcript's room is
    // recomputed and any offset past the new end is cut down — and, as in a
    // real engine, putting the height back does not restore the lost offset.
    const user = userEvent.setup();
    render(pane(false, vi.fn(), messages));
    const el = document.querySelector(".message-scroll");
    const textarea = screen.getByRole("textbox", { name: "Message Ken" });
    expect(el).not.toBeNull();
    if (el === null) return;

    const CONTENT = 2000;
    // Collapsed to one line, the composer hands 32px back to the transcript.
    let height = "32px";
    const viewport = () => (height === "auto" ? 512 : 480);
    let top = 0;
    const clamp = () => {
      top = Math.max(0, Math.min(top, CONTENT - viewport()));
    };
    Object.defineProperty(el, "scrollHeight", { get: () => CONTENT, configurable: true });
    Object.defineProperty(el, "clientHeight", { get: () => viewport(), configurable: true });
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, CONTENT - viewport()));
      },
      configurable: true,
    });
    Object.defineProperty(textarea.style, "height", {
      get: () => height,
      set: (value: string) => {
        height = value;
        clamp();
      },
      configurable: true,
    });

    // Parked at the bottom, following the conversation.
    const bottom = CONTENT - viewport();
    el.scrollTop = bottom;

    // Grow: a draft long enough to wrap, typed a character at a time.
    await user.type(textarea, "hey can you take a look at this and tell me what you think");
    expect(top).toBe(bottom);

    // Shrink: the same draft deleted again, which collapses the composer back.
    await user.clear(textarea);
    expect(top).toBe(bottom);
  });

  it("collapses the composer as it sends, not after the bubble has landed", async () => {
    // The insert-then-reposition stutter (measured live in Chromium: the new
    // bubble appeared with the composer still 140px tall, then slid ~80px over
    // the next 16 frames). Clearing the draft alone leaves the collapse to the
    // auto-grow effect, which runs *after* the scroll pin and animates — so
    // the bubble popped in and then rode the transcript growing into the room
    // the composer was giving back. The collapse has to be part of the layout
    // the message arrives into, which means inside the send handler.
    //
    // jsdom has no layout, so the field reports the heights a browser would:
    // a wrapped draft is at the five-line cap, an empty one is a single line.
    const user = userEvent.setup();
    let dispatched: { height: string; expanded: boolean } | undefined;
    render(
      pane(false, vi.fn(), messages, () => {
        dispatched = {
          height: textarea.style.height,
          expanded:
            document.querySelector(".composer")?.classList.contains("composer-expanded") === true,
        };
      }),
    );
    const textarea = screen.getByRole("textbox", { name: "Message Ken" });
    Object.defineProperty(textarea, "scrollHeight", {
      get: () => ((textarea as HTMLTextAreaElement).value.length > 0 ? 112 : 32),
      configurable: true,
    });

    await user.type(textarea, "one{Shift>}{Enter}{/Shift}two{Shift>}{Enter}{/Shift}three");
    // Grown to the cap, with the buttons dropped to their own row.
    expect(textarea.style.height).toBe("112px");
    expect(document.querySelector(".composer")).toHaveClass("composer-expanded");

    await user.type(textarea, "{Enter}");

    // The moment the message goes up: one line already, so the pin that
    // follows measures the extent the bubble will actually live in.
    expect(dispatched?.height).toBe("32px");
    // And the wrapped layout is gone by the commit that draws the bubble,
    // rather than a render later.
    expect(textarea.style.height).toBe("32px");
    expect(document.querySelector(".composer")).not.toHaveClass("composer-expanded");
  });

  it("says so when the conversation has stopped saving", () => {
    // Silence is the dangerous case here: every message is still on screen,
    // so nothing looks wrong until a restart drops the unsaved tail.
    const { rerender } = render(
      <ChatPane
        agent={agent}
        messages={messages}
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(
      <ChatPane
        agent={agent}
        messages={messages}
        notSaving
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    // `alert`, not `status`: a screen reader should interrupt for this.
    expect(screen.getByRole("alert")).toHaveTextContent(/too long to save/i);
    // Says what to do about it, not just that something broke.
    expect(screen.getByRole("alert")).toHaveTextContent(/start a new chat/i);
  });

  it("shows a Blob's screenshot as a card that reveals the real file", async () => {
    // The picture must be visible in the conversation — a capture the user
    // cannot see is the thing this feature must never do — and clicking it
    // opens the full-resolution PNG, which the transcript only thumbnails.
    const user = userEvent.setup();
    const shot: Message[] = [
      {
        id: "m3",
        kind: "text",
        author: "agent",
        segments: [],
        attachments: [
          {
            name: "screenshots/safari.png",
            bytes: 4096,
            label: "Safari — Hacker News.png",
            path: "/Users/ken/.blobbies/blobs/x/home/screenshots/safari.png",
            preview: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      },
    ];
    render(pane(false, () => {}, shot));

    const card = screen.getByRole("button", { name: /Safari — Hacker News/ });
    // The name is on screen, not only in a tooltip: it is what tells the user
    // this is a real file on disk rather than something pasted into the chat.
    expect(card).toHaveTextContent("Safari — Hacker News.png");
    expect(within(card).getByRole("img").getAttribute("src")).toMatch(/^data:image\/png/);

    await user.click(card);
    expect(revealFile).toHaveBeenCalledWith(
      "/Users/ken/.blobbies/blobs/x/home/screenshots/safari.png",
    );
  });

  it("leaves a user's own attached image as a picture, with nothing to open", () => {
    // They already have the original; a reveal button would point at our copy.
    render(
      pane(false, () => {}, [
        {
          id: "m4",
          kind: "text",
          author: "user",
          segments: [{ text: "look at this" }],
          attachments: [
            {
              name: "photo.png.txt",
              bytes: 10,
              label: "photo.png",
              preview: "data:image/png;base64,iVBORw0KGgo=",
            },
          ],
        },
      ]),
    );
    expect(screen.getByRole("img", { name: "photo.png" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /photo.png/ })).not.toBeInTheDocument();
  });
});

describe("switching conversations", () => {
  /** The header alone, with only the Blob varying. */
  const header = (which: Agent) => (
    <ChatPane
      agent={which}
      messages={[]}
      model=""
      onModelChange={() => {}}
      reasoning={false}
      onReasoningChange={() => {}}
      onSend={() => {}}
      detailOpen={false}
      onToggleDetail={() => {}}
      onOpenSettings={() => {}}
    />
  );

  it("keeps the old title on screen so the two slide as one strip", () => {
    // jsdom has no matchMedia, which ChatPane reads as "reduced motion" and
    // skips the ghost entirely. Stub it to the motion-allowed answer, or this
    // asserts the one path it is not about.
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })),
    );
    const other: Agent = { ...agent, id: "b2b0f0d2-1111-4bbb-8ccc-2d3e4f5a6b7c", name: "Nova" };
    const { rerender } = render(header(agent));
    expect(screen.getByRole("heading", { name: "Ken" })).toBeInTheDocument();

    rerender(header(other));
    // Both titles are mounted at once: the outgoing one is what the incoming
    // one slides up past. Drop it and the header just blinks to the new name.
    expect(screen.getByRole("heading", { name: "Nova" })).toBeInTheDocument();
    const ghost = document.querySelector(".chat-header-identity-leaving");
    expect(ghost?.textContent).toContain("Ken");
    // A picture of where you were, not a place to land: announcing it or
    // tabbing into it would be worse than having no animation at all.
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    // Only the live title is in the accessibility tree.
    expect(screen.queryByRole("heading", { name: "Ken" })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("skips the ghost under reduced motion, where it would never animate away", () => {
    const other: Agent = { ...agent, id: "b2b0f0d2-1111-4bbb-8ccc-2d3e4f5a6b7c", name: "Nova" };
    const { rerender } = render(header(agent));
    rerender(header(other));
    // A ghost that never animates is just the old title parked on top of the
    // new one, so it is never mounted at all.
    expect(document.querySelector(".chat-header-identity-leaving")).toBeNull();
    expect(screen.getByRole("heading", { name: "Nova" })).toBeInTheDocument();
  });
});

describe("a created routine", () => {
  it("names the routine in the transcript, with the Routines list's clock", () => {
    render(
      pane(false, () => {}, [
        {
          id: "e1",
          kind: "event",
          text: "Created routine",
          subject: { icon: "routine", label: "Overnight outbound" },
        },
      ]),
    );
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Created routine Overnight outbound");

    // The routine name is its own element, so it can carry the weight and full
    // contrast while the caption around it stays a dim status line. Baked into
    // one string it would all render at one weight.
    const name = line.querySelector(".transcript-event-subject");
    expect(name?.textContent).toBe("Overnight outbound");
    // ...and the caption really is only the caption, not the whole line.
    expect(line.textContent?.replace(name?.textContent ?? "", "").trim()).toBe("Created routine");

    // The dimming hangs off `.transcript-event:has(.transcript-event-subject)`,
    // so a subject inside this element IS the hook — asserted here because
    // jsdom computes no stylesheet and the colour itself cannot be read back.
    expect(line).toHaveClass("transcript-event");
    expect(line.matches(".transcript-event:has(.transcript-event-subject)")).toBe(true);

    // Specifically the clock the Routines list uses, not just any glyph: the
    // point is that a routine looks the same in both places.
    const icon = line.querySelector("svg");
    expect(icon).toHaveClass("lucide-clock");
    // Decorative — the label beside it already says what it means.
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("leaves a plain status line alone, with no icon and no subject", () => {
    render(pane(false, () => {}, [{ id: "e2", kind: "event", text: "Spawned Nova" }]));
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Spawned Nova");
    // No subject, so it keeps the green "work happened" treatment rather than
    // the dim caption — same selector, answered the other way.
    expect(line.matches(".transcript-event:has(.transcript-event-subject)")).toBe(false);
    expect(line.querySelector("svg")).toBeNull();
  });
});

describe("an unsent draft", () => {
  it("is kept while typing and put back when the app comes up again", async () => {
    // The loss it prevents: a half-written message is component state, so a
    // reload — or a crash — threw the sentence away with no way back.
    const saveDrafts = vi.spyOn(store, "saveDrafts").mockImplementation(() => {});
    const user = userEvent.setup();
    const { unmount } = render(pane(false, () => {}));

    await user.type(screen.getByPlaceholderText("Message Ken"), "half a thought");
    expect(saveDrafts).toHaveBeenLastCalledWith({ [agent.id]: "half a thought" });

    // Coming back to it: what was written is what is in the composer.
    unmount();
    vi.spyOn(store, "loadDrafts").mockResolvedValue({ [agent.id]: "half a thought" });
    render(pane(false, () => {}));
    expect(await screen.findByDisplayValue("half a thought")).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("belongs to its own conversation and does not follow the user to another", async () => {
    vi.spyOn(store, "saveDrafts").mockImplementation(() => {});
    vi.spyOn(store, "loadDrafts").mockResolvedValue({ [agent.id]: "for Ken only" });
    const other: Agent = { ...agent, id: "b2b0f0d2-1111-4bbb-8ccc-2d3e4f5a6b7c", name: "Nova" };
    const user = userEvent.setup();
    const { rerender } = render(pane(false, () => {}));
    expect(await screen.findByDisplayValue("for Ken only")).toBeInTheDocument();

    rerender(
      <ChatPane
        agent={other}
        messages={[]}
        model=""
        onModelChange={() => {}}
        reasoning={false}
        onReasoningChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        detailOpen={false}
        onToggleDetail={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    // Nova's composer is empty, and Ken's words are still Ken's.
    expect(screen.getByPlaceholderText("Message Nova")).toHaveValue("");
    await user.type(screen.getByPlaceholderText("Message Nova"), "hi");
    rerender(pane(false, () => {}));
    expect(screen.getByPlaceholderText("Message Ken")).toHaveValue("for Ken only");
    vi.restoreAllMocks();
  });
});

describe("dragging a file onto the composer", () => {
  it("keeps the drop highlight lit while the pointer crosses the parts inside it", () => {
    // WebKit reports a null `relatedTarget` on every dragenter and dragleave
    // (bug 66547, open since 2011), and this app is a WKWebView. Any check
    // that asks "did the pointer land on a child of mine?" is therefore
    // always answered no, and the highlight flickered off every time the file
    // passed over the textarea or a file chip on its way in.
    render(pane(false, () => {}));
    const composer = document.querySelector(".composer");
    const field = screen.getByPlaceholderText("Message Ken");
    if (!(composer instanceof HTMLElement)) throw new Error("no composer");

    const drag = (type: string, on: Element) =>
      fireEvent(on, new Event(type, { bubbles: true, cancelable: true }));

    drag("dragenter", composer);
    expect(composer).toHaveClass("composer-dragging");

    // Onto the textarea inside it: one enter, one leave, still inside.
    drag("dragenter", field);
    drag("dragleave", composer);
    expect(composer).toHaveClass("composer-dragging");

    // And back out of the composer entirely: the highlight goes.
    drag("dragleave", field);
    expect(composer).not.toHaveClass("composer-dragging");
  });
});
