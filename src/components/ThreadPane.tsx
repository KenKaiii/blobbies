import { X } from "lucide-react";
import { ChatPane } from "@/components/ChatPane";
import type { Agent, Message } from "@/data/agents";

export function ThreadPane(props: {
  root: Message;
  members: readonly Agent[];
  messages: Message[];
  thinking?: boolean;
  thinkingAgent?: Agent;
  model: string;
  onModelChange: (model: string) => void;
  reasoning: boolean;
  onReasoningChange: (on: boolean) => void;
  onSend: (text: string, options?: { replyTo?: string; replyToId?: string }) => void;
  onStop?: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const speaker = props.members[0];
  if (speaker === undefined) return null;
  return (
    <aside className="thread-pane" aria-label="Thread">
      <header className="thread-pane-header">
        <strong>Thread</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="Close thread"
          onClick={props.onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="thread-root" data-message-id={props.root.id}>
        Original message
      </div>
      <ChatPane
        agent={speaker}
        group={{ id: props.root.id, name: "Thread", members: props.members }}
        messages={props.messages}
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
    </aside>
  );
}
