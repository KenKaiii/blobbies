import { ChatPane } from "@/components/ChatPane";
import type { Agent, Message } from "@/data/agents";
import type { Channel } from "@/lib/channels";

/**
 * A channel (Labs) on screen. ChatPane already knows how to render a shared
 * transcript — @mentions, per-speaker bubbles, the composer — so a channel is
 * a group-shaped room whose membership the channel owns (see lib/channels).
 * No rename yet: a group's rename moves its members' `section`, a channel's
 * would touch only itself, and that affordance arrives with member editing.
 */
export function ChannelPane(props: {
  channel: Channel;
  members: readonly Agent[];
  messages: Message[];
  notSaving?: boolean;
  thinking?: boolean;
  thinkingAgent?: Agent;
  model: string;
  onModelChange: (model: string) => void;
  reasoning: boolean;
  onReasoningChange: (on: boolean) => void;
  onSend: (text: string, options?: { replyTo?: string; replyToId?: string }) => void;
  onStop?: () => void;
  onOpenSettings: () => void;
}) {
  if (props.members.length === 0) {
    return (
      <section className="labs-pane" aria-label="Channels (Labs)">
        <header className="labs-pane-header" data-tauri-drag-region>
          #{props.channel.name}
        </header>
        <p className="labs-pane-header">
          No Blobs in this channel — add some from its member list.
        </p>
      </section>
    );
  }
  const speaker = props.members[0];
  if (speaker === undefined) {
    return null;
  }
  return (
    <ChatPane
      agent={speaker}
      group={{ id: props.channel.id, name: props.channel.name, members: props.members }}
      messages={props.messages}
      {...(props.notSaving === undefined ? {} : { notSaving: props.notSaving })}
      {...(props.thinking === undefined ? {} : { thinking: props.thinking })}
      {...(props.thinkingAgent === undefined ? {} : { thinkingAgent: props.thinkingAgent })}
      model={props.model}
      onModelChange={props.onModelChange}
      reasoning={props.reasoning}
      onReasoningChange={props.onReasoningChange}
      onSend={props.onSend}
      {...(props.onStop === undefined ? {} : { onStop: props.onStop })}
      detailOpen={false}
      onToggleDetail={() => {}}
      onOpenSettings={props.onOpenSettings}
    />
  );
}
