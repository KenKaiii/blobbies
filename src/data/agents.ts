/**
 * Domain types for Blobs, messages and routines, plus seed data. Blobs start
 * empty; the first-run creator makes the first one.
 */

// Type-only, so this never becomes a runtime cycle (attachments → blob-tools
// → this module).
import type { Attachment } from "@/lib/attachments";

export type AvatarTone =
  | "purple"
  | "blue"
  | "green"
  | "teal"
  | "brown"
  | "orange"
  | "gold"
  | "red"
  | "pink"
  | "gray";

export type AgentShape =
  | "sphere"
  | "droplet"
  | "cloud"
  | "egg"
  | "pebble"
  | "triangle"
  | "squircle";

export interface Agent {
  id: string;
  name: string;
  /** Legacy display string; superseded by lastActivityAt when present. */
  time: string;
  /** Epoch ms of the newest message, drives the sidebar timestamp. */
  lastActivityAt?: number;
  snippet: string;
  tone: AvatarTone;
  shape: AgentShape;
  unread?: boolean;
  /** Pinned Blobs leave the list for the tray of avatar tiles at the top. */
  pinned?: boolean;
  /**
   * Name of the group this Blob sits in — which is also its membership of
   * that group's chat. Anything that is not a current group name — absent,
   * empty, or a deleted group — reads as the ungrouped run above them, so
   * removing a group never strands its Blobs.
   */
  section?: string;
  /** Hidden Blobs stay in the roster but are not listed in the sidebar. */
  hidden?: boolean;
  /** Lasting facts the Blob saved via its remember tool. */
  memories?: import("@/lib/blob-tools").BlobMemory[];
  /** Short role line, e.g. "Handles my inbox". */
  title?: string;
  /** Longer free-form purpose notes. */
  description?: string;
  /**
   * Hand-written role, used verbatim in place of the generated title +
   * description section. Set from Settings; nothing writes it automatically.
   */
  instructions?: string;
  /**
   * Lifetime tokens through the agent loop, accumulated at each run's end.
   * Local inference has no bill — this exists to explain why replies slow
   * down as a conversation grows, not to price anything.
   */
  usage?: { inputTokens: number; outputTokens: number; runs: number };
  /** Notify when the agent finishes or needs input. Defaults on. */
  notifications?: boolean;
}

export interface TextSegment {
  text: string;
  /** Rendered as an inline link-colored reference (e.g. a Slack channel). */
  accent?: boolean;
}

export type Message =
  | {
      id: string;
      kind: "text";
      author: "user" | "agent";
      segments: TextSegment[];
      /**
       * Which Blob said it, in a group chat where several do. Absent in a
       * one-to-one conversation, where the Blob is the one in the header.
       */
      authorId?: string;
      /** Preview of the message this one replies to, shown quoted in the bubble. */
      replyTo?: string;
      /** Id of the message this one replies to; routes a group reply to its author. */
      replyToId?: string;
      /** Epoch ms when the message was created. Absent on legacy entries. */
      timestampMs?: number;
      /**
       * Set when this agent message is a mid-run question: "question" renders
       * a highlighted card, "action" an amber "needs you" card with a Done
       * button. The next user message answers it.
       */
      ask?: "question" | "action";
      /**
       * Files the user attached to this message. Metadata only: the text
       * lives in the Blob's home folder and is read back per turn, so a
       * transcript never carries a copy of the file (see lib/attachments).
       */
      attachments?: Attachment[];
    }
  | {
      id: string;
      kind: "file";
      author: "agent";
      fileName: string;
      meta: string;
      timestampMs?: number;
    }
  | {
      /** System status line in the transcript, e.g. a routine firing. */
      id: string;
      kind: "event";
      text: string;
      timestampMs?: number;
    };

export interface Routine {
  id: string;
  name: string;
  /** What the Blob should do each time the routine runs. */
  instruction: string;
  /** Trigger labels, e.g. "Every hour" or "Slack message". */
  triggers: string[];
  active: boolean;
  /** When to fire automatically; absent = manual-only routine. */
  schedule?: import("@/lib/schedule").RoutineSchedule;
  /** Epoch ms of the next scheduled fire; the scheduler claims it via CAS. */
  nextRunAt?: number;
  /** Epoch ms of the last completed fire. */
  lastRunAt?: number;
  lastRunStatus?: "done" | "failed" | "cancelled";
}

/** Hard cap for Blob names so sidebar rows and headers never truncate oddly. */
export const MAX_BLOB_NAME_LENGTH = 24;

/**
 * Ceiling on the roster, enforced on every creation path (+ button, Duplicate,
 * `spawn_blob`).
 *
 * Not a storage limit — a blast radius. A routine that loops on spawn_blob
 * would otherwise fill the sidebar with junk Blobs the user has to delete one
 * by one, and every Blob is a scheduler participant.
 *
 * Lives here, not in lib/blob-tools: the sidebar and creator must not
 * statically import that module (startup-bundle budget).
 */
export const MAX_BLOBS = 25;

/**
 * Names a Blob may not take, because `@`-addressing already means something
 * else with them. `@everyone` addresses the room, so a Blob called that could
 * never be reached on its own.
 */
const RESERVED_BLOB_NAMES = ["everyone"];

/**
 * A Blob name nothing else is using, suffixed if need be ("Scout 2").
 *
 * Names are the addressing key: `@Scout` resolves by name, so two Blobs
 * sharing one leaves the second permanently unmentionable — the first match
 * wins and the user has no way to say which they meant. Uniqueness is
 * case-insensitive because the matcher is.
 *
 * `taken` is every OTHER Blob's name; a rename that keeps its own name must
 * not have to fight itself for it.
 *
 * An empty name is returned untouched rather than given a default: the rename
 * field passes through "" on its way to a new name, and inventing one there
 * would type over the user.
 */
export function uniqueBlobName(wanted: string, taken: readonly string[]): string {
  const base = wanted.trim().slice(0, MAX_BLOB_NAME_LENGTH);
  if (base === "") {
    return base;
  }
  const used = new Set([...taken.map((name) => name.trim().toLowerCase()), ...RESERVED_BLOB_NAMES]);
  if (!used.has(base.toLowerCase())) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    // Trimmed to fit the cap WITH its suffix, so a long name does not get
    // sliced back onto the very name it is trying to avoid.
    const tail = ` ${suffix}`;
    const candidate = `${base.slice(0, MAX_BLOB_NAME_LENGTH - tail.length).trim()}${tail}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/** Blobs start empty; the first-run creator makes the first one. */
export const agents: Agent[] = [];

/**
 * Model-facing development memory seeds.
 *
 * These must remain empty. Dev builds run real models against real local data,
 * so plausible sample facts become prompt instructions and the assistant states
 * them as facts about the person using the app. UI tests must own any visual
 * fixtures instead of putting fake identity, location, family, or schedule data
 * into a live prompt.
 */
export const SAMPLE_MEMORIES: import("@/lib/blob-tools").BlobMemory[] = [];

/** Shared model-facing seeds follow the same no-invented-user-data rule. */
export const SAMPLE_USER_MEMORIES: import("@/lib/blob-tools").BlobMemory[] = [];

export const transcripts: Record<string, Message[]> = {};

/** Greeting shown in a fresh conversation (and as the initial snippet). */
export const GREETING = "What do you need me to do?";

/** Fallback transcript for agents without a seeded conversation. */
export function transcriptFor(agent: Agent): Message[] {
  const seeded = transcripts[agent.id];
  if (seeded !== undefined) {
    return seeded;
  }
  // Fixed text, not agent.snippet: the snippet follows the latest activity,
  // and the greeting must not echo it.
  return [
    {
      id: `${agent.id}-status`,
      kind: "text",
      author: "agent",
      segments: [{ text: GREETING }],
    },
  ];
}
