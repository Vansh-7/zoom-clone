"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageSquare, Send, X } from "lucide-react";
import type { ChatMessage } from "@/types";

export function MeetingChat({
  messages,
  connected,
  selfId,
  send,
  onClose,
}: {
  messages: ChatMessage[];
  connected: boolean;
  selfId: number;
  send: (text: string) => boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (send(draft)) setDraft("");
  }
  return (
    <aside className="participants-panel chat-panel" aria-label="Meeting chat">
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
      <p className="chat-audience">To: Everyone</p>
      <div
        className="chat-messages"
        ref={list}
        role="log"
        aria-label="Messages"
        aria-live="polite"
      >
        {messages.length ? (
          messages.map((message) => (
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
            <span>Messages are visible to everyone in this meeting.</span>
          </div>
        )}
      </div>
      <form className="chat-compose" onSubmit={submit}>
        <label className="sr-only" htmlFor="chat-message">
          Message everyone
        </label>
        <textarea
          id="chat-message"
          placeholder="Message everyone…"
          value={draft}
          maxLength={2000}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!connected}
        />
        <div>
          <span>
            {connected ? `${draft.length}/2000` : "Reconnect to send"}
          </span>
          <button
            className="button primary small"
            disabled={!connected || !draft.trim()}
          >
            <Send size={14} /> Send
          </button>
        </div>
      </form>
    </aside>
  );
}
