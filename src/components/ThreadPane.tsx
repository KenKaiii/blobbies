import { ArrowLeft, X } from "lucide-react";
import { useEffect, useRef } from "react";
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  if (speaker === undefined) return null;
  return (
    <aside className="thread-pane" aria-labelledby="thread-pane-title">
      <header className="thread-pane-header">
        <h2 id="thread-pane-title" ref={headingRef} tabIndex={-1}>
          Thread
        </h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close thread"
          onClick={props.onClose}
        >
          <ArrowLeft className="thread-back-icon" size={16} aria-hidden="true" />
          <X className="thread-close-icon" size={16} aria-hidden="true" />
          <span className="thread-action-label thread-action-label-back">Back to channel</span>
          <span className="thread-action-label thread-action-label-close">Close</span>
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
        headerMode="embedded"
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
