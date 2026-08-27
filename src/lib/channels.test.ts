import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/data/agents";
import {
  channelConversationId,
  channelIdFromConversation,
  createDirectMessage,
  findDirectMessage,
  membersOfChannel,
  normalizeChannels,
  threadConversationId,
  threadFromConversation,
} from "@/lib/channels";

const CHANNEL_ID = "8e0a1b2c-3d4e-5f60-7a8b-9c0d1e2f3a4b";
const MESSAGE_ID = "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const BLOB_ID = "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea";
const blob: Agent = {
  id: BLOB_ID,
  name: "Ken",
  time: "Now",
  snippet: "Hello",
  tone: "red",
  shape: "pebble",
};

describe("channels", () => {
  it("builds and parses base and thread conversation ids without overlap", () => {
    const threadId = threadConversationId(CHANNEL_ID, MESSAGE_ID);
    expect(threadId).toBe(`channel:${CHANNEL_ID}:thread:${MESSAGE_ID}`);
    expect(threadFromConversation(threadId)).toEqual({
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
    });
    expect(channelIdFromConversation(threadId)).toBeNull();
    expect(channelIdFromConversation(channelConversationId(CHANNEL_ID))).toBe(CHANNEL_ID);
  });

  it("normalizes legacy channels and rejects malformed persisted rows", () => {
    expect(normalizeChannels([{ id: CHANNEL_ID, name: "ops", memberIds: [BLOB_ID] }])).toEqual([
      { id: CHANNEL_ID, name: "ops", memberIds: [BLOB_ID], kind: "channel" },
    ]);
    expect(normalizeChannels([{ id: CHANNEL_ID, name: "bad", kind: "dm", memberIds: [] }])).toEqual(
      [],
    );
    expect(normalizeChannels({ nope: true })).toEqual([]);
  });

  it("resolves visible members and deduplicates direct messages", () => {
    const hidden = { ...blob, id: "hidden", hidden: true };
    const dm = { id: CHANNEL_ID, name: blob.name, memberIds: [BLOB_ID], kind: "dm" as const };
    expect(membersOfChannel(dm, [hidden, blob])).toEqual([blob]);
    expect(findDirectMessage([dm], BLOB_ID)).toBe(dm);

    vi.spyOn(crypto, "randomUUID").mockReturnValue(CHANNEL_ID);
    expect(createDirectMessage(blob)).toEqual(dm);
    vi.restoreAllMocks();
  });
});
