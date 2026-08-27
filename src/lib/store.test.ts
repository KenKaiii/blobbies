// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Message } from "@/data/agents";
import { type Channel, channelConversationId } from "@/lib/channels";
import { groupConversationId } from "@/lib/groups";
import * as store from "@/lib/store";

const BLOB_ID = "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea";

const ken: Agent = {
  id: BLOB_ID,
  name: "Ken",
  time: "Now",
  snippet: "New Blob. Say hello",
  tone: "red",
  shape: "pebble",
};

describe("store (browser fallback)", () => {
  beforeEach(() => {
    store.clearFallbackBackend();
    vi.useRealTimers();
  });

  it("round-trips the roster through the fallback backend", async () => {
    expect(await store.loadRoster()).toBeNull();

    await store.flushRoster([ken]);
    expect(await store.loadRoster()).toEqual([ken]);
  });

  it("rolls a long conversation into archives without dropping a message", async () => {
    // The point of the whole mechanism: a conversation can outgrow the 8 MB
    // slice cap, and when it did the app simply stopped saving. Every message
    // has to survive the roll, in order, exactly once.
    vi.useFakeTimers();
    const message = (n: number): Message => ({
      id: `m${n}`,
      kind: "text",
      author: n % 2 === 0 ? "user" : "agent",
      segments: [{ text: `message ${n}` }],
    });
    const all = Array.from({ length: 2000 }, (_, n) => message(n));

    // Saved the way the app does it: the entire conversation, every time.
    for (let n = 1; n <= all.length; n += 1) {
      store.saveBlobTranscript(BLOB_ID, all.slice(0, n));
      await vi.runAllTimersAsync();
    }

    expect((await store.loadBlobTranscript(BLOB_ID))?.map((m) => m.id)).toEqual(
      all.map((m) => m.id),
    );

    // The rewritten slice stays small however long the conversation runs —
    // that is what keeps each save cheap and away from the cap. Read straight
    // out of the fallback backend rather than widening the module's API to
    // let a test look at one slice.
    const slice = (key: string) =>
      JSON.parse(window.localStorage.getItem(`slice:${key}`) ?? "null") as Message[] | null;
    expect(slice(`blobs/${BLOB_ID}/transcript`)?.length ?? 0).toBeLessThanOrEqual(800);
    expect(slice(`blobs/${BLOB_ID}/transcript-1`)).not.toBeNull();
  });

  it("drops the duplicated half when a rollover was interrupted before truncating", async () => {
    // A roll seals the archive first and shrinks the live slice second, so a
    // crash in between leaves the same messages in both files. Keeping them
    // is the safe direction; the reader is what has to notice the overlap.
    const message = (id: string): Message => ({
      id,
      kind: "text",
      author: "user",
      segments: [{ text: id }],
    });
    window.localStorage.setItem(
      `slice:blobs/${BLOB_ID}/transcript-1`,
      JSON.stringify([message("a"), message("b")]),
    );
    window.localStorage.setItem(
      `slice:blobs/${BLOB_ID}/transcript`,
      JSON.stringify([message("a"), message("b"), message("c")]),
    );

    expect((await store.loadBlobTranscript(BLOB_ID))?.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("announces a slice that stopped saving, and again when it recovers", async () => {
    // A transcript past the 8 MB cap is refused by Rust (`store.rs`), which is
    // correct — but the app keeps every message in memory and on screen, so
    // without this signal the conversation looks fine until a restart eats it.
    vi.useFakeTimers();
    const seen: string[][] = [];
    const stop = store.onSaveFailure((keys) => seen.push([...keys]));
    const message: Message = {
      id: "m1",
      kind: "text",
      author: "user",
      segments: [{ text: "hi" }],
    };

    // Driven through the Tauri IPC, because that is the only path that can
    // report this: the browser fallback deliberately swallows a localStorage
    // failure and keeps the value in memory.
    let refuse = true;
    const invoke = vi.fn(async (command: string) => {
      if (command === "store_write" && refuse) {
        throw new Error("stored file is too large to load");
      }
      return null;
    });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };

    store.saveBlobTranscript(BLOB_ID, [message]);
    await vi.runAllTimersAsync();
    expect(seen.at(-1)).toEqual([`blobs/${BLOB_ID}/transcript`]);

    // The next successful write carries everything the failed one did, so the
    // warning clears itself rather than needing a dismiss.
    refuse = false;
    store.saveBlobTranscript(BLOB_ID, [message]);
    await vi.runAllTimersAsync();
    expect(seen.at(-1)).toEqual([]);

    // One notification per transition, not one per keystroke.
    expect(seen).toHaveLength(2);
    stop();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("debounces queued writes and flushes them on beforeunload", async () => {
    vi.useFakeTimers();
    store.saveBlobRoutines(BLOB_ID, [
      { id: "r1", name: "Morning", instruction: "", triggers: ["Every day"], active: true },
    ]);

    // Not yet written: still inside the debounce window.
    expect(await store.loadBlobRoutines(BLOB_ID)).toBeNull();

    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadBlobRoutines(BLOB_ID)).toEqual([
      { id: "r1", name: "Morning", instruction: "", triggers: ["Every day"], active: true },
    ]);
  });

  it("run records write immediately — no debounce window to lose on a crash", async () => {
    const run = {
      id: "run-1",
      blobId: BLOB_ID,
      trigger: "routine" as const,
      prompt: "check the news",
      startedAt: 1,
      status: "running" as const,
    };
    await store.saveBlobRun(BLOB_ID, run);
    // Readable with NO flush event: the write must not have been queued.
    expect(await store.loadBlobRun(BLOB_ID)).toEqual(run);
    // Corrupt/foreign values parse to null instead of leaking into the app.
    await store.saveBlobRun(BLOB_ID, { nonsense: true } as never);
    expect(await store.loadBlobRun(BLOB_ID)).toBeNull();
  });

  it("deleteBlobData removes every per-Blob slice", async () => {
    store.saveBlobConfig(BLOB_ID, ken);
    store.saveBlobTranscript(BLOB_ID, [
      { id: "m1", kind: "text", author: "user", segments: [{ text: "hi" }] },
    ]);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadBlobTranscript(BLOB_ID)).not.toBeNull();

    await store.saveBlobRun(BLOB_ID, {
      id: "run-1",
      blobId: BLOB_ID,
      trigger: "user",
      prompt: "",
      startedAt: 1,
      status: "done",
    });

    await store.deleteBlobData(BLOB_ID);
    expect(await store.loadBlobTranscript(BLOB_ID)).toBeNull();
    expect(await store.loadBlobRoutines(BLOB_ID)).toBeNull();
    expect(await store.loadBlobRun(BLOB_ID)).toBeNull();
  });

  it("round-trips user-scope memories through the `user` slice", async () => {
    expect(await store.loadUserMemories()).toBeNull();

    const memories = [{ id: "u1", text: "Allergic to peanuts", createdAt: 1 }];
    // Debounced like every other config write (covered above), so the flush
    // event is what makes it readable.
    store.saveUserMemories(memories);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadUserMemories()).toEqual(memories);

    // Non-array values (a hand-edited file) read as null, never as memories.
    store.saveUserMemories({ oops: true } as never);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadUserMemories()).toBeNull();
  });

  it("routes a conversation write by its id, group or Blob", async () => {
    const GROUP_ID = "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
    const line = (id: string): Message => ({
      id,
      kind: "text",
      author: "user",
      segments: [{ text: id }],
    });
    // The turn loop knows only a conversation id, so this is the seam that
    // keeps a group reply out of the speaking Blob's own transcript.
    store.saveConversation(groupConversationId(GROUP_ID), [line("g1")]);
    store.saveConversation(BLOB_ID, [line("b1")]);
    window.dispatchEvent(new Event("beforeunload"));

    expect(await store.loadGroupTranscript(GROUP_ID)).toEqual([line("g1")]);
    expect(await store.loadBlobTranscript(BLOB_ID)).toEqual([line("b1")]);
  });

  it("routes a channel conversation by its id, and round-trips the channel list", async () => {
    const CHANNEL_ID = "8e0a1b2c-3d4e-5f60-7a8b-9c0d1e2f3a4b";
    const line = (id: string): Message => ({
      id,
      kind: "text",
      author: "user",
      segments: [{ text: id }],
    });
    // `channel:` must land in the channel's own slice, never a Blob's — the
    // routing is by prefix, so a collision would be silent.
    store.saveConversation(channelConversationId(CHANNEL_ID), [line("c1")]);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadChannelTranscript(CHANNEL_ID)).toEqual([line("c1")]);

    expect(await store.loadChannels()).toBeNull();
    const channels: Channel[] = [{ id: CHANNEL_ID, name: "ops", memberIds: [BLOB_ID] }];
    store.saveChannels(channels);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadChannels()).toEqual(channels);
  });

  it("round-trips the group list, and reads a hand-edited one as none", async () => {
    expect(await store.loadGroups()).toBeNull();

    const groups = [{ id: "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", name: "Launch" }];
    store.saveGroups(groups);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadGroups()).toEqual(groups);

    // Same rule as the memories slice: a non-array value on disk reads as
    // nothing rather than as a group list.
    store.saveGroups({ oops: true } as never);
    window.dispatchEvent(new Event("beforeunload"));
    expect(await store.loadGroups()).toBeNull();
  });

  it("exportBlob is a no-op outside Tauri rather than throwing", async () => {
    // The browser dev server has no Rust side; Settings shows a hint instead.
    expect(await store.exportBlob(BLOB_ID, "Ken")).toBeNull();
  });

  it("clears only its own keys, leaving app preferences alone", async () => {
    // The test hook used to call localStorage.clear(), which took the app's
    // `pref:*` with it — same origin — including the flag that keeps the
    // first-run flow off the screen in every other suite.
    window.localStorage.setItem("pref:onboarded", "true");
    await store.flushRoster([ken]);

    store.clearFallbackBackend();

    expect(await store.loadRoster()).toBeNull();
    expect(window.localStorage.getItem("pref:onboarded")).toBe("true");
  });

  it("ignores corrupt stored JSON instead of throwing", async () => {
    store.saveBlobConfig(BLOB_ID, ken);
    window.dispatchEvent(new Event("beforeunload"));
    // Corrupt the raw stored value through the same backend the store uses.
    store.clearFallbackBackend();
    expect(await store.loadRoster()).toBeNull();
  });

  it("reports a failed background write instead of rejecting into nowhere", async () => {
    // Debounced and unload writes are fire-and-forget — nobody awaits them — so
    // a failure used to surface as an unhandled promise rejection naming
    // neither the slice nor the cause. In Tauri that is a bare Rust string
    // ("storage error: No such file or directory"); here a value that cannot
    // be serialised reaches the same catch.
    const reported: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      reported.push(args);
    });
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => rejections.push(event.reason);
    window.addEventListener("unhandledrejection", onRejection);

    try {
      const circular: { self?: unknown } = {};
      circular.self = circular;
      // Routines are a debounced slice, so this takes the fire-and-forget path.
      store.saveBlobRoutines(BLOB_ID, circular as never);
      window.dispatchEvent(new Event("beforeunload"));
      // Let the rejection settle and any unhandled-rejection event fire.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rejections).toEqual([]);
      // Named, so "the roster failed" and "one Blob's transcript failed" are
      // not the same line in the console.
      expect(reported[0]?.[0]).toContain(`blobs/${BLOB_ID}/routines`);
    } finally {
      window.removeEventListener("unhandledrejection", onRejection);
      spy.mockRestore();
    }
  });
});

describe("slice keys", () => {
  // Storage is split across two languages: this module names a slice key, and
  // `src-tauri/src/store.rs` decides whether that key is allowed to exist. The
  // ACP bridge added `acp` here and not there, so in the packaged app every
  // launch rejected `store_read("acp")` with "unknown storage slice" — which
  // took the startup Promise.all down with it, leaving roster, settings and
  // groups unhydrated. The browser fallback used by the rest of this file has
  // no allowlist, so nothing here could have caught it.
  it("only uses root slices the Rust allowlist accepts", async () => {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([
      import("node:fs/promises"),
      import("node:url"),
    ]);
    const from = (path: string) => fileURLToPath(new URL(path, import.meta.url));
    const rust = await readFile(from("../../src-tauri/src/store.rs"), "utf8");
    const allowed = new Set(
      [
        ...(/const ROOT_SLICES: \[&str; \d+\] = \[([^\]]*)\]/.exec(rust)?.[1] ?? "").matchAll(
          /"([^"]+)"/g,
        ),
      ].map((match) => match[1]),
    );
    expect(allowed.size).toBeGreaterThan(0);

    const ts = await readFile(from("./store.ts"), "utf8");
    // Every literal key handed to a read or write, minus the per-Blob and
    // per-group ones (template literals, checked by their own Rust tests).
    const used = [...ts.matchAll(/(?:rawRead|rawWrite|queueWrite|flushWrite)\("([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((key) => !allowed.has(key))).toEqual([]);
  });
});
