import {
  ArrowDown,
  ArrowUp,
  CornerUpRight,
  Ellipsis,
  FileText,
  GraduationCap,
  Image as ImageIcon,
  Monitor,
  Plus,
  Smile,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { BlobAvatar } from "@/components/BlobAvatar";
import { messageCard } from "@/components/cards/registry";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { withMentions } from "@/components/Mention";
import { PillSelect } from "@/components/PillSelect";
import { type Agent, MAX_BLOB_NAME_LENGTH, type Message } from "@/data/agents";
import { type Attachment, MAX_ATTACHMENTS, type PickedFile } from "@/lib/attachments";
import { fileBadge, fileKind } from "@/lib/file-kind";
import { mentionPalette } from "@/lib/mentions";
import { prefersReducedMotion } from "@/lib/motion";
import { listOllamaModels, type OllamaModel } from "@/lib/ollama";
import { imagePreview } from "@/lib/preview";
import * as store from "@/lib/store";
import { revealFile } from "@/lib/tauri";
// Tinfoil's real module (attestation stack) is a lazy chunk; only the pure
// id helpers are static. The probe/model-list go through `import()`.
import type { TinfoilModel } from "@/lib/tinfoil";
import { isTinfoilModel, TINFOIL_MODEL_PREFIX } from "@/lib/tinfoil-model";

/**
 * Keychain probe + Tinfoil catalog load, module-scope so effects and
 * `useCallback`s can reference it without a dependency. The real tinfoil
 * module is only loaded when a probe actually runs (lazy provider chunk).
 */
const probeTinfoilModels = (set: (models: TinfoilModel[]) => void) =>
  void import("@/lib/tinfoil").then(async (tinfoil) => {
    const hasKey = await tinfoil.configureTinfoilFromKeychain();
    set(hasKey ? await tinfoil.listTinfoilModels() : []);
  });
interface ChatPaneProps {
  agent: Agent;
  messages: Message[];
  /**
   * Set when this pane is a group chat: the members share one transcript, so
   * every agent message names who said it and the composer can @ them.
   */
  group?: { id: string; name: string; members: readonly Agent[] };
  /** Rename the open group (its members move with it — see App.renameGroup). */
  onRenameGroup?: (name: string) => void;
  /** Channels replace Reply with a separate persistent thread action. */
  onOpenThread?: (message: Message) => void;
  threadReplyCounts?: Readonly<Record<string, number>>;
  /**
   * This conversation's last save failed, so what is on screen is no longer
   * reaching disk. Almost always a transcript past the 8 MB slice cap.
   */
  notSaving?: boolean;
  /** True while the Blob is generating a reply; shows the thinking blob. */
  thinking?: boolean;
  /** In a group, which member is generating — `agent` is only the fallback. */
  thinkingAgent?: Agent;
  /**
   * Run a failed turn again: the message is the one that failed, and it comes
   * off the transcript before the retry so the Blob does not read its own
   * apology back as history.
   */
  onRetry?: (message: Message) => void;
  /** Take a failed message off the transcript for good. */
  onDismiss?: (messageId: string) => void;
  /** Ollama model tag driving replies; "" until one is chosen. */
  model: string;
  onModelChange: (model: string) => void;
  /** Whether the model may use chain-of-thought (slower, deeper). */
  reasoning: boolean;
  onReasoningChange: (on: boolean) => void;
  /** Files ride along with the message; the app saves them to the Blob's home. */
  onSend: (
    text: string,
    options?: { replyTo?: string; replyToId?: string; files?: readonly PickedFile[] },
  ) => void;
  /**
   * Ids of messages whose attachments are still being extracted — a PDF parse
   * or an OCR pass runs for seconds after the message is already on screen.
   */
  readingMessages?: readonly string[];
  /** Abort the in-flight reply, keeping any partial text. */
  onStop?: () => void;
  /** The Blob paused mid-task and waits on the user (ask_user). */
  waitingAsk?: "question" | "action" | undefined;
  /**
   * Which Blob is waiting. In a group the pane's `agent` is only the first
   * member — naming it would credit the ask to whoever happens to head the
   * roster rather than to whoever actually asked.
   */
  waitingAskAgent?: Agent | undefined;
  detailOpen: boolean;
  onToggleDetail: () => void;
  onOpenSettings: () => void;
  /**
   * Start recording a demonstration for this Blob. Absent where recording is
   * impossible (a group pane, or a build that cannot capture), which is also
   * what hides the button — an entry that cannot work is worse than none.
   */
  onTeach?: (() => void) | undefined;
  /** True while any Blob is being taught, so the entry cannot start a second. */
  teaching?: boolean | undefined;
}

/** Messages rendered initially; scrolling to the top reveals another page.
    Caps DOM size for long transcripts — markdown bubbles are expensive. */
const MESSAGE_PAGE_SIZE = 50;

const REACTIONS: ReadonlyArray<{ emoji: string; name: string }> = [
  { emoji: "\u{1F44D}", name: "thumbs up" },
  { emoji: "\u{1F44E}", name: "thumbs down" },
  { emoji: "\u2764\uFE0F", name: "heart" },
  { emoji: "\u{1F602}", name: "laugh" },
  { emoji: "\u{1F389}", name: "celebrate" },
  { emoji: "\u{1F62E}", name: "surprised" },
];

/** Plain-text preview of a message, used for reply quoting. */
function messagePreview(message: Message): string {
  if (message.kind === "file") {
    return message.fileName;
  }
  if (message.kind === "event") {
    return message.text;
  }
  const text = message.segments.map((segment) => segment.text).join("");
  // An attachment-only message has no words to quote; its files name it.
  return text.trim() === ""
    ? (message.attachments ?? []).map((entry) => entry.name).join(", ")
    : text;
}

/**
 * How long a send waits for a thumbnail that is still rendering.
 *
 * Sending within a moment of picking is normal, and a thumbnail takes tens of
 * ms; waiting means the picture arrives with the message instead of a beat
 * later. Past this the message goes without it.
 */
const PREVIEW_WAIT_MS = 400;

/** Human-readable file size, matching the Files panel's format. */
function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * One attached file, shown as the thing it is: a picture for an image, a card
 * with icon and size for everything else.
 *
 * Rendered outside the text bubble (a sibling in the message row), because an
 * image wants no padding, no background and its own width — nesting it in a
 * bubble boxes every photo in a grey frame.
 */
function AttachmentView({ attachment, reading }: { attachment: Attachment; reading: boolean }) {
  // The name the user picked; `photo.png.txt` is our storage detail.
  const label = attachment.label ?? attachment.name;
  const kind = fileKind(label);

  // Only ever a data: image URL. Previews are read back from the plain-JSON
  // transcript, an editable file on disk, and this value goes straight into
  // `src` — an edited one must not be able to name any other scheme.
  const preview =
    attachment.preview?.startsWith("data:image/") === true ? attachment.preview : undefined;

  if (preview !== undefined) {
    // A screenshot keeps its full-resolution PNG on disk and carries only a
    // thumbnail here, so clicking shows the real file. Files the user attached
    // have no path and stay a plain picture — they already have the original.
    const full = attachment.path;
    if (full === undefined) {
      return (
        <img
          className="attachment-image"
          src={preview}
          alt={label}
          title={label}
          draggable={false}
        />
      );
    }
    // A card with the picture over its name, like the tool-image cards in GG
    // Coder: the caption is what tells the user this is a real file on disk
    // and not just something pasted into the conversation.
    return (
      <button
        type="button"
        className="attachment-shot"
        title={`Show ${label} in Finder`}
        onClick={() => {
          void revealFile(full);
        }}
      >
        <img className="attachment-image" src={preview} alt={label} draggable={false} />
        <span className="attachment-shot-name">{label}</span>
      </button>
    );
  }
  return (
    <span className={`attachment-card attachment-kind-${kind}`}>
      <span className="attachment-card-icon" aria-hidden="true">
        {kind === "image" ? (
          <ImageIcon size={18} strokeWidth={1.8} />
        ) : (
          <FileText size={18} strokeWidth={1.8} />
        )}
        <span className="attachment-card-badge">{fileBadge(label)}</span>
      </span>
      <span className="attachment-card-text">
        <span className="attachment-card-name">{label}</span>
        <span className="attachment-card-size">
          {reading ? "reading…" : fileSize(attachment.bytes)}
        </span>
      </span>
    </span>
  );
}

/** How long a silence before the transcript earns a new time divider. */
const TIME_DIVIDER_GAP_MS = 5 * 60_000;

/** "9:41 AM" — the wall-clock style the transcript dividers use. */
function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Tuesday, 12 August" — marks a message from a later day. */
function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * Divider text for a message, or null when it closely follows the previous
 * one on the same day. Like a messenger transcript, the time appears at the
 * start of the conversation and again after a silence or an overnight break —
 * not on every message. Legacy entries without a timestamp never get one and
 * never break the chain: the previous message's time simply carries forward.
 */
function dividerLabel(previous: number | null, ms: number): string | null {
  if (previous === null) {
    return clockLabel(ms);
  }
  if (new Date(previous).toDateString() !== new Date(ms).toDateString()) {
    return dayLabel(ms);
  }
  return ms - previous >= TIME_DIVIDER_GAP_MS ? clockLabel(ms) : null;
}

interface MessageRowProps {
  message: Message;
  /** In a group, the Blob that said it — its name and face go above the bubble. */
  author?: Agent | undefined;
  /** The message's own view, chosen by the card registry. */
  card: ReactNode;
  reaction: string | undefined;
  pickerOpen: boolean;
  /** Arrived after mount: plays the in-place jelly pop exactly once. */
  fresh: boolean;
  /** Called when this row's pop has played, so it is never dressed for it again. */
  onPopped: () => void;
  /** The cursor is known to be elsewhere: suppresses a latched :hover. */
  stale: boolean;
  /** This message's attachments are still being extracted. */
  reading: boolean;
  onEnter: () => void;
  onTogglePicker: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onOpenThread?: (() => void) | undefined;
  replyCount?: number | undefined;
}

/** A bubble plus its hover/focus action bar, reaction picker and reaction badge. */
function MessageRow({
  message,
  author,
  card,
  reaction,
  pickerOpen,
  fresh,
  onPopped,
  stale,
  reading,
  onEnter,
  onTogglePicker,
  onReact,
  onReply,
  onOpenThread,
  replyCount,
}: MessageRowProps) {
  const side = message.kind === "text" && message.author === "user" ? "user" : "agent";
  return (
    <div
      // CSS :hover reveals the action bar; .message-row-stale hides it again
      // on every row that isn't the one the cursor last entered. Both are
      // needed: measured in the app's webview, a bar faded in by :hover stays
      // painted on rows that no longer match it, so sweeping down the
      // transcript left every bar showing until each was hovered again.
      className={`message-row message-row-${side}${fresh ? " message-fresh" : ""}${
        stale ? " message-row-stale" : ""
      }`}
      // The pop is the row's arrival, so it belongs to the row's first moment
      // and nothing after it. A CSS animation replays whenever its element is
      // re-inserted into the DOM, and a class left on forever means every
      // later reflow — a divider appearing above, a re-layout mid-turn — pops
      // every row still wearing it: the whole live part of the transcript
      // jiggling for as long as the agent kept working. Dropping the class the
      // moment it has played makes "exactly once" true of the DOM itself,
      // rather than of one code path that had to remember not to disturb it.
      //
      // With motion reduced the animation is `none`, so this never fires and
      // the class stays — which is exactly right: there is no pop to replay.
      onAnimationEnd={(event) => {
        // Animations bubble: a child's ending is not this row's arrival.
        if (event.target === event.currentTarget && event.animationName === "message-jelly") {
          onPopped();
        }
      }}
      data-message-id={message.id}
      // pointerover, not pointerenter: it bubbles from the markdown children,
      // so entering the row anywhere claims it in one delegated listener.
      onPointerOver={onEnter}
    >
      {pickerOpen ? (
        <div className="reaction-picker">
          {REACTIONS.map((option) => (
            <button
              type="button"
              key={option.name}
              className="reaction-option"
              aria-label={`React with ${option.name}`}
              aria-pressed={reaction === option.emoji}
              onClick={() => onReact(option.emoji)}
            >
              {option.emoji}
            </button>
          ))}
        </div>
      ) : null}
      {/* Name only. The avatar belongs to the @mention, where it identifies a
          Blob being pointed AT mid-sentence; here it would repeat down every
          run of messages from the same speaker and compete with the bubbles
          it is meant to label. */}
      {author === undefined || message.kind !== "text" || message.author !== "agent" ? null : (
        <span className="message-author">{author.name}</span>
      )}
      {/* The bubble and its hover bar share one line: the line hugs the
          bubble, so the bar can sit beside it, vertically centered — right of
          agent bubbles, left of user ones — instead of above it.

          Attachments live on this line too, not above it: the bar centres on
          whatever the line contains, so a message that is only a picture (a
          screenshot a Blob took) gets the bar beside the picture rather than
          floating beside the empty space where a bubble would have been. */}
      <div className="message-line">
        <div className="message-actions" role="toolbar" aria-label="Message actions">
          <button type="button" className="icon-button message-action" aria-label="More options">
            <Ellipsis size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button message-action"
            aria-label={onOpenThread === undefined ? "Reply" : "Open thread"}
            onClick={onOpenThread ?? onReply}
          >
            <CornerUpRight size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button message-action"
            aria-label="React"
            aria-expanded={pickerOpen}
            // Without this, the outside-click dismiss fires on pointerdown and
            // the click then re-toggles the picker straight back open.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onTogglePicker}
          >
            <Smile size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <div className="message-stack">
          {replyCount === undefined || replyCount === 0 ? null : (
            <button type="button" className="thread-reply-count" onClick={onOpenThread}>
              {replyCount} {replyCount === 1 ? "reply" : "replies"}
            </button>
          )}
          {message.kind !== "text" || (message.attachments ?? []).length === 0 ? null : (
            <span className="message-attachments">
              {(message.attachments ?? []).map((attachment) => (
                // Keyed on the name the user picked, which does not change when
                // the saved name settles from `photo.png` to `photo.png.txt` —
                // keying on the saved name would remount the <img> and flash it.
                <AttachmentView
                  key={attachment.label ?? attachment.name}
                  attachment={attachment}
                  reading={reading}
                />
              ))}
            </span>
          )}
          {card}
        </div>
        {/* Inside the line, which hugs the bubble: the chip is placed against
            the bubble's own edges, and taken out of flow so that reacting
            does not add a row and shunt the transcript below it downwards. */}
        {reaction === undefined ? null : (
          <span className="bubble-reaction" role="img" aria-label={`Reacted with ${reaction}`}>
            {reaction}
          </span>
        )}
      </div>
    </div>
  );
}

/** How many members the @-menu offers at once; the group cap is six. */
const MAX_MENTION_OPTIONS = 6;

/**
 * The "@name" being typed at the caret.
 *
 * Anchored to the start of a word, so an email address mid-sentence never
 * opens the menu. Spaces are part of the captured prefix because Blob names
 * routinely contain them ("Social Blob", "AI News Blob") — stopping at the
 * first space made the menu vanish halfway through typing the very names it
 * exists to complete.
 *
 * What closes the menu instead is having no match: the caller keeps it open
 * only while some member's name still starts with the prefix, so ordinary
 * prose after an "@" dismisses it within a word or two.
 */
const MENTION_TOKEN = /(?:^|\s)@([^@\n]*)$/u;

/**
 * Re-seat `el` on the geometry it actually has, across two frames.
 *
 * After a width transition or a conversation swap WebKit can hand back a
 * *stale* scroll extent together with a `scrollTop` produced by that same
 * stale extent — the two agree with each other and disagree with the pixels.
 * The pane then shows blank until a stray scroll makes the engine re-clamp.
 * Forcing layout with `offsetHeight` does not help: that recomputes layout,
 * not the scrollable overflow the scroller caches. Only a real scroll does.
 *
 * The previous version knew that and still did nothing, because it wrote the
 * nudge and the intended position in the SAME frame:
 *
 *     el.scrollTo({top: before - 1});   // the nudge
 *     el.scrollTo({top: target});       // ... immediately erased
 *
 * WebKit coalesces same-frame scroll updates into one commit. Verified
 * against WebKit 26.5: that pair fires exactly ONE scroll event, carrying
 * only the final value. So whenever `target` was where we already were —
 * every "already at the bottom" case, which is the entire reason this
 * function exists — the net movement was zero, the engine never re-clamped,
 * and the pane stayed blank. That is why the fix appeared to work sometimes:
 * it only ever did anything when the target happened to differ.
 *
 * So the nudge is now the last scroll written in its frame, and the intended
 * position is written on the next one. Two genuine 1px scrolls, invisible to
 * the eye, each one a real scroll to the engine. The second measures against
 * an extent the first forced it to rebuild.
 *
 * `pinBottom` says which position was intended: the bottom for a reader who
 * was following the conversation, otherwise wherever they had parked, capped
 * at an extent that now exists. `done` receives the final position once it
 * has landed. Returns the pending frame handle so a caller that is torn down
 * — or switched to another conversation — can cancel the second half.
 */
function settleScroll(el: HTMLElement, pinBottom: boolean, done?: (top: number) => void): number {
  void el.offsetHeight;
  const before = el.scrollTop;
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const target = pinBottom ? max : Math.min(before, max);
  // The nudge, alone in its frame: 1px off the target, in whichever direction
  // has room — at 0 there is nothing above to borrow from.
  el.scrollTo({ top: target < 1 ? target + 1 : target - 1, behavior: "instant" });
  return requestAnimationFrame(() => {
    // Measured again, because the scroll above is what makes this trustworthy.
    const settled = pinBottom ? Math.max(0, el.scrollHeight - el.clientHeight) : target;
    el.scrollTo({ top: settled, behavior: "instant" });
    done?.(el.scrollTop);
  });
}

/**
 * Make WebKit rebuild `el`'s rendering, then put the scroll position back.
 *
 * Why this exists: a ⌘⇧D probe reading taken while the pane was blank on the
 * reporter's machine (release build, 1080x728 @ dpr 2) showed the geometry was
 * already perfect — `drift=0`, `gap=0`, `scrollTop === max`, every on-screen
 * row opaque, and "the fault survives a layout flush". The rows were
 * positioned exactly where they belong and simply had not been drawn. Every
 * fix before this one moved `scrollTop`, which was never what was wrong.
 *
 * Why THIS mechanism, out of the obvious candidates: the reporter tried them
 * live, in order, on a genuinely blank pane. Setting opacity to create a
 * throwaway compositing layer did nothing. `translateZ(0)` did nothing. This
 * — removing the element from the render tree, forcing layout, putting it
 * back — brought the whole transcript back at once.
 *
 * That result is the useful part, because it rules out a whole class of fix:
 * asking the compositor to re-composite an existing layer is not enough, since
 * the layer it re-composites still holds the stale tiles. Only destroying the
 * renderer and rebuilding it produces fresh ones.
 *
 * The three writes happen in one task, so the browser never paints the
 * intermediate state and there is no flash. `display: none` does reset the
 * scroll position, hence the save and restore — and that restore fires a
 * scroll event the pane must ignore, which is what `done` is for.
 *
 * That restore must not go through `el.scrollTop = top`. This pane sets
 * `scroll-behavior: smooth`, which the scrollTop setter obeys, so the
 * assignment did not put the reader back — it launched a glide from the top
 * of the transcript down to where they had been, and the repair became the
 * bug it was written to fix. `rerenderingRef` clears after one frame while
 * the glide runs for hundreds of milliseconds, so its scroll events landed as
 * "the user scrolled up" (the pane stops holding the bottom, the jump pill
 * appears over a conversation nobody left); on the way down it crosses the
 * paging threshold and mounts another 50 messages, growing the content under
 * an animation already aimed at the old extent; and it lands against that
 * stale extent — blank, until a real scroll re-clamps it. A longer transcript
 * means a longer glide, which is why this came back after a long
 * back-and-forth and then on every session opened after it.
 *
 * simplification: a full re-layout of the transcript, which is why it runs
 * only after a settle (≈once per resize or switch) and never per frame. The
 * upgrade path is a narrower invalidation if WebKit ever offers one.
 */
function forceRerender(el: HTMLElement, done?: () => void): number {
  const top = el.scrollTop;
  el.style.display = "none";
  // Read layout while it is detached: this is what forces the renderer to be
  // torn down rather than the whole thing being coalesced away.
  void el.offsetHeight;
  el.style.display = "";
  // `scrollTo` with an explicit behaviour, so the CSS smooth scrolling cannot
  // turn this into a glide. The assignment is kept only for environments with
  // no `scrollTo` at all, where an instant restore is not on offer anyway.
  if (typeof el.scrollTo === "function") {
    el.scrollTo({ top, behavior: "instant" });
  } else {
    el.scrollTop = top;
  }
  // Scroll events are dispatched during "update the rendering", which runs
  // before animation-frame callbacks — so by the time this fires, the event
  // from the restore above has already been and gone.
  return requestAnimationFrame(() => {
    done?.();
  });
}

/** Cap the composer's growth at five text lines (5 × 20px + block padding). */
const COMPOSER_MAX_HEIGHT = 112;

/** Single-line textarea height; above this the composer switches to the
    expanded layout (text on top, buttons on their own bottom row). */
const COMPOSER_LINE_HEIGHT = 32;

export function ChatPane({
  agent,
  messages,
  notSaving = false,
  group,
  onRenameGroup,
  onOpenThread,
  threadReplyCounts = {},
  thinking = false,
  thinkingAgent,
  onRetry,
  onDismiss,
  model,
  onModelChange,
  reasoning,
  onReasoningChange,
  onSend,
  onStop,
  waitingAsk,
  waitingAskAgent,
  readingMessages = [],
  detailOpen,
  onToggleDetail,
  onOpenSettings,
  onTeach,
  teaching,
}: ChatPaneProps) {
  const [draft, setDraft] = useState("");
  /**
   * Every conversation's unsent draft, as last written to disk. A ref, not
   * state: nothing on screen reads the other conversations' drafts, and this
   * changes on every keystroke.
   */
  const draftsRef = useRef<Record<string, string>>({});
  /** Files picked but not sent yet; they are saved only once the message goes.
      Keyed by id, not name: picking the same file twice is two chips. */
  const [attached, setAttached] = useState<
    { id: string; file: File; preview?: string; pending: Promise<string | undefined> }[]
  >([]);
  /** True while a drag hovers the composer, so the drop target is visible. */
  const [dragging, setDragging] = useState(false);
  /** Nested elements the dragged file is currently over; see the composer's
      drag handlers for why a count and not `relatedTarget`. */
  const dragDepth = useRef(0);
  /** The message being replied to: its preview, and its id — which is what
      routes the reply to one member in a group. */
  const [replyTo, setReplyTo] = useState<{ id: string; preview: string } | null>(null);
  /** Open @-mention menu: the partial name typed so far, or null. */
  const [mention, setMention] = useState<string | null>(null);
  /**
   * Highlighted option, or null for none.
   *
   * Null while the menu is merely *listing* who is here (a bare “@”): with a
   * first option pre-highlighted, the list reads as a choice already made
   * before the user has expressed any preference. Typing a prefix is that
   * preference, and highlights the best match.
   */
  const [mentionIndex, setMentionIndex] = useState<number | null>(null);
  /** Where the caret goes once a completed mention has rendered. */
  const pendingCaret = useRef<number | null>(null);
  /**
   * The group name being edited, or null when the field just shows the real
   * one. Dropping back to null on blur is what puts a rejected rename (empty,
   * or a name another group already has) back to the name that stuck.
   *
   * Mirrored in a ref because Escape has to blur to leave the field, and the
   * blur handler runs with the render's closure — reading state there would
   * commit the very edit Escape just abandoned.
   */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const nameDraftRef = useRef<string | null>(null);
  const editName = (value: string | null) => {
    nameDraftRef.current = value;
    setNameDraft(value);
  };
  /**
   * The header identity of the conversation being left, kept on screen while
   * the new one arrives so the two slide past each other. Without it the old
   * title is simply gone the frame the new one mounts, and the entrance plays
   * against an empty bar — the swap reads as a flicker rather than a move.
   *
   * A snapshot of what to draw, not the live node: it must keep showing the
   * OLD Blob after the props already describe the new one.
   */
  const identityKey = group?.id ?? agent.id;
  const identity = useMemo(
    () => ({
      key: identityKey,
      name: group?.name ?? agent.name,
      faces: (group?.members.slice(0, 3) ?? [agent]).map((member) => ({
        id: member.id,
        tone: member.tone,
        shape: member.shape,
      })),
      count:
        group === undefined
          ? null
          : group.members.length === 1
            ? "1 Blob"
            : `${group.members.length} Blobs`,
      /* A solo Blob's header is a button with its own padding; a group's is a
         plain div. The ghost has to copy that, or the two sit at different x
         and the straight-up travel reads as a slide to the left. */
      solo: group === undefined,
    }),
    [identityKey, group, agent],
  );
  const [leaving, setLeaving] = useState<typeof identity | null>(null);
  const shown = useRef(identity);
  if (shown.current.key !== identityKey) {
    const previous = shown.current;
    shown.current = identity;
    // Render-phase update, the "derive from changed props" pattern: React
    // re-runs this render before committing, so the ghost and its replacement
    // reach the DOM in the same frame and start together.
    // Skipped under reduced motion, where the ghost would never animate out.
    if (!prefersReducedMotion()) {
      setLeaving(previous);
    }
  }
  useEffect(() => {
    if (leaving === null) return;
    // A timer, not `animationend`: that event never fires for an element in a
    // background tab or a hidden window, and a ghost stuck over the real
    // title would be permanent. Comfortably past the 260ms animation.
    const timer = setTimeout(() => setLeaving(null), 400);
    return () => clearTimeout(timer);
  }, [leaving]);

  const [replyClosing, setReplyClosing] = useState(false);
  const [reactions, setReactions] = useState<Record<string, string>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  /** Row the cursor is over: id, null for none, undefined until it first
      moves — see the effect below. */
  const [hoverId, setHoverId] = useState<string | null | undefined>(undefined);
  const [multiline, setMultiline] = useState(false);

  /** A reply is streaming and can be aborted (Escape, or the send circle). */
  const canStop = thinking && onStop !== undefined;

  // Escape interrupts the reply from anywhere in the app, matching the
  // circle. Registered only while a turn is in flight, and it yields to
  // whatever else owns Escape right now — an open modal, palette or picker —
  // so the key never aborts generation when the user meant "close this".
  useEffect(() => {
    if (!canStop || pickerFor !== null) {
      return;
    }
    // globalThis: bare KeyboardEvent is React's type, shadowed by the import.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && document.querySelector("[aria-modal='true']") === null) {
        onStop?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canStop, pickerFor, onStop]);

  // Rows claim the cursor on pointerover (see MessageRow); this is the other
  // half — anything entered outside a row means no row holds it. pointerover
  // bubbles all the way up, so moving to the sidebar, composer or header
  // releases the last row. Deliberately not a leave event: measured in the
  // app's webview, entering fires reliably on every row and its markdown
  // children, while the matching leave is what goes missing.
  useEffect(() => {
    const clear = (event: Event) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest("[data-message-id]") === null
      ) {
        setHoverId(null);
      }
    };
    const clearAll = () => setHoverId(null);
    window.addEventListener("pointerover", clear);
    document.addEventListener("mouseleave", clearAll);
    window.addEventListener("blur", clearAll);
    return () => {
      window.removeEventListener("pointerover", clear);
      document.removeEventListener("mouseleave", clearAll);
      window.removeEventListener("blur", clearAll);
    };
  }, []);

  // Click anywhere outside the reaction picker (or Escape) dismisses it. The
  // opener buttons stopPropagation, so this never races the toggle.
  useEffect(() => {
    if (pickerFor === null) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(".reaction-picker") === null) {
        setPickerFor(null);
      }
    };
    // globalThis: bare KeyboardEvent is React's type, shadowed by the import.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setPickerFor(null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerFor]);
  const [availableModels, setAvailableModels] = useState<OllamaModel[]>([]);
  const [tinfoilModels, setTinfoilModels] = useState<TinfoilModel[]>([]);
  /** How many trailing messages are rendered; grows as the user scrolls up. */
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE);
  /** Shows the floating "scroll to bottom" button while scrolled up. */
  const [showJump, setShowJump] = useState(false);
  /** Scroll geometry captured just before older messages mount, so the
      viewport can be re-anchored instead of jumping to the new top. */
  const loadAnchorRef = useRef<{ height: number; top: number } | null>(null);
  /** Replies that arrived while the user was scrolled up; drives the pill. */
  const [unseenCount, setUnseenCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** The coloured copy of the draft sitting under the textarea. */
  const mirrorRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Whether the view is close enough to the bottom to auto-follow. */
  const nearBottomRef = useRef(true);
  /**
   * Geometry as of the last scroll event or programmatic pin.
   *
   * The scroll handler tells a user's intent from a reflow's by comparing
   * against this: intent moves `top` at a constant `height`, reflow changes
   * `height` under a `top` that stays put. Seeded from a pin as well as from
   * events, so the first event after opening a conversation has something
   * truthful to be compared with.
   */
  const lastMetrics = useRef({ top: 0, height: 0 });
  const noteMetrics = (el: HTMLElement) => {
    lastMetrics.current = { top: el.scrollTop, height: el.scrollHeight };
  };
  const prevMessageCount = useRef(messages.length);
  /** True while a programmatic smooth scroll is in flight; its intermediate
      scroll events must not be mistaken for the user scrolling up. */
  const autoScrollRef = useRef(false);
  /**
   * Whether a pane resize is in flight, and whether it should hold the bottom.
   *
   * `null` when idle. Set once at the start of a resize burst and read for its
   * duration, because the reflow fires scroll events that would otherwise
   * rewrite the answer halfway through.
   */
  const resizingRef = useRef<boolean | null>(null);
  /** Pending double-rAF from the resize settle, so unmount can cancel it. */
  const settleFrame = useRef<number | undefined>(undefined);
  /** Pending frame that ends a forced re-render. */
  const repaintFrame = useRef<number | undefined>(undefined);
  /**
   * True while a re-render is putting the scroll position back.
   *
   * Detaching the scroller resets its scroll position to 0, and restoring it
   * fires a scroll event that is not the user: unguarded it reads as "scrolled
   * to the very top" and pages in more history on every repair.
   */
  const rerenderingRef = useRef(false);
  /** Pending settle *timer* from the resize burst. In a ref for the same
      reason as the frame: a conversation switch has to be able to cancel it,
      and a timer parked in the observer's closure is unreachable from there —
      it fired against the new conversation and re-seated it on the old one's
      scroll position. */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flipRects = useRef(new Map<string, DOMRect>());

  /** What "this conversation" means here: one Blob, or one group. */
  const conversationKey = group?.id ?? agent.id;

  /**
   * Keep the draft, so closing the app mid-sentence does not throw the
   * sentence away. Written from the handlers that change it rather than from
   * an effect on `draft`: at a conversation switch both the key and the text
   * change in one commit, and an effect would see the new key beside the old
   * text and file one conversation's words under another's name.
   */
  const rememberDraft = useCallback(
    (text: string) => {
      const next = { ...draftsRef.current };
      // Whitespace is not a draft; leaving it in would restore a composer
      // that looks empty but counts as unsent.
      if (text.trim() === "") {
        delete next[conversationKey];
      } else {
        next[conversationKey] = text;
      }
      draftsRef.current = next;
      // Debounced 300ms inside the store, so a fast typist writes once.
      store.saveDrafts(next);
    },
    [conversationKey],
  );

  /**
   * Page size back to one page the moment the conversation changes — during
   * render, not in an effect.
   *
   * An effect trims the transcript *after* this commit has already pinned the
   * view to the bottom, so the pin measured a page-size the next paint throws
   * away: scrollTop is written against content that then shrinks under it,
   * which is precisely the overscroll (thread pushed up, blank below) this
   * pane keeps being bitten by. Adjusting state during render is React's own
   * answer to "derived from a prop": the second pass replaces this one before
   * anything is committed, so the DOM never holds the old conversation's page.
   */
  const pagedKey = useRef(conversationKey);
  /**
   * True from the moment a conversation is selected until its transcript has
   * actually arrived — which is not the same render.
   *
   * `App` hydrates a Blob's transcript from disk in an effect, so this pane is
   * mounted with an EMPTY `messages` and the history lands one or more renders
   * later. Every earlier version treated the switch as one render, and so made
   * its decisions against a transcript that was not there yet: the hydration
   * render looked like "messages just arrived in the conversation you were
   * already reading", which glides (and a smooth glide chases an extent
   * measured mid-layout, sails past the end, and leaves the blank pane that
   * only a stray scroll rescues). It also snapshotted zero ids as "already
   * seen", so the whole loaded history popped in as if brand new.
   *
   * This is why it came and went with no pattern: a Blob opened once this
   * session is already in memory and switches in a single pass, where none of
   * that happens. Cold ones take two, and break.
   *
   * Set during render rather than in an effect, so the id snapshot below is
   * taken from the same `messages` the pin will act on.
   */
  const openingRef = useRef(true);
  if (pagedKey.current !== conversationKey) {
    pagedKey.current = conversationKey;
    openingRef.current = true;
    setVisibleCount(MESSAGE_PAGE_SIZE);
  }

  // Mention colours, groups only: a 1-to-1 chat has nobody to address, so
  // there is nothing to disambiguate and "@" is just a character.
  //
  // Keyed by what the palette is actually built from, not by the array: the
  // parent rebuilds `group` inline every render, so array identity changes on
  // every streamed delta — and a new palette invalidates MarkdownContent's
  // plugin memo, re-parsing every bubble in the transcript with it.
  const members = group?.members;
  const signature = members
    ?.map((member) => `${member.id}:${member.name}:${member.tone}`)
    .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the stable form of `members`
  const palette = useMemo(
    () => (members === undefined ? undefined : mentionPalette(members)),
    [signature],
  );

  // Messages already on screen when this conversation opened. Anything newer
  // is "fresh" and pops in with the jelly animation — exactly once.
  //
  // Re-snapshotted for as long as the conversation is still opening, because
  // until the transcript lands there is nothing to snapshot: keying this to
  // the switch alone captured the empty pre-hydration list, and every message
  // in the loaded history then counted as an arrival.
  const initialIds = useRef<Set<string>>(new Set());
  if (openingRef.current) {
    initialIds.current = new Set(messages.map((entry) => entry.id));
  }
  /**
   * Retire a row from "fresh" once its pop has played.
   *
   * A ref and a forced render, not state: this fires once per arriving row and
   * must not make the pane re-render for rows nobody is looking at. The bump
   * is what re-renders the row without its animation class, so a later DOM
   * re-insertion cannot replay it.
   */
  const [, bumpPopped] = useReducer((count: number) => count + 1, 0);
  const markPopped = useCallback((id: string) => {
    if (!initialIds.current.has(id)) {
      initialIds.current.add(id);
      bumpPopped();
    }
  }, []);

  // Time dividers per message id, computed over the WHOLE transcript (not the
  // visible slice) so paging older messages in keeps each divider anchored to
  // the message it belongs to.
  const dividers = useMemo(() => {
    const byId = new Map<string, string>();
    let previous: number | null = null;
    for (const entry of messages) {
      if (entry.timestampMs === undefined) {
        continue;
      }
      const label = dividerLabel(previous, entry.timestampMs);
      previous = entry.timestampMs;
      if (label !== null) {
        byId.set(entry.id, label);
      }
    }
    return byId;
  }, [messages]);

  /**
   * Load the downloaded models for the header picker.
   *
   * Also re-run on demand (see the select's handlers): fetching only at mount
   * leaves the list empty forever if Ollama was starting up at the time, and
   * stale after the user pulls or removes a model with the app open.
   */
  const refreshModels = useCallback(() => {
    void listOllamaModels().then(setAvailableModels);
    // The keychain probe is memoized per session (see tinfoil.ts): reading
    // the keychain can prompt for the device password, so it happens at most
    // once, and never at mount unless a Tinfoil model is already selected.
    probeTinfoilModels(setTinfoilModels);
  }, []);

  // On mount, list local models always but only probe the keychain when the
  // saved model needs it — otherwise wait for the user to open the picker.
  // biome-ignore lint/correctness/useExhaustiveDependencies(model): mount-only probe; the picker's onOpen re-runs it
  useEffect(() => {
    void listOllamaModels().then(setAvailableModels);
    if (isTinfoilModel(model)) {
      probeTinfoilModels(setTinfoilModels);
    }
  }, []);

  // The drafts on disk, once. Whatever is waiting for the conversation that
  // is open goes straight into the composer: the read finishes long before
  // anyone has typed, and a draft is only replaced by an empty composer.
  // biome-ignore lint/correctness/useExhaustiveDependencies(conversationKey): the mount value is the one being restored
  useEffect(() => {
    void store.loadDrafts().then((saved) => {
      draftsRef.current = saved;
      const waiting = saved[conversationKey];
      if (waiting !== undefined) {
        setDraft((current) => (current === "" ? waiting : current));
      }
    });
  }, []);

  // Fresh conversation, fresh composer: restore that conversation's own
  // draft, and clear the reply chip and reaction picker when switching Blobs
  // so state never leaks across.
  useEffect(() => {
    setDraft(draftsRef.current[conversationKey] ?? "");
    setAttached([]);
    setDragging(false);
    dragDepth.current = 0;
    setMention(null);
    // Inlined rather than through `editName`: a non-stable function in here
    // is one the dependency lint has to be argued with.
    nameDraftRef.current = null;
    setNameDraft(null);
    setReplyTo(null);
    setReplyClosing(false);
    setPickerFor(null);
    setHoverId(undefined);
    setMultiline(false);
    setReactions({});
    setUnseenCount(0);
    setShowJump(false);
    // A page-load pending at switch time must not survive: its geometry
    // belongs to the old conversation, and a stale anchor blocks paging.
    loadAnchorRef.current = null;
    nearBottomRef.current = true;
    // Same for a resize still in flight, timer and pending frames alike. Its
    // settle would otherwise fire against the new conversation and overwrite
    // the line above with the old one's geometry, leaving a chat that opens at
    // the bottom convinced the user had scrolled up.
    resizingRef.current = null;
    if (settleFrame.current !== undefined) {
      cancelAnimationFrame(settleFrame.current);
      settleFrame.current = undefined;
    }
    clearTimeout(settleTimer.current);
    settleTimer.current = undefined;
    // A re-render's closing frame must never be dropped on the floor: the
    // scroll handler would be left suppressed forever, and the pane would
    // stop noticing that the user had scrolled at all.
    if (repaintFrame.current !== undefined) {
      cancelAnimationFrame(repaintFrame.current);
      repaintFrame.current = undefined;
      rerenderingRef.current = false;
    }
  }, [conversationKey]);

  // Older page mounted above the viewport: keep what the user was looking at
  // stationary by offsetting the scroll position with the added height.
  // biome-ignore lint/correctness/useExhaustiveDependencies(visibleCount): re-anchor exactly when the page mounts
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = loadAnchorRef.current;
    loadAnchorRef.current = null;
    if (el !== null && anchor !== null) {
      // `behavior: "instant"`, because the pane sets `scroll-behavior: smooth`
      // and would otherwise animate this correction — turning a page-in that
      // should be invisible into a visible slide.
      el.scrollTo({ top: anchor.top + (el.scrollHeight - anchor.height), behavior: "instant" });
    }
  }, [visibleCount]);

  // Hold the bottom while the pane is resized.
  //
  // Showing or hiding a side panel animates the chat's width for 260ms, and a
  // narrower pane wraps the same text into more lines. The transcript grows
  // downward from a fixed scrollTop, so the newest message walks up off the
  // bottom edge — the view scrolls itself while the user is doing nothing but
  // opening a sidebar, and the "jump to latest" arrow appears over a
  // conversation they never left.
  //
  // The burst has to be treated as one gesture, exactly as a programmatic
  // glide is. Each reflow frame fires a scroll event, and by the time the
  // observer runs, that handler has already recorded the grown transcript as
  // "user scrolled up" — so pinning on `nearBottomRef` alone reads a flag the
  // resize itself just falsified, and does nothing. Deciding once, at the
  // start of the burst, is what makes it hold.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver !== "function") {
      return;
    }
    const observer = new ResizeObserver(() => {
      // A glide this pane started is already in flight — the user just sent,
      // and the view is easing down onto their own message. Sending is also
      // what collapses the composer back to one line, so this scroller is
      // resized on the same frame the glide begins; pinning scrollTop to the
      // extent here overrides that glide outright, which is the bubble landing
      // and then snapping into place. The glide is already aimed at the
      // bottom, so there is nothing to hold: let it finish.
      if (autoScrollRef.current) {
        return;
      }
      // First frame of the burst: was the user following the conversation
      // before any of this reflow happened?
      if (resizingRef.current === null) {
        resizingRef.current = nearBottomRef.current;
      }
      if (resizingRef.current) {
        // `behavior: "instant"` rather than assigning `scrollTop`, which the
        // pane's own `scroll-behavior: smooth` turns into an animation: the
        // correction then chases the reflow a frame behind, which is the
        // spring — content lands, then visibly slides down to settle. The
        // keyword overrides the stylesheet, so each frame is placed outright.
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
        // Called every frame of the transition, which is fine: React bails
        // out of re-rendering when the state is already `false`.
        setShowJump(false);
      }
      clearTimeout(settleTimer.current);
      // Comfortably past the 260ms panel transition, so a burst is not split
      // into two and judged twice.
      settleTimer.current = setTimeout(() => {
        // WebKit can leave the scroll extent stale after a width transition:
        // the last per-frame pin read `scrollHeight` mid-reflow, so scrollTop
        // can sit past the final, shorter content — a pane that shows blank
        // until the user scrolls and the engine re-clamps (seen live in the
        // Tauri webview, 2026-08-19). `settleScroll` reproduces that rescuing
        // scroll itself, so the burst ends on geometry that actually exists.
        //
        // `pinBottom` is the decision made at the start of the burst, not a
        // fresh reading: every scroll event since then was fired by the reflow.
        const pinBottom = resizingRef.current === true;
        // One call, not two: `settleScroll` already spans two frames, and its
        // second half measures against the extent its own nudge rebuilt. The
        // previous pair ran back-to-back inside a single frame, where WebKit
        // coalesced each nudge away with the write that followed it.
        settleFrame.current = settleScroll(el, pinBottom, (top) => {
          settleFrame.current = undefined;
          resizingRef.current = null;
          nearBottomRef.current = el.scrollHeight - top - el.clientHeight < 80;
          // The width transition just resized this scroller's backing store,
          // which is when its tiles can be left holding the pre-transition
          // picture. Position is settled by now, so this cannot fight it.
          rerenderingRef.current = true;
          repaintFrame.current = forceRerender(el, () => {
            rerenderingRef.current = false;
            repaintFrame.current = undefined;
          });
        });
      }, 320);
    });
    observer.observe(el);
    return () => {
      clearTimeout(settleTimer.current);
      if (settleFrame.current !== undefined) {
        cancelAnimationFrame(settleFrame.current);
        settleFrame.current = undefined;
      }
      if (repaintFrame.current !== undefined) {
        cancelAnimationFrame(repaintFrame.current);
        repaintFrame.current = undefined;
        rerenderingRef.current = false;
        // The re-render restores `display` synchronously, so an unmount here
        // cannot leave the pane hidden — only the suppression flag needs
        // clearing.
      }
      observer.disconnect();
    };
  }, []);

  /**
   * `repair` runs the stale-extent settle and the renderer rebuild below.
   * Opening a conversation only: it is a full re-layout of the transcript, and
   * `display: none` restarts every CSS animation inside it — so running it on
   * each streamed arrival replayed the jelly pop on the newest bubbles (the
   * only rows carrying `.message-fresh`) for the whole length of a turn.
   * Ordinary growth needs none of it: the extent it pins to is one the engine
   * just rebuilt for the message that arrived.
   */
  const scrollToLatest = (behavior: ScrollBehavior = "smooth", repair = false) => {
    const el = scrollRef.current;
    if (el !== null) {
      autoScrollRef.current = behavior === "smooth";
      nearBottomRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior });
      noteMetrics(el);
      if (behavior === "instant" && repair) {
        // WebKit can report a stale scroll extent at pin time: a conversation
        // switch measures scrollHeight mid-swap (old messages tearing down,
        // new ones with async layout still settling), so the pin lands past
        // the real content — overscroll, the thread pushed up with blank
        // below, and the engine does not re-clamp until the first user scroll
        // (seen live in the Tauri webview, same family as the resize-burst
        // clamp below). One re-pin two frames later, when layout has settled,
        // lands on the extent that actually exists. Guarded by nearBottomRef
        // so a user who scrolled up inside those two frames is not yanked.
        //
        // Through `settleScroll`, not a plain `scrollTo`: asking again is
        // exactly what does not work here. WebKit hands back the same stale
        // extent it handed back the first time, so a second write agrees with
        // the first and the pane stays blank. Only a real scroll makes the
        // engine rebuild the extent, which is why `settleScroll` spends a
        // frame letting its nudge actually land instead of overwriting it.
        settleFrame.current = requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const settled = scrollRef.current;
            if (settled !== null && nearBottomRef.current) {
              settleFrame.current = settleScroll(settled, true, () => {
                settleFrame.current = undefined;
                // A switch refilled this scroller with a different
                // transcript. Same tile-staleness risk as the resize above,
                // and the same reason "open a session and it is empty".
                rerenderingRef.current = true;
                repaintFrame.current = forceRerender(settled, () => {
                  rerenderingRef.current = false;
                  repaintFrame.current = undefined;
                });
              });
              return;
            }
            settleFrame.current = undefined;
          }),
        );
      }
    }
    setUnseenCount(0);
    setShowJump(false);
  };

  // Follow the conversation: sending your own message glides down to it (even
  // from scrolled-up), streaming growth sticks instantly while already at the
  // bottom, and anything arriving while scrolled up feeds the "new message"
  // pill instead.
  //
  // Opening a *different* conversation is none of those things, and has to be
  // taken out first. `prevMessageCount` belongs to the thread being left, so
  // `arrived` there subtracts one transcript's length from another's: switch
  // to a longer thread whose last line happens to be the user's own — you sent
  // something and clicked away — and this read "the user just sent a message",
  // and glided. That glide is the chat visibly shooting upward out of sight:
  // `scroll-behavior: smooth` animates toward the extent measured when it
  // started, while the transcript underneath is still settling into a shorter
  // one, so it sails past the end into blank space and stays there (the engine
  // re-clamps only on the next real scroll, which is the small flick that
  // brings it back). Nor does the smooth path get the instant path's settling
  // re-pin. A conversation opens at its bottom, instantly, always.
  // biome-ignore lint/correctness/useExhaustiveDependencies(scrollToLatest): stable helper
  useLayoutEffect(() => {
    // Still opening until the transcript is here — or until the user sends,
    // which `send` treats as the end of opening on its own, so a brand new
    // Blob with no stored history to wait for follows the ordinary send path.
    const opening = openingRef.current;
    if (opening && messages.length > 0) {
      openingRef.current = false;
    }
    const arrived = messages.length - prevMessageCount.current;
    prevMessageCount.current = messages.length;
    if (scrollRef.current === null) {
      return;
    }
    if (opening) {
      // Ahead of the passive reset below, which runs after this one and would
      // otherwise leave the pin reading the departed conversation's flags.
      autoScrollRef.current = false;
      nearBottomRef.current = true;
      scrollToLatest("instant", true);
      return;
    }
    const latest = messages.at(-1);
    if (arrived > 0 && latest?.kind === "text" && latest.author === "user") {
      scrollToLatest("smooth");
      return;
    }
    if (nearBottomRef.current) {
      scrollToLatest("instant");
      return;
    }
    if (arrived > 0) {
      setUnseenCount((count) => count + arrived);
    }
    // `messages` alone: the parent rebuilds it inline every render, so a
    // conversation switch always brings a new array with it, and `opening` —
    // set during render — already carries which conversation this is.
  }, [messages]);

  // Auto-grow the textarea toward the cap, animating between the measured
  // heights. The transient `auto` never paints, so the height transition runs
  // from the previous pixel value to the new one.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) {
      return;
    }
    // The measurement below moves the transcript, and that is the composer's
    // best-known jump: `height: auto` on a `rows={1}` textarea does not resolve
    // to the content height, it collapses the field to one line. Reading
    // `scrollHeight` forces layout in that collapsed state, the scroller above
    // grows by the lines the composer just gave back, and the engine clamps
    // scrollTop down to the shorter extent. Restoring the height does not undo
    // a clamp — so the transcript stays one line low until some later resize
    // re-pins it, which is the drop-and-spring-back seen while typing.
    //
    // Nothing here is allowed to paint, so the position is simply put back
    // where the keystroke found it. Via `scrollTo`, because the pane sets
    // `scroll-behavior: smooth` and an assignment to `scrollTop` would animate
    // this correction into the very glide it exists to prevent.
    const scroller = scrollRef.current;
    const parked = scroller?.scrollTop;
    const previous = el.offsetHeight;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT);
    el.style.height = `${previous}px`;
    void el.offsetHeight; // commit the starting point before animating
    el.style.height = `${next}px`;
    if (scroller !== null && parked !== undefined && scroller.scrollTop !== parked) {
      scroller.scrollTo({ top: parked, behavior: "instant" });
    }
    el.style.overflowY = next >= COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
    // A completed mention asked for the caret to land mid-draft; the value is
    // on screen now, so this is the first moment the range is valid.
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    // Past five lines the textarea scrolls; the mirror has to scroll with it
    // or the colours drift away from the words they belong to.
    if (mirrorRef.current !== null) {
      mirrorRef.current.scrollTop = el.scrollTop;
    }
    // simplification: sticky until the draft is cleared — the expanded layout
    // widens the textarea, so re-measuring there would flip-flop for text that
    // only wraps at the narrow inline width.
    if (draft.length === 0) {
      setMultiline(false);
    } else if (next > COMPOSER_LINE_HEIGHT) {
      setMultiline(true);
    }
  }, [draft]);

  const hasDraft = draft.trim().length > 0 || attached.length > 0;

  /** Take picked or dropped files, up to the cap; the rest are dropped here
      rather than sent and rejected one by one downstream. */
  const addFiles = (picked: FileList | readonly File[] | null) => {
    // A group has no home folder to save into, so a file dropped or pasted
    // here would be shown as a chip and then silently discarded on send. The
    // attach button is already hidden; this is the same rule for every other
    // way a file can arrive.
    if (picked === null || group !== undefined) {
      return;
    }
    // The thumbnail promise is started here and kept on the entry, so a send
    // that lands before it resolves can await it rather than shipping the
    // message without its picture.
    const incoming = [...picked].map((file) => ({
      id: crypto.randomUUID(),
      file,
      pending: imagePreview(file),
    }));
    if (incoming.length === 0) {
      return;
    }
    setAttached((previous) => [...previous, ...incoming].slice(0, MAX_ATTACHMENTS));
    textareaRef.current?.focus();
    // Thumbnails fill in behind the tiles. Object URLs would be faster, but
    // they need revoking on every removal path; these are small and the same
    // data URL the sent message will carry.
    for (const entry of incoming) {
      void entry.pending.then((preview) => {
        if (preview === undefined) {
          return;
        }
        setAttached((previous) =>
          previous.map((item) => (item.id === entry.id ? { ...item, preview } : item)),
        );
      });
    }
  };

  /** The circle shows Stop only with an empty composer: a draft typed mid-turn
      is a follow-up that steers the running loop, so Send must stay reachable. */
  const showStop = canStop && !hasDraft;

  // FLIP: whenever a composer control lands somewhere new (layout switch or
  // reply chip appearing), glide it from its old position instead of
  // teleporting. Rects are recorded every render so they never go stale, but
  // glides only play when layout-changing state moved — animating per
  // keystroke would measure mid-transition rects and jitter the buttons on
  // every character. The send button's mic→arrow swap is deliberately not a
  // trigger: it has its own pop-in and the mic's small shift should be
  // instant.
  const flipTrigger = `${multiline}|${replyTo !== null}|${attached.length > 0}`;
  const lastFlipTrigger = useRef(flipTrigger);
  useLayoutEffect(() => {
    const form = composerRef.current;
    if (form === null) {
      return;
    }
    const shouldAnimate = flipTrigger !== lastFlipTrigger.current;
    lastFlipTrigger.current = flipTrigger;
    const reduced =
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const el of form.querySelectorAll<HTMLElement>("[data-flip]")) {
      const key = el.dataset.flip as string;
      const next = el.getBoundingClientRect();
      const prev = flipRects.current.get(key);
      flipRects.current.set(key, next);
      if (prev === undefined || !shouldAnimate || reduced || typeof el.animate !== "function") {
        continue;
      }
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      const grewBy = prev.width - next.width;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(grewBy) < 1) {
        continue;
      }
      // The textarea also changes width between layouts; animating the used
      // width lets its text (and caret) rewrap gradually instead of snapping.
      const animateWidth = Math.abs(grewBy) >= 1;
      const from: Keyframe = { transform: `translate(${dx}px, ${dy}px)` };
      const to: Keyframe = { transform: "translate(0, 0)" };
      if (animateWidth) {
        from.width = `${prev.width}px`;
        to.width = `${next.width}px`;
      }
      // Duration/easing must match --duration-compose/--ease-standard so the
      // glides land together with the textarea's height transition.
      el.animate([from, to], { duration: 160, easing: "cubic-bezier(0.3, 0, 0.2, 1)" });
    }
  });

  const send = () => {
    const text = draft.trim();
    // Files alone are a valid message: "here, look at this".
    if (text.length === 0 && attached.length === 0) {
      return;
    }
    // Typing into a conversation means it is open, not opening — whatever the
    // transcript looks like. A brand new Blob has no stored history to wait
    // for, so without this its first message would arrive while the pane still
    // considered itself mid-hydration, be snapshotted as "already on screen",
    // and appear without the pop-in every later message gets.
    openingRef.current = false;
    const replying = replyTo !== null && !replyClosing ? replyTo : undefined;
    const reply =
      replying === undefined ? {} : { replyTo: replying.preview, replyToId: replying.id };
    // Cleared first, so the composer empties on this frame however long the
    // thumbnails take.
    const sending = attached;
    // The composer's collapse has to land *before* the message does, not after.
    // Clearing the draft leaves the auto-grow effect below to shrink the
    // textarea — but that effect runs after the scroll pin, and animates, so
    // the new bubble popped in and then rode 160ms of the transcript growing
    // into the ~80px the composer was giving back: the insert-then-reposition
    // stutter. Snapped here, inside the handler, the whole collapse is part of
    // the layout the message arrives into, and the pin measures a final
    // extent. The effect still runs and simply re-sets the height it finds.
    const field = textareaRef.current;
    if (field !== null) {
      field.style.transition = "none";
      field.style.height = `${COMPOSER_LINE_HEIGHT}px`;
      field.style.overflowY = "hidden";
      void field.offsetHeight; // land the collapse before transitions return
      field.style.transition = "";
    }
    // Same commit, same reason: the expanded layout's second button row is
    // composer height too, and dropping it a render later moves the ground
    // under a bubble that has already drawn.
    setMultiline(false);
    setDraft("");
    // Sent, so there is nothing left to keep.
    rememberDraft("");
    setAttached([]);
    setMention(null);
    closeReply();

    if (sending.length === 0) {
      onSend(text, reply);
      return;
    }
    // The thumbnail rides along: the composer already made it, and rebuilding
    // it after the send is what made the picture pop in a beat late. Sending
    // within a few hundred ms of picking is normal, so an unresolved one is
    // awaited rather than dropped.
    void Promise.all(
      sending.map(async ({ file, preview, pending }) => {
        // A picture is worth a short wait, never a stuck send.
        const settled =
          preview ??
          (await Promise.race([
            pending.catch(() => undefined),
            new Promise<undefined>((resolve) => setTimeout(resolve, PREVIEW_WAIT_MS, undefined)),
          ]));
        return { file, ...(settled === undefined ? {} : { preview: settled }) };
      }),
    ).then((files) => onSend(text, { ...reply, files }));
  };

  /**
   * Members whose name starts with what has been typed after the "@".
   *
   * Empty means the menu is closed — which, with spaces allowed in the prefix,
   * is also what dismisses it when the "@" turns out to be prose rather than
   * an address.
   */
  const mentionMatches =
    mention === null || group === undefined
      ? []
      : group.members
          .filter((member) => member.name.toLowerCase().startsWith(mention.toLowerCase()))
          .slice(0, MAX_MENTION_OPTIONS);

  /**
   * Track the partial "@name" the caret sits in, so the member list can offer
   * completions. Only ever the token being typed — an "@" the caret has moved
   * away from is finished text, not a menu.
   */
  const trackMention = (value: string, caret: number) => {
    if (group === undefined) {
      return;
    }
    const typed = MENTION_TOKEN.exec(value.slice(0, caret));
    const prefix = typed?.[1] ?? null;
    setMention(prefix);
    setMentionIndex(prefix === null || prefix === "" ? null : 0);
  };

  /** Replace the half-typed "@na" under the caret with the member's full name. */
  const completeMention = (name: string) => {
    const field = textareaRef.current;
    const caret = field?.selectionStart ?? draft.length;
    const typed = MENTION_TOKEN.exec(draft.slice(0, caret));
    if (typed === null) {
      return;
    }
    const start = caret - typed[0].length + (typed[0].startsWith("@") ? 0 : 1);
    const completed = `${draft.slice(0, start)}@${name} ${draft.slice(caret)}`;
    setDraft(completed);
    rememberDraft(completed);
    setMention(null);
    // Put the caret after the inserted name, not at the end of the draft:
    // mentions are often typed mid-sentence. Handed to the layout effect
    // below rather than set from a frame callback — anything typed before that
    // frame ran landed at the old caret, scrambling the words after it.
    pendingCaret.current = start + name.length + 2;
    field?.focus();
  };

  // Animate the chip out; it unmounts when the exit animation finishes.
  // Where animations never run (reduced motion, jsdom), close immediately
  // since animationend would never fire.
  const closeReply = () => {
    if (replyTo === null) {
      return;
    }
    if (
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setReplyTo(null);
      return;
    }
    setReplyClosing(true);
  };

  const startReply = (message: Message) => {
    setReplyTo({ id: message.id, preview: messagePreview(message) });
    setReplyClosing(false);
    setPickerFor(null);
    textareaRef.current?.focus();
  };

  const toggleReaction = (messageId: string, emoji: string) => {
    setReactions((previous) => {
      const next = { ...previous };
      if (next[messageId] === emoji) {
        delete next[messageId];
      } else {
        next[messageId] = emoji;
      }
      return next;
    });
    setPickerFor(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The @-menu owns the arrows, Tab, Enter and Escape while it is open:
    // Enter must complete the mention, not send a half-typed one.
    if (mentionMatches.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        // From "nothing highlighted", Down takes the first option and Up the
        // last — either arrow is a deliberate first move.
        setMentionIndex((index) => {
          if (index === null) {
            return event.key === "ArrowDown" ? 0 : mentionMatches.length - 1;
          }
          const step = event.key === "ArrowDown" ? 1 : mentionMatches.length - 1;
          return (index + step) % mentionMatches.length;
        });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        // Tab always completes — that is what Tab means in a list like this.
        // Enter only completes something actually highlighted, so pressing it
        // against a bare “@” sends the message instead of picking for you.
        const picked =
          mentionIndex === null
            ? event.key === "Tab"
              ? mentionMatches[0]
              : undefined
            : mentionMatches[mentionIndex];
        if (picked !== undefined) {
          event.preventDefault();
          completeMention(picked.name);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    // Enter sends; Shift+Enter inserts a newline; Escape cancels a reply
    // (unless a reply is streaming — then the window handler stops it).
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape" && !canStop && replyTo !== null) {
      closeReply();
    }
  };

  return (
    <section
      className="chat-pane"
      aria-label={group === undefined ? `Conversation with ${agent.name}` : `Group ${group.name}`}
    >
      <header className="chat-header" data-tauri-drag-region>
        {/* drag-region only fires on the element itself, so the header stays
            draggable around this identity button. */}
        {/* Both identities live in this box during a switch: the outgoing one
            is taken out of flow and slides up and away, the incoming one keeps
            the layout and rises into its place.

            Keyed by the conversation, so switching Blobs remounts the incoming
            identity and replays its entrance. A transition cannot do this: the
            avatar and the name swap in the same frame with no state in
            between, so there is nothing for CSS to interpolate. Not keyed on
            the group's NAME — that would restart the animation on every
            keystroke of a rename, mid-edit. */}
        <div className="chat-header-swap">
          {leaving === null ? null : (
            // aria-hidden and inert: a screen reader announcing the conversation
            // you just left, or a tab stop landing on it, is worse than no
            // animation at all. It is a picture of the old header, nothing more.
            <div
              key={leaving.key}
              className={
                leaving.solo
                  ? "chat-header-identity identity-button chat-header-identity-leaving"
                  : "chat-header-identity chat-header-identity-leaving"
              }
              aria-hidden="true"
            >
              <span className="chat-group-faces">
                {leaving.faces.map((face) => (
                  <BlobAvatar key={face.id} tone={face.tone} shape={face.shape} size={24} />
                ))}
              </span>
              {/* An h1 like the live title, not a span: a different element
                  means a different line box, and the ghost's text would sit a
                  pixel off its replacement's — leaving a sliver where both are
                  visible at once instead of one clean cut. */}
              <h1 className="chat-title">{leaving.name}</h1>
              {leaving.count === null ? null : (
                <span className="chat-group-count">{leaving.count}</span>
              )}
            </div>
          )}
          {group === undefined ? (
            <button
              key={agent.id}
              type="button"
              className="chat-header-identity identity-button"
              aria-label={`${agent.name} settings`}
              onClick={onOpenSettings}
            >
              <BlobAvatar tone={agent.tone} shape={agent.shape} size={24} />
              <h1 className="chat-title">{agent.name}</h1>
            </button>
          ) : (
            <div key={group.id} className="chat-header-identity">
              <span className="chat-group-faces" aria-hidden="true">
                {group.members.slice(0, 3).map((member) => (
                  <BlobAvatar key={member.id} tone={member.tone} shape={member.shape} size={24} />
                ))}
              </span>
              {/* The title is the rename field: there is nowhere else to edit
                it, and a name nobody can change stays "New Group" forever.
                Commit on blur or Enter; Escape abandons the edit. */}
              <input
                className="chat-title chat-title-input"
                aria-label="Group name"
                value={nameDraft ?? group.name}
                maxLength={MAX_BLOB_NAME_LENGTH}
                onChange={(event) => editName(event.currentTarget.value)}
                onBlur={() => {
                  if (nameDraftRef.current !== null) {
                    onRenameGroup?.(nameDraftRef.current);
                  }
                  editName(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    editName(null);
                    event.currentTarget.blur();
                  }
                }}
              />
              <span className="chat-group-count">
                {group.members.length === 1 ? "1 Blob" : `${group.members.length} Blobs`}
              </span>
            </div>
          )}
        </div>
        <div className="chat-header-controls">
          <PillSelect
            id="header-thinking"
            label="Thinking"
            value={reasoning ? "on" : "off"}
            onChange={(value) => onReasoningChange(value === "on")}
          >
            <option value="off">Thinking off</option>
            <option value="on">Thinking on</option>
          </PillSelect>
          {/* Re-read the list as the menu opens: it may have been empty at
              mount (Ollama still starting) or gone stale since. */}
          <PillSelect
            id="header-model"
            label="Model"
            value={model}
            onChange={onModelChange}
            onOpen={refreshModels}
          >
            <option value="">Choose a model</option>
            {model !== "" &&
            !availableModels.some((entry) => entry.name === model) &&
            !tinfoilModels.some((entry) => `${TINFOIL_MODEL_PREFIX}${entry.id}` === model) ? (
              <option value={model}>{model}</option>
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
          {/* The details panel is one Blob's memories, files and routines —
              there is no group-wide version of it. */}
          {onTeach === undefined ? null : (
            <button
              type="button"
              className="icon-button"
              aria-label={`Teach ${agent.name} by demonstration`}
              title={`Teach ${agent.name} by demonstration`}
              disabled={teaching === true}
              onClick={onTeach}
            >
              <GraduationCap size={17} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          {group === undefined ? (
            <button
              type="button"
              className="icon-button"
              aria-label={detailOpen ? "Hide details panel" : "Show details panel"}
              aria-pressed={detailOpen}
              onClick={onToggleDetail}
            >
              <Monitor size={17} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      <div
        className="message-scroll"
        role="log"
        aria-label="Messages"
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          // A forced re-render detaches this scroller, which resets its scroll
          // position to 0; putting it back fires this handler. That is our own
          // repair passing through, not the user — and it arrives looking like
          // "scrolled to the very top", which would page in more history every
          // single time. Nothing below should see it.
          if (rerenderingRef.current) {
            noteMetrics(el);
            return;
          }
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          // Near the top with older messages hidden: reveal another page.
          // The anchor guard also debounces re-entry while the page mounts.
          if (
            el.scrollTop < 200 &&
            visibleCount < messages.length &&
            loadAnchorRef.current === null
          ) {
            loadAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
            setVisibleCount((count) => count + MESSAGE_PAGE_SIZE);
          }
          // Reflow from a pane resize is not the user scrolling: the scroll
          // events it fires would flip this to "scrolled up" and raise the
          // jump arrow over a conversation nobody left.
          if (resizingRef.current !== null) {
            noteMetrics(el);
            return;
          }
          // The same reflow, one beat EARLIER than that flag can help.
          //
          // A resize burst is bracketed by `resizingRef`, but the first frame
          // of it is not: the engine fires this scroll event before the
          // ResizeObserver callback that opens the bracket. So the sidebar's
          // very first reflow frame arrives here as an ordinary scroll, flips
          // the flag to "scrolled up", and the observer — which decides once,
          // by reading exactly that flag — then declines to hold the bottom.
          // The transcript is left walked off the top of the viewport, and
          // only a real scroll brings it back. Bracketing cannot fix this;
          // the decision is poisoned before the bracket exists.
          //
          // What separates the two is measurable without any timing: the user
          // scrolling moves `scrollTop` at a constant `scrollHeight`, while a
          // reflow (or a streamed delta) changes `scrollHeight` under a
          // `scrollTop` that has not moved. Both conditions are required, so
          // scrolling away *during* streaming growth still counts as intent —
          // the position moved — and the pane does not fight the user.
          const last = lastMetrics.current;
          const grew = el.scrollHeight !== last.height;
          const moved = Math.abs(el.scrollTop - last.top) > 1;
          noteMetrics(el);
          if (grew && !moved) {
            return;
          }
          // A glide we started passes through "scrolled up" positions; ignore
          // those until it lands so it isn't mistaken for user intent.
          if (autoScrollRef.current) {
            if (nearBottom) {
              autoScrollRef.current = false;
              setShowJump(false);
            }
            return;
          }
          nearBottomRef.current = nearBottom;
          setShowJump(!nearBottom);
          if (nearBottom) {
            setUnseenCount(0);
          }
        }}
      >
        {/* Keyed on the conversation, so a crash caused by one transcript is
            not still on screen after switching to another. `inline`: the
            roster and the composer outlive one unrenderable message. */}
        <ErrorBoundary inline key={group?.id ?? agent.id}>
          {(messages.length > visibleCount ? messages.slice(-visibleCount) : messages).flatMap(
            (message) => {
              // The registry picks the view; a kind this build has never heard of
              // gets a placeholder here rather than an exception in the pane.
              const failed = message.kind === "text" && message.failed === true;
              const card = messageCard(message, {
                palette,
                // Only a failed turn is offered a way back; every other
                // message would just carry two dead buttons.
                ...(failed && onRetry !== undefined ? { onRetry: () => onRetry(message) } : {}),
                ...(failed && onDismiss !== undefined
                  ? { onDismiss: () => onDismiss(message.id) }
                  : {}),
              });
              return [
                ...(dividers.has(message.id)
                  ? [
                      <p className="timestamp-divider" key={`${message.id}-divider`}>
                        {dividers.get(message.id)}
                      </p>,
                    ]
                  : []),
                // Status lines are not speech: no bubble, no hover bar, no reactions.
                card.standalone ? (
                  <Fragment key={message.id}>{card.node}</Fragment>
                ) : (
                  <MessageRow
                    fresh={!initialIds.current.has(message.id)}
                    onPopped={() => markPopped(message.id)}
                    key={message.id}
                    message={message}
                    card={card.node}
                    author={
                      message.kind === "text"
                        ? group?.members.find((member) => member.id === message.authorId)
                        : undefined
                    }
                    reaction={reactions[message.id]}
                    pickerOpen={pickerFor === message.id}
                    stale={hoverId !== undefined && hoverId !== message.id}
                    reading={readingMessages.includes(message.id)}
                    onEnter={() => setHoverId(message.id)}
                    onTogglePicker={() =>
                      setPickerFor(pickerFor === message.id ? null : message.id)
                    }
                    onReact={(emoji) => toggleReaction(message.id, emoji)}
                    onReply={() => startReply(message)}
                    onOpenThread={
                      onOpenThread === undefined ? undefined : () => onOpenThread(message)
                    }
                    replyCount={threadReplyCounts[message.id]}
                  />
                ),
              ];
            },
          )}
        </ErrorBoundary>
        {/* Always mounted: reserves its space (nothing overlaps or jumps) and
            lets the blob fade in/out instead of popping with the DOM. */}
        <div
          className={thinking ? "thinking-row thinking-row-visible" : "thinking-row"}
          role="status"
          aria-hidden={!thinking}
          aria-label={thinking ? `${(thinkingAgent ?? agent).name} is thinking` : undefined}
        >
          <BlobAvatar
            tone={(thinkingAgent ?? agent).tone}
            shape={(thinkingAgent ?? agent).shape}
            size={30}
            variant="thinking"
          />
        </div>
        {waitingAsk === "action" ? (
          <div className="ask-action-bar" role="status">
            <span>{(waitingAskAgent ?? agent).name} needs you to do something above.</span>
            <button type="button" className="ask-action-done" onClick={() => onSend("Done.")}>
              Done
            </button>
          </div>
        ) : null}
        {/* Sits in the transcript flow, under the last message, because that
            is where the unsaved messages are. `alert`, not `status`: this is
            about to cost the user data, and it stays until a save succeeds. */}
        {notSaving ? (
          <div className="not-saving-bar" role="alert">
            <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />
            <span>
              This conversation is too long to save. New messages stay on screen but will be lost
              when you quit — start a new chat to keep them.
            </span>
          </div>
        ) : null}
      </div>

      {unseenCount > 0 ? (
        <div className="new-messages-pill" role="status">
          <button type="button" className="new-messages-jump" onClick={() => scrollToLatest()}>
            <ArrowDown size={15} strokeWidth={2} aria-hidden="true" />
            {unseenCount === 1 ? "1 new message" : `${unseenCount} new messages`}
          </button>
          <button
            type="button"
            className="new-messages-dismiss"
            aria-label="Dismiss new message notice"
            onClick={() => setUnseenCount(0)}
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ) : showJump ? (
        // The "new message" pill above takes priority: both jump to the
        // bottom, but the pill also says why.
        <div className="scroll-bottom-wrap">
          <button
            type="button"
            className="scroll-bottom-button"
            aria-label="Scroll to bottom"
            onClick={() => scrollToLatest()}
          >
            <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <form
        ref={composerRef}
        className={[
          "composer",
          multiline || replyTo !== null || attached.length > 0 ? "composer-expanded" : "",
          dragging ? "composer-dragging" : "",
        ]
          .filter((entry) => entry !== "")
          .join(" ")}
        onSubmit={submit}
        // Dropping a file anywhere on the composer attaches it. preventDefault
        // on dragover is what makes the drop fire at all; without it the
        // webview navigates away to the file instead.
        onDragOver={(event) => {
          event.preventDefault();
        }}
        // Counted, not tested against `relatedTarget`: this app runs in a
        // WKWebView, where dragenter and dragleave always report a null
        // related target (WebKit bug 66547, open since 2011). The containment
        // check that reads correctly everywhere else is therefore always
        // false here — so crossing onto the textarea, a file chip or the send
        // button read as leaving, and the highlight flickered the whole way
        // across the composer. A child entered is one enter and one leave, so
        // the depth only reaches zero when the pointer really is out.
        onDragEnter={() => {
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) {
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          // A drop ends the drag outright, however deep it was.
          dragDepth.current = 0;
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
      >
        {attached.length === 0 ? null : (
          <ul className="composer-attachments" aria-label="Attached files">
            {attached.map(({ id, file, preview }) => (
              <li key={id} className={preview === undefined ? "composer-file" : "composer-thumb"}>
                {preview === undefined ? (
                  <>
                    <span
                      className={`attachment-card-icon attachment-kind-${fileKind(file.name)}`}
                      aria-hidden="true"
                    >
                      <FileText size={16} strokeWidth={1.8} />
                      <span className="attachment-card-badge">{fileBadge(file.name)}</span>
                    </span>
                    <span className="composer-file-text">
                      <span className="attachment-card-name">{file.name}</span>
                      <span className="attachment-card-size">{fileSize(file.size)}</span>
                    </span>
                  </>
                ) : (
                  <img src={preview} alt={file.name} title={file.name} draggable={false} />
                )}
                <button
                  type="button"
                  className="icon-button attachment-remove"
                  aria-label={`Remove ${file.name}`}
                  onClick={() =>
                    setAttached((previous) => previous.filter((entry) => entry.id !== id))
                  }
                >
                  <X size={12} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {replyTo === null ? null : (
          <div
            className={replyClosing ? "composer-reply composer-reply-closing" : "composer-reply"}
            onAnimationEnd={() => {
              if (replyClosing) {
                setReplyTo(null);
                setReplyClosing(false);
              }
            }}
          >
            <CornerUpRight size={13} strokeWidth={1.8} aria-hidden="true" />
            <span className="composer-reply-text">{replyTo.preview}</span>
            <button
              type="button"
              className="icon-button composer-reply-cancel"
              aria-label="Cancel reply"
              onClick={closeReply}
            >
              <X size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        )}
        {mentionMatches.length === 0 ? null : (
          <ul className="composer-mentions" aria-label="Mention a Blob">
            {mentionMatches.map((member, index) => (
              <li key={member.id}>
                <button
                  type="button"
                  className={
                    index === mentionIndex
                      ? "composer-mention composer-mention-active"
                      : "composer-mention"
                  }
                  // The textarea would blur before the click landed, and the
                  // blur closes the menu.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => completeMention(member.name)}
                >
                  <BlobAvatar tone={member.tone} shape={member.shape} size={18} />
                  {member.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-main">
          {/* Both, or neither: a file is saved in one Blob's home folder and
              read back from there at turn time, and a group has no home of its
              own — so a group pane takes no files by any route (drag and paste
              are refused in `addFiles` for the same reason). */}
          {group === undefined ? (
            <>
              <button
                type="button"
                className="icon-button composer-add"
                aria-label="Add attachment"
                data-flip="add"
                disabled={attached.length >= MAX_ATTACHMENTS}
                onClick={() => fileInputRef.current?.click()}
              >
                <Plus size={16} strokeWidth={2} aria-hidden="true" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="visually-hidden"
                aria-label="Attach files"
                onChange={(event) => {
                  addFiles(event.currentTarget.files);
                  // Reset so picking the same file twice in a row still fires.
                  event.currentTarget.value = "";
                }}
              />
            </>
          ) : null}
          {/* The field is the textarea plus a coloured copy of the draft
              underneath it, so the mentions you are typing already carry
              their Blob's colour. A textarea cannot hold styled runs at all,
              and a contenteditable would cost IME handling, undo and paste
              sanitising — for a highlight.

              The wrapper carries `data-flip` in the textarea's place: it
              occupies exactly the box the textarea used to, so the composer's
              FLIP glides are unchanged. */}
          <div className="composer-field" data-flip="input">
            {/* `partial`: the name being typed is coloured as soon as one Blob
                can complete it, so the colour arrives with the word rather
                than on its final character. */}
            {palette === undefined || draft === "" ? null : (
              <div className="composer-mirror" aria-hidden="true" ref={mirrorRef}>
                {withMentions(draft, palette, { partial: true })}
              </div>
            )}
            <textarea
              ref={textareaRef}
              rows={1}
              className={
                palette === undefined ? "composer-input" : "composer-input composer-input-mirrored"
              }
              placeholder={
                replyTo !== null
                  ? "Reply..."
                  : group === undefined
                    ? `Message ${agent.name}`
                    : `Message ${group.name} \u2014 @ a Blob to ask just them`
              }
              aria-label={`Message ${group === undefined ? agent.name : group.name}`}
              value={draft}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                rememberDraft(event.currentTarget.value);
                trackMention(event.currentTarget.value, event.currentTarget.selectionStart);
              }}
              // The caret can leave a half-typed mention without the text
              // changing at all — an arrow key or a click closes the menu.
              onSelect={(event) =>
                trackMention(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onBlur={() => setMention(null)}
              onKeyDown={onComposerKeyDown}
              // Keeps the coloured mirror aligned once the draft outgrows the
              // five-line cap and the textarea starts scrolling.
              onScroll={(event) => {
                if (mirrorRef.current !== null) {
                  mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
                }
              }}
              // A pasted file attaches; every paste without one (plain text,
              // a link) falls through to the default handler untouched.
              onPaste={(event) => {
                if (event.clipboardData.files.length > 0) {
                  event.preventDefault();
                  addFiles(event.clipboardData.files);
                }
              }}
            />
          </div>
          {/* One circle, fixed position: its glyph cross-fades arrow↔stop.
              With an empty composer mid-reply it is the Stop button (Escape
              does the same), so the control that starts a turn also ends it.
              Idle with nothing typed it is a disabled Send — there is no
              dictation to offer yet. */}
          <button
            type={hasDraft ? "submit" : "button"}
            className="composer-mic"
            aria-label={showStop ? "Stop replying" : "Send message"}
            data-flip="mic"
            data-stop={showStop}
            disabled={!hasDraft && !showStop}
            onClick={showStop ? onStop : undefined}
          >
            <span className="composer-mic-glyph" data-visible={!showStop}>
              <ArrowUp size={17} strokeWidth={2.4} aria-hidden="true" />
            </span>
            <span className="composer-mic-glyph" data-visible={showStop}>
              <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </span>
          </button>
        </div>
      </form>
    </section>
  );
}
