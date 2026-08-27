import type { Agent } from "@/data/agents";
import { type Group, groupConversationId } from "@/lib/groups";

export type ChannelKind = "channel" | "dm";

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** Member Blob ids, in speaking order. Resolved against the live roster. */
  memberIds: string[];
  /** Set on the one-way import from a group chat, for the sidebar note. */
  importedFrom?: string;
  /** Replies landed while the user was in another conversation. */
  unread?: boolean;
  /** Number of persisted replies keyed by root channel message id. */
  threadReplyCounts?: Record<string, number>;
}

/** Conversation id prefix, mirroring `groupConversationId`. */
export function channelConversationId(id: string): string {
  return `channel:${id}`;
}

export function threadConversationId(channelId: string, messageId: string): string {
  return `channel:${channelId}:thread:${messageId}`;
}

export function threadFromConversation(
  conversationId: string,
): { channelId: string; messageId: string } | null {
  const match = /^channel:([^:]+):thread:([^:]+)$/.exec(conversationId);
  return match === null ? null : { channelId: match[1] ?? "", messageId: match[2] ?? "" };
}

/** Parses only base channel ids; thread ids deliberately fail closed. */
export function channelIdFromConversation(conversationId: string): string | null {
  const match = /^channel:([^:]+)$/.exec(conversationId);
  return match?.[1] ?? null;
}

export const MAX_CHANNEL_MEMBERS = 8;

/**
 * A channel's members, in its own order — the order they answer in. Unlike a
 * group, membership is ids the channel owns, so deleted or hidden Blobs simply
 * drop out (same audit rule as groups: an invisible member cannot speak in a
 * room the user is watching).
 */
export function membersOfChannel(channel: Channel, roster: readonly Agent[]): Agent[] {
  const byId = new Map(roster.map((agent) => [agent.id, agent]));
  return channel.memberIds
    .map((id) => byId.get(id))
    .filter((agent): agent is Agent => agent !== undefined && agent.hidden !== true)
    .slice(0, MAX_CHANNEL_MEMBERS);
}

/**
 * One-way import: each group becomes a channel with a FRESH id and the
 * group's current members — the group, its name-keyed membership and its
 * transcript are left untouched, so turning the lab off loses nothing.
 * Membership resolution is the caller's (App owns `membersOf`, because it
 * reads the live roster ref).
 */
export function importGroupsAsChannels(
  groups: readonly Group[],
  members: (group: Group) => readonly Agent[],
): Channel[] {
  return groups.map((group) => ({
    id: crypto.randomUUID(),
    name: group.name,
    kind: "channel",
    memberIds: members(group).map((member) => member.id),
    importedFrom: groupConversationId(group.id),
  }));
}

export function findDirectMessage(
  channels: readonly Channel[],
  memberId: string,
): Channel | undefined {
  return channels.find(
    (channel) =>
      channel.kind === "dm" && channel.memberIds.length === 1 && channel.memberIds[0] === memberId,
  );
}

export function createDirectMessage(member: Agent): Channel {
  return { id: crypto.randomUUID(), name: member.name, kind: "dm", memberIds: [member.id] };
}

/** Validate editable persisted data and default legacy rows to ordinary channels. */
export function normalizeChannels(value: unknown): Channel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Channel[] => {
    if (entry === null || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const kind =
      row.kind === "dm"
        ? "dm"
        : row.kind === undefined || row.kind === "channel"
          ? "channel"
          : null;
    if (
      kind === null ||
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      !Array.isArray(row.memberIds) ||
      !row.memberIds.every((id) => typeof id === "string") ||
      (kind === "dm" && row.memberIds.length !== 1)
    )
      return [];
    return [{ ...(row as unknown as Channel), kind }];
  });
}
