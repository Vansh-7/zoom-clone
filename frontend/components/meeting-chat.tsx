"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { MessageSquare, Send, X } from "lucide-react";
import type { ChatMessage, Participant } from "@/types";

function conversationId(message: ChatMessage, selfId: number) {
  if (message.recipient_id == null) return "everyone";
  return String(
    message.participant_id === selfId
      ? message.recipient_id
      : message.participant_id,
  );
}

export function MeetingChat({
  open,
  messages,
  participants,
  privateChatSupported,
  connected,
  selfId,
  send,
  onClose,
}: {
  open: boolean;
  messages: ChatMessage[];
  participants: Participant[];
  privateChatSupported: boolean;
  connected: boolean;
  selfId: number;
  send: (text: string, recipientId: number | null) => boolean;
  onClose: () => void;
}) {
  // Retain the exact session after departure; never redirect its draft to Everyone.
  const [recipient, setRecipient] = useState<Participant | null>(null);
  const key = recipient ? String(recipient.id) : "everyone";
  const others = participants.filter(
    (participant) => participant.id !== selfId,
  );
  const available =
    !recipient ||
    (privateChatSupported &&
      others.some((participant) => participant.id === recipient.id));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[key] ?? "";
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const visible = useMemo(
    () => messages.filter((message) => conversationId(message, selfId) === key),
    [messages, selfId, key],
  );
  const unreadCounts = new Map<string, number>();
  for (const message of messages) {
    if (message.participant_id === selfId || readIds.has(message.id)) continue;
    const conversation = conversationId(message, selfId);
    unreadCounts.set(conversation, (unreadCounts.get(conversation) ?? 0) + 1);
  }
  const conversations = [
    { id: "everyone", name: "Everyone (Group Chat)", participant: null },
    ...others.map((participant) => ({
      id: String(participant.id),
      name: participant.display_name,
      participant,
    })),
  ];
  const list = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const observed = useRef({ key: "", last: "" });
  const [newMessages, setNewMessages] = useState(false);
  const markRead = useCallback(() => {
    setReadIds(
      (current) =>
        new Set(
          messages
            .filter(
              (message) =>
                current.has(message.id) ||
                conversationId(message, selfId) === key,
            )
            .map((message) => message.id),
        ),
    );
    setNewMessages(false);
  }, [messages, selfId, key, setReadIds, setNewMessages]);

  useEffect(() => {
    if (!open || !list.current) return;
    const last = visible.at(-1)?.id ?? "";
    const switched = observed.current.key !== key;
    if (switched) nearBottom.current = true;
    if (switched || observed.current.last !== last) {
      if (nearBottom.current) {
        list.current.scrollTop = list.current.scrollHeight;
        markRead();
      } else setNewMessages(true);
    } else if (nearBottom.current) markRead();
    observed.current = { key, last };
  }, [open, visible, key, markRead]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (connected && available && send(draft, recipient?.id ?? null)) {
      nearBottom.current = true;
      setDrafts((current) => ({ ...current, [key]: "" }));
    }
  }
  const inputLabel = recipient
    ? `Message ${recipient.display_name} privately`
    : "Message everyone";
  return (
    <aside
      className="participants-panel chat-panel"
      aria-label="Meeting chat"
      hidden={!open}
    >
      <div className="participants-heading">
        <h2>Meeting chat</h2>
        <button
          className="icon-button"
          aria-label="Close chat"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      <p className="chat-scope">
        {recipient
          ? `Private conversation with ${recipient.display_name}`
          : "Everyone in this meeting"}
      </p>
      <div
        className="chat-messages"
        ref={list}
        role="log"
        aria-label="Messages"
        aria-live={open ? "polite" : "off"}
        onScroll={() => {
          const node = list.current!;
          nearBottom.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 60;
          if (nearBottom.current) markRead();
        }}
      >
        {visible.length ? (
          visible.map((message) => (
            <article
              className={`chat-message ${message.participant_id === selfId ? "chat-own" : ""}`}
              key={message.id}
            >
              <div className="chat-meta">
                <strong>
                  {message.participant_id === selfId
                    ? "You"
                    : message.display_name}
                </strong>
                {message.recipient_id != null && (
                  <span className="chat-private">Private</span>
                )}
                <time dateTime={message.sent_at}>
                  {new Date(message.sent_at).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p>{message.text}</p>
            </article>
          ))
        ) : (
          <div className="chat-empty">
            <MessageSquare size={28} />
            <p>Start a conversation</p>
            <span>
              {recipient
                ? "Messages are delivered only to you and this participant."
                : "Messages are visible to everyone in this meeting."}
            </span>
          </div>
        )}
      </div>
      {newMessages && (
        <button
          className="new-chat-messages"
          onClick={() => {
            if (list.current)
              list.current.scrollTop = list.current.scrollHeight;
            nearBottom.current = true;
            markRead();
          }}
        >
          New messages
        </button>
      )}
      {conversations.some(
        (conversation) =>
          conversation.id !== key && unreadCounts.has(conversation.id),
      ) && (
        <div
          className="chat-unread-conversations"
          aria-label="Unread conversations"
        >
          {conversations
            .filter(
              (conversation) =>
                conversation.id !== key && unreadCounts.has(conversation.id),
            )
            .map((conversation) => (
              <button
                key={conversation.id}
                onClick={() => setRecipient(conversation.participant)}
              >
                {conversation.name} ({unreadCounts.get(conversation.id)} unread)
              </button>
            ))}
        </div>
      )}
      <form className="chat-compose" onSubmit={submit}>
        <div className="chat-audience">
          <label htmlFor="chat-recipient">To:</label>
          <select
            id="chat-recipient"
            aria-label="Chat recipient"
            value={key}
            onChange={(event) => {
              const next = conversations.find(
                (conversation) => conversation.id === event.target.value,
              );
              if (next && (!next.participant || privateChatSupported))
                setRecipient(next.participant);
            }}
          >
            {conversations.map((conversation) => (
              <option
                value={conversation.id}
                key={conversation.id}
                disabled={!!conversation.participant && !privateChatSupported}
              >
                {conversation.name}
                {unreadCounts.has(conversation.id)
                  ? ` (${unreadCounts.get(conversation.id)} unread)`
                  : ""}
              </option>
            ))}
            {!available && recipient && (
              <option value={key} disabled>
                {recipient.display_name} (Left meeting)
              </option>
            )}
          </select>
        </div>
        {!available && (
          <p className="chat-unavailable" role="status">
            This participant left. Choose another recipient to send.
          </p>
        )}
        {!privateChatSupported && (
          <p className="chat-unavailable">
            Private chat is unavailable on this meeting server.
          </p>
        )}
        <label className="sr-only" htmlFor="chat-message">
          {inputLabel}
        </label>
        <textarea
          id="chat-message"
          placeholder={`${inputLabel}…`}
          value={draft}
          maxLength={2000}
          rows={3}
          onChange={(event) =>
            setDrafts((current) => ({ ...current, [key]: event.target.value }))
          }
          disabled={!connected || !available}
        />
        <div className="chat-send">
          <span>
            {connected ? `${draft.length}/2000` : "Reconnect to send"}
          </span>
          <button
            className="button primary small"
            disabled={!connected || !available || !draft.trim()}
          >
            <Send size={14} /> Send
          </button>
        </div>
      </form>
    </aside>
  );
}
