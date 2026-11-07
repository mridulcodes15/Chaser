import { ArrowRight, Send } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { DraftCard, ErrorNote, Notice, type ProviderMode } from "../components";
import { api, errorText, type Invoice } from "../lib";

type Draft = Invoice & { approval_id: number | null };

export interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  drafts?: Draft[];
}

const EXAMPLES = [
  "Bill Acme $2,400 for March brand work, net 15",
  "How much am I owed right now?",
  "Which invoices are overdue?",
];

export function Agent(props: {
  chat: ChatEntry[];
  setChat: (update: (chat: ChatEntry[]) => ChatEntry[]) => void;
  llmConfigured: boolean | undefined;
  mode: ProviderMode;
  onChanged: () => void;
}) {
  const { chat, setChat } = props;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [chat, busy]);

  const send = async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || busy) return;
    const next: ChatEntry[] = [...chat, { role: "user", content: trimmed }];
    setChat(() => next);
    setText("");
    setBusy(true);
    setError(undefined);
    try {
      const reply = await api<{ reply: string; drafts: Draft[] }>("/api/agent/chat", {
        method: "POST",
        body: { messages: next.slice(-20).map(({ role, content: c }) => ({ role, content: c })) },
      });
      setChat((all) => [...all, { role: "assistant", content: reply.reply, drafts: reply.drafts }]);
      props.onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(text);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(text);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Agent</h1>
          <p className="page-sub">Describe the work, or paste an email or contract. Nothing goes out until you approve it.</p>
        </div>
      </header>

      {props.llmConfigured === false && (
        <Notice tone="warn">The AI agent isn't set up: GROQ_API_KEY and GROQ_MODEL are both required.</Notice>
      )}

      <section className="panel chat" aria-live="polite">
        {chat.length === 0 && (
          <div className="chat-empty">
            <p>Try one of these:</p>
            <div className="prompt-list">
              {EXAMPLES.map((example) => (
                <button type="button" className="prompt" key={example} onClick={() => void send(example)}>
                  <ArrowRight size={13} aria-hidden />
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.map((entry, index) => (
          <div key={index} className={`turn turn-${entry.role}`}>
            <span className="turn-who">{entry.role === "user" ? "You" : "Chaser"}</span>
            <div className="turn-text">{entry.content}</div>
            {entry.drafts && entry.drafts.length > 0 && (
              <div className="turn-drafts">
                {entry.drafts.map((draft) => (
                  <DraftCard
                    key={`${draft.id}-${draft.revision}`}
                    invoice={draft}
                    approvalId={draft.approval_id}
                    mode={props.mode}
                    onChanged={props.onChanged}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="turn">
            <span className="turn-who">Chaser</span>
            <div className="turn-text muted">Working on it...</div>
          </div>
        )}
        <div ref={endRef} />
      </section>

      <ErrorNote message={error} />

      <form className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="chat-input">
          Message the agent
        </label>
        <textarea
          id="chat-input"
          rows={2}
          value={text}
          placeholder='For example: "Bill Acme $2,400 for March brand work, net 15"'
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
          <Send size={14} aria-hidden />
          Send
        </button>
      </form>
    </>
  );
}
