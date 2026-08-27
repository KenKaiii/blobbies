import type { Agent } from "@/data/agents";
import { type Group, groupConversationId } from "@/lib/groups";

/**
 * Channels (Labs): rooms with explicit membership, the successor to
 * name-keyed group chats. A group's members are whichever Blobs carry its
 * name in `section`; a channel's are an id list it owns itself, so a Blob can
 * sit in many channels and leaving one touches nothing but the channel.
 *
 * Deliberately minimal for the first Labs release: no per-message threads yet
 * (the reply affordance in a transcript covers quoting), and a DM is just a
 * one-member channel — the composer's @mention routing does the rest.
 */
export interface Channel {
  id: string;
  name: string;
  /** Member Blob ids, in speaking order. Resolved against the live roster. */
  memberIds: string[];
  /** Set on the one-way import from a group chat, for the sidebar note. */
  importedFrom?: string;
  /** Replies landed while the user was in another conversation. */
  unread?: boolean;
}

/** Conversation id prefix, mirroring `groupConversationId`. */
export function channelConversationId(id: string): string {
  return `channel:${id}`;
}

/** The channel half of `groupIdFromConversation` (which stays group-only). */
export function channelIdFromConversation(conversationId: string): string | null {
  const id = conversationId.replace(/^channel:/, "");
  return id === conversationId ? null : id;
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
    memberIds: members(group).map((member) => member.id),
    importedFrom: groupConversationId(group.id),
  }));
}
