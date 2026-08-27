import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Agent, Message, Routine } from "@/data/agents";
import type { BlobMemory } from "@/lib/blob-tools";
import { type Channel, channelIdFromConversation } from "@/lib/channels";
import { type Group, groupIdFromConversation } from "@/lib/groups";
import type { McpServerConfig } from "@/lib/mcp";
import type { Recap } from "@/lib/recap";
import { type ActiveRun, parseRun } from "@/lib/run-state";
import { isTauri } from "@/lib/tauri";

/**
 * Typed access to the on-disk slice store (Rust side, atomic writes).
 * In a plain browser (dev server, jsdom tests) it falls back to localStorage
 * under the same keys, so behavior is identical without Tauri.
 */

export type BlobSliceName = "config" | "routines" | "transcript" | "runs" | "recap";

export interface Settings {
  userName: string;
  theme: string;
  timezone: string;
  /** Ollama model tag used for chat, e.g. "llama3.2:latest". Empty = unset. */
  model: string;
  plugins: string[];
  /**
   * Local MCP servers. Lives here rather than in a new slice because it is
   * app-wide config, not Blob state — and this file is not a secret store:
   * `parseLoopbackUrl` rejects URLs carrying credentials.
   */
  mcpServers?: McpServerConfig[];
}

/** State of the ACP editor bridge (see lib/acp/host.ts). */
export interface AcpSettings {
  /** Off by default: the listener does not exist until the user says so. */
  enabled: boolean;
  /** Client names approved to connect, as they identified themselves. */
  pairedClients: string[];
}

export interface UiLayout {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  detailOpen: boolean;
}

/** How long edits coalesce before hitting disk. */
const WRITE_DEBOUNCE_MS = 300;

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const pendingValues = new Map<string, unknown>();

/** In-memory fallback when localStorage is unavailable (e.g. jsdom). */
const memoryBackend = new Map<string, string>();

/**
 * Every localStorage key this module has written, so the test hook below can
 * wipe exactly those: `localStorage.clear()` would take the app's own
 * preferences (`pref:*`) with it, and they share the origin.
 */
const writtenKeys = new Set<string>();

function backendGet(key: string): string | null {
  try {
    if (typeof window.localStorage === "object" && window.localStorage !== null) {
      return window.localStorage.getItem(key);
    }
  } catch {
    // fall through to memory
  }
  return memoryBackend.get(key) ?? null;
}

function backendSet(key: string, value: string): void {
  try {
    if (typeof window.localStorage === "object" && window.localStorage !== null) {
      window.localStorage.setItem(key, value);
      writtenKeys.add(key);
      return;
    }
  } catch {
    // fall through to memory
  }
  memoryBackend.set(key, value);
}

function backendRemove(key: string): void {
  try {
    if (typeof window.localStorage === "object" && window.localStorage !== null) {
      window.localStorage.removeItem(key);
      return;
    }
  } catch {
    // fall through to memory
  }
  memoryBackend.delete(key);
}

/** Test hook: wipe the fallback backend, leaving other keys on the origin. */
export function clearFallbackBackend(): void {
  memoryBackend.clear();
  for (const key of writtenKeys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // no localStorage: the memory clear above was enough
    }
  }
  writtenKeys.clear();
  // Where the archive boundary sits is a fact about the files just deleted,
  // so it has to go with them: a stale boundary would slice the next
  // conversation from an offset its storage no longer has.
  sealedTranscripts.clear();
  rollovers.clear();
}

async function rawRead(key: string): Promise<unknown> {
  if (isTauri()) {
    return invoke("store_read", { key });
  }
  const raw = backendGet(`slice:${key}`);
  try {
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function rawWrite(key: string, value: unknown): Promise<void> {
  if (isTauri()) {
    await invoke("store_write", { key, value });
    return;
  }
  backendSet(`slice:${key}`, JSON.stringify(value));
}

/** Slice keys whose most recent write failed. */
const failedKeys = new Set<string>();
const saveFailureListeners = new Set<(keys: ReadonlySet<string>) => void>();

/**
 * Watch for slices that have stopped saving.
 *
 * A failed write is otherwise invisible: the app holds every message in
 * memory and keeps rendering it, so a conversation that no longer persists
 * looks exactly like one that does — until a restart, when everything after
 * the failure is gone. The likeliest cause is a transcript outgrowing
 * `MAX_SLICE_BYTES` (8 MB, enforced in `store.rs`), where refusing the write
 * is correct: a larger file could never be read back, and the next save would
 * overwrite the last good copy. Correct, but worth saying out loud.
 *
 * Returns an unsubscribe function.
 */
export function onSaveFailure(listener: (keys: ReadonlySet<string>) => void): () => void {
  saveFailureListeners.add(listener);
  return () => {
    saveFailureListeners.delete(listener);
  };
}

/** Record a slice's write outcome, notifying only when it actually changes. */
function setFailed(key: string, failed: boolean): void {
  const changed = failed ? !failedKeys.has(key) : failedKeys.delete(key);
  if (failed) {
    failedKeys.add(key);
  }
  // Every keystroke queues a write; re-notifying on each success would
  // re-render subscribers for nothing.
  if (!changed) {
    return;
  }
  for (const listener of saveFailureListeners) {
    listener(failedKeys);
  }
}

/**
 * Start a write nobody is awaiting, and report a failure instead of dropping
 * it on the floor.
 *
 * The debounced and unload paths are fire-and-forget by design — no caller is
 * left to await them. Without this the rejection surfaces as an unhandled
 * promise rejection with a bare Rust string and a stack pointing into this
 * module, which says nothing about which slice failed.
 *
 * Deliberately not a retry: a write that failed here is already superseded by
 * whatever is in memory, and the next change writes the whole slice again.
 * That is also why a later success clears the flag: the next write carries
 * everything the failed one would have.
 */
function startWrite(key: string, value: unknown): void {
  void rawWrite(key, value)
    .then(() => setFailed(key, false))
    .catch((error: unknown) => {
      // Naming the key is the point: "roster" failing and one Blob's transcript
      // failing are very different problems.
      console.error(`Could not save ${key}:`, error);
      setFailed(key, true);
    });
}

/** Write immediately, cancelling any pending debounce for the key. */
async function flushWrite(key: string, value: unknown): Promise<void> {
  const timer = pendingWrites.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingWrites.delete(key);
    pendingValues.delete(key);
  }
  await rawWrite(key, value);
}

/** Debounced write; rapid successive calls collapse into one disk write. */
function queueWrite(key: string, value: unknown): void {
  pendingValues.set(key, value);
  const existing = pendingWrites.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
  }
  pendingWrites.set(
    key,
    setTimeout(() => {
      pendingWrites.delete(key);
      const latest = pendingValues.get(key);
      pendingValues.delete(key);
      startWrite(key, latest);
    }, WRITE_DEBOUNCE_MS),
  );
}

/**
 * Flush every pending write synchronously-ish; called on window unload.
 *
 * These are the writes most likely to fail: the window is going away, and in
 * Tauri the Rust side may finish tearing down before the reply lands — which
 * is where "Couldn't find callback id" comes from. Reporting beats an
 * unhandled rejection thrown from a page that no longer exists.
 */
function flushAll(): void {
  for (const [key, timer] of pendingWrites) {
    clearTimeout(timer);
    startWrite(key, pendingValues.get(key));
  }
  pendingWrites.clear();
  pendingValues.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushAll);
}

// ---------------------------------------------------------------- typed API

/**
 * Everything below reads files the user is told they may open, written by
 * builds that may be newer than this one. A record that arrives malformed —
 * `null` in a list, a string where an object belongs, a missing id — reaches
 * React as a crash: `roster.map(blob => blob.name)` on a null entry takes the
 * whole window down, and losing the roster is far worse than losing one row.
 *
 * So each list is filtered here rather than trusted and cast. The rule is
 * deliberately narrow: drop a record only when it cannot be identified or
 * addressed, and leave odd-but-harmless values to the render, which falls
 * back on its own (an unknown avatar tone draws the default rather than
 * refusing to draw). Validating more than identity here would silently delete
 * rows a future build added a field to.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A record carrying a usable string at `key`. */
function hasText(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key] !== "";
}

/**
 * Keep the records of a stored list that are usable, drop the rest.
 *
 * Returns `null` for a slice that is not a list at all, which every caller
 * reads as “nothing saved” — the same answer as a missing file.
 */
function usableRows<T>(
  value: unknown,
  usable: (row: Record<string, unknown>) => boolean,
): T[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((row): row is T => isRecord(row) && usable(row));
}

export async function loadRoster(): Promise<Agent[] | null> {
  const value = await rawRead("roster");
  // A Blob is addressed by id and shown by name; without either it cannot be
  // opened, mentioned or drawn.
  return usableRows<Agent>(value, (row) => hasText(row, "id") && hasText(row, "name"));
}

export function saveRoster(rows: Agent[]): void {
  queueWrite("roster", rows);
}

export async function loadSettings(): Promise<Partial<Settings> | null> {
  const value = await rawRead("settings");
  return value !== null && typeof value === "object" ? (value as Partial<Settings>) : null;
}

export function saveSettings(settings: Settings): void {
  queueWrite("settings", settings);
}

/**
 * Memories shared by every Blob ("All Blobs" scope), stored in the root
 * `user` slice. Per-Blob memories stay in that Blob's config.
 */
export async function loadUserMemories(): Promise<BlobMemory[] | null> {
  const value = await rawRead("user");
  // A fact with no words is nothing to remember, and one with no id cannot be
  // edited or forgotten again.
  return usableRows<BlobMemory>(value, (row) => hasText(row, "id") && hasText(row, "text"));
}

export function saveUserMemories(memories: BlobMemory[]): void {
  queueWrite("user", memories);
}

/**
 * Whether the editor bridge is on, and which clients the user has paired.
 *
 * Its own slice rather than a field on `Settings`: this is the on/off state of
 * a local control surface, and a corrupt or half-written settings blob must
 * never be able to turn it on. Read defensively for the same reason — anything
 * that is not plainly `true` leaves the bridge off.
 */
export async function loadAcpSettings(): Promise<AcpSettings> {
  const value = await rawRead("acp");
  if (value === null || typeof value !== "object") {
    return { enabled: false, pairedClients: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    pairedClients: Array.isArray(record.pairedClients)
      ? record.pairedClients.filter((name): name is string => typeof name === "string")
      : [],
  };
}

export function saveAcpSettings(settings: AcpSettings): void {
  queueWrite("acp", settings);
}

/**
 * Half-typed messages, keyed by conversation id.
 *
 * Its own root slice, not part of a transcript: a draft is not a message, and
 * putting it in the transcript would rewrite that whole file on every
 * keystroke (see `saveConversation`). One small record for every conversation
 * instead, coalesced by the same 300ms debounce as everything else here.
 *
 * Read defensively: this file is on disk and the user is told they may look
 * at it, so anything that is not a string is dropped rather than handed to
 * the composer.
 */
export async function loadDrafts(): Promise<Record<string, string>> {
  const value = await rawRead("drafts");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
}

export function saveDrafts(drafts: Record<string, string>): void {
  queueWrite("drafts", drafts);
}

export async function loadUiLayout(): Promise<Partial<UiLayout> | null> {
  const value = await rawRead("ui-layout");
  return value !== null && typeof value === "object" ? (value as Partial<UiLayout>) : null;
}

export function saveUiLayout(layout: UiLayout): void {
  queueWrite("ui-layout", layout);
}

/**
 * Messages kept in the rewritable `transcript` slice. Past this, the oldest
 * are sealed into `transcript-1`, `transcript-2`, … and never rewritten.
 *
 * A conversation is written out in full on every save, so a single growing
 * slice makes each message cost more than the last — measured at 8ms/2MB per
 * save at 2,000 messages, 14ms/8MB at 7,000, 83ms/64MB at 55,000, all of it
 * re-written every few seconds while someone is typing. It also ends at a
 * wall: past `MAX_SLICE_BYTES` (8MB) Rust refuses the write, correctly, since
 * a larger file could never be read back — and the conversation silently
 * stops persisting. Rolling keeps the rewritten part flat and small, so
 * neither happens however long a conversation runs.
 */
const LIVE_TRANSCRIPT_MAX = 800;

/** How many of the oldest move into an archive when that limit is passed. */
const TRANSCRIPT_ARCHIVE_CHUNK = 400;

/** Per conversation: archives written, and how many messages they hold. */
const sealedTranscripts = new Map<string, { archives: number; messages: number }>();

/** One rollover at a time per conversation, so two cannot claim one number. */
const rollovers = new Map<string, Promise<void>>();

/**
 * Read a conversation back: every archive oldest-first, then the live slice.
 *
 * Duplicates are dropped by message id because the crash window demands it.
 * A rollover writes the archive first and truncates the live slice second, so
 * a crash between the two leaves those messages in both places — the safe
 * direction (nothing is lost), but the reader has to be the one that notices.
 */
async function loadTranscript(base: string): Promise<Message[] | null> {
  // Messages are addressed by id all the way through — dedupe below, reply
  // targets, reactions, attachment patches — so one without a usable id is
  // not a message this app can hold. `kind` picks the view; the card registry
  // fails closed on a kind it does not know, but a missing one has no card at
  // all. Anything past that is the card's problem, and a card that throws now
  // costs its own line rather than the conversation.
  const messages = (value: unknown): Message[] | null =>
    usableRows<Message>(value, (row) => hasText(row, "id") && hasText(row, "kind"));

  let archived: Message[] = [];
  let archives = 0;
  for (;;) {
    const rolled = messages(await rawRead(`${base}/transcript-${archives + 1}`));
    if (rolled === null) {
      break;
    }
    archived = archived.concat(rolled);
    archives += 1;
  }
  const live = messages(await rawRead(`${base}/transcript`));
  if (archives === 0) {
    sealedTranscripts.delete(base);
    return live;
  }
  sealedTranscripts.set(base, { archives, messages: archived.length });
  if (live === null) {
    return archived;
  }
  const seen = new Set(archived.map((message) => message.id));
  return archived.concat(live.filter((message) => !seen.has(message.id)));
}

/**
 * Persist a conversation, rolling its oldest messages away once it is long
 * enough that rewriting all of them has become the expensive part.
 *
 * Callers always pass the whole conversation — archived prefix included — so
 * the already-sealed count is what decides where the live slice starts.
 */
function saveTranscript(base: string, messages: Message[]): void {
  const mark = sealedTranscripts.get(base) ?? { archives: 0, messages: 0 };
  // Clamped: a caller holding fewer messages than we have sealed would
  // otherwise slice from beyond the end and quietly persist nothing.
  const alreadySealed = Math.min(mark.messages, messages.length);
  const live = messages.slice(alreadySealed);
  // Always queue the untruncated live slice first. If the archive below fails
  // or the app dies mid-rollover, this is what is on disk, and it still holds
  // every message.
  queueWrite(`${base}/transcript`, live);
  if (live.length <= LIVE_TRANSCRIPT_MAX) {
    return;
  }
  const chunk = live.slice(0, TRANSCRIPT_ARCHIVE_CHUNK);
  const rest = live.slice(TRANSCRIPT_ARCHIVE_CHUNK);
  const next = (rollovers.get(base) ?? Promise.resolve())
    .then(async () => {
      const current = sealedTranscripts.get(base) ?? { archives: 0, messages: 0 };
      // A rollover queued behind another one has already been superseded:
      // its chunk was computed against a boundary that has since moved.
      if (current.messages !== alreadySealed) {
        return;
      }
      await rawWrite(`${base}/transcript-${current.archives + 1}`, chunk);
      sealedTranscripts.set(base, {
        archives: current.archives + 1,
        messages: current.messages + chunk.length,
      });
      queueWrite(`${base}/transcript`, rest);
    })
    .catch(() => {
      // Nothing was truncated, so the live slice still carries everything and
      // the next save tries again. `startWrite` reports the failure itself.
    });
  rollovers.set(base, next);
}

export async function loadBlobRoutines(id: string): Promise<Routine[] | null> {
  const value = await rawRead(`blobs/${id}/routines`);
  const rows = usableRows<Routine>(value, (row) => hasText(row, "id") && hasText(row, "name"));
  // `triggers` is the one field the panels iterate without asking first, so a
  // routine that lost it takes the Routines screen down. Absent labels mean a
  // routine with no triggers yet — which the UI already draws.
  return rows === null
    ? null
    : rows.map((routine) =>
        Array.isArray(routine.triggers) ? routine : { ...routine, triggers: [] },
      );
}

export function saveBlobRoutines(id: string, routines: Routine[]): void {
  queueWrite(`blobs/${id}/routines`, routines);
}

export async function loadBlobTranscript(id: string): Promise<Message[] | null> {
  return await loadTranscript(`blobs/${id}`);
}

export function saveBlobTranscript(id: string, messages: Message[]): void {
  saveTranscript(`blobs/${id}`, messages);
}

export function saveBlobConfig(id: string, config: Agent): void {
  queueWrite(`blobs/${id}/config`, config);
}

/**
 * Group chats. The list is one root slice (names and ids only); each group's
 * transcript is its own slice, so a busy group never bloats the list.
 */
export async function loadGroups(): Promise<Group[] | null> {
  const value = await rawRead("groups");
  // A room is opened by id and listed by name; its members are looked up by
  // that name, so a nameless group would strand every Blob assigned to it.
  return usableRows<Group>(value, (row) => hasText(row, "id") && hasText(row, "name"));
}

export function saveGroups(groups: Group[]): void {
  queueWrite("groups", groups);
}

export async function loadGroupTranscript(id: string): Promise<Message[] | null> {
  return await loadTranscript(`groups/${id}`);
}

export function saveGroupTranscript(id: string, messages: Message[]): void {
  saveTranscript(`groups/${id}`, messages);
}

/**
 * Channels (Labs). The list is its own versioned slice (see store.rs's
 * `slice_names`). On disk the wrapper is unwrapped by `channels_read` (it
 * returns the bare array), while the browser fallback stores the whole
 * wrapper under the same `slice:` key, so a localStorage session behaves
 * like the disk one — both are read back through here as the bare list.
 */
export async function loadChannels(): Promise<Channel[] | null> {
  if (isTauri()) {
    const list = await invoke("channels_read");
    return Array.isArray(list) ? (list as Channel[]) : null;
  }
  const raw = backendGet("slice:channels");
  try {
    const parsed = raw === null ? null : (JSON.parse(raw) as { value?: unknown });
    return Array.isArray(parsed?.value) ? (parsed.value as Channel[]) : null;
  } catch {
    return null;
  }
}

export async function saveChannels(channels: Channel[]): Promise<void> {
  const payload = { schemaVersion: 1, value: channels };
  if (isTauri()) {
    await invoke("channels_write", { channels: payload.value });
    return;
  }
  backendSet("slice:channels", JSON.stringify(payload));
}

export async function loadChannelTranscript(id: string): Promise<Message[] | null> {
  return await loadTranscript(`channels/${id}`);
}

export function saveChannelTranscript(id: string, messages: Message[]): void {
  saveTranscript(`channels/${id}`, messages);
}

/**
 * Persist a conversation without caring which kind it is — the turn loop
 * writes through here, since a Blob's reply lands in its own transcript or in
 * a group's depending only on where it was asked.
 */
export function saveConversation(conversationId: string, messages: Message[]): void {
  const channelId = channelIdFromConversation(conversationId);
  if (channelId !== null) {
    saveChannelTranscript(channelId, messages);
    return;
  }
  const groupId = groupIdFromConversation(conversationId);
  if (groupId === null) {
    saveBlobTranscript(conversationId, messages);
    return;
  }
  saveGroupTranscript(groupId, messages);
}

/**
 * The slice key a conversation's messages are written to.
 *
 * Exported so the UI can match a conversation against `onSaveFailure` without
 * rebuilding the key format — a second copy of `blobs/${id}/transcript` would
 * drift from this one and quietly stop matching.
 */
export function conversationSliceKey(conversationId: string): string {
  const channelId = channelIdFromConversation(conversationId);
  if (channelId !== null) {
    return `channels/${channelId}/transcript`;
  }
  const groupId = groupIdFromConversation(conversationId);
  return groupId === null ? `blobs/${conversationId}/transcript` : `groups/${groupId}/transcript`;
}

/**
 * The compacted head of a conversation (see `lib/recap.ts`), keyed the same
 * way `saveConversation` is: a Blob's own chat or a group's, one recap each.
 */
export async function loadRecap(conversationId: string): Promise<Recap | null> {
  const value = await rawRead(recapSliceKey(conversationId));
  if (value === null || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  // Written by us, but read back from disk a user can edit: a half-valid
  // recap must read as no recap, never as `undefined` spliced into a prompt.
  return typeof record.text === "string" && typeof record.coveredId === "string"
    ? { text: record.text, coveredId: record.coveredId }
    : null;
}

export function saveRecap(conversationId: string, recap: Recap): void {
  queueWrite(recapSliceKey(conversationId), recap);
}

function recapSliceKey(conversationId: string): string {
  const channelId = channelIdFromConversation(conversationId);
  if (channelId !== null) {
    return `channels/${channelId}/recap`;
  }
  const groupId = groupIdFromConversation(conversationId);
  return groupId === null ? `blobs/${conversationId}/recap` : `groups/${groupId}/recap`;
}

export async function loadBlobRun(id: string): Promise<ActiveRun | null> {
  return parseRun(await rawRead(`blobs/${id}/runs`));
}

/**
 * Immediate write, not debounced: the record exists so a crash mid-run is
 * visible on relaunch, which a 300ms debounce window would defeat.
 */
export async function saveBlobRun(id: string, run: ActiveRun): Promise<void> {
  await flushWrite(`blobs/${id}/runs`, run);
}

/** Soft-delete: moves the Blob dir to trash (purged after 30 days). */
export async function deleteBlobData(id: string): Promise<void> {
  if (isTauri()) {
    await invoke("store_delete_blob", { id });
    return;
  }
  for (const slice of ["config", "routines", "transcript", "runs", "recap"]) {
    backendRemove(`slice:blobs/${id}/${slice}`);
  }
}

/**
 * Write every slice this Blob owns to one JSON file in Downloads and reveal
 * it in the file manager. Returns the path, or null outside Tauri.
 *
 * The bundle is assembled in Rust so the filename and target directory are
 * validated there — the Blob name is user text going into a path.
 */
export async function exportBlob(id: string, name: string): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }
  const path = await invoke<string>("store_export_blob", { id, name });
  await revealItemInDir(path);
  return path;
}

/** Immediate (non-debounced) roster write, for create/delete. */
export async function flushRoster(rows: Agent[]): Promise<void> {
  await flushWrite("roster", rows);
}
