import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  Menu,
  MessageSquare,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from "lucide-react";

type Source = {
  title: string;
  page: number | null;
  excerpt: string;
  distance: number;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: Source[];
  created_at?: string;
};

type Conversation = {
  id: string;
  title: string;
  updated_at: string;
  message_count: number;
};

type DocumentInfo = {
  name: string;
  path: string;
  size: number;
  extension: string;
  uploaded: boolean;
};

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const PROMPTS = [
  {
    icon: Search,
    title: "Explore a document",
    prompt: "What are the key ideas in my documents?",
    tint: "violet",
  },
  {
    icon: FileText,
    title: "Find a specific detail",
    prompt: "Give me the Job Description of Facto.",
    tint: "blue",
  },
  {
    icon: BookOpen,
    title: "Summarize for me",
    prompt: "Summarize the most important findings in the project report.",
    tint: "amber",
  },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [indexedChunks, setIndexedChunks] = useState(0);
  const [draft, setDraft] = useState("");
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [docsOpen, setDocsOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await api<Conversation[]>("/api/conversations"));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load chats.");
    }
  }, []);

  const refreshDocuments = useCallback(async () => {
    try {
      const response = await api<{ documents: DocumentInfo[]; indexed_chunks: number }>(
        "/api/documents",
      );
      setDocuments(response.documents);
      setIndexedChunks(response.indexed_chunks);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load documents.");
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
    void refreshDocuments();
  }, [refreshConversations, refreshDocuments]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  const selectConversation = async (conversationId: string) => {
    setActiveId(conversationId);
    setMobileSidebarOpen(false);
    setLoadingMessages(true);
    setError("");
    try {
      setMessages(await api<Message[]>(`/api/conversations/${conversationId}/messages`));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load this chat.");
    } finally {
      setLoadingMessages(false);
    }
  };

  const newConversation = async () => {
    setError("");
    try {
      const conversation = await api<Conversation>("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      setConversations((current) => [conversation, ...current]);
      setActiveId(conversation.id);
      setMessages([]);
      setDraft("");
      setMobileSidebarOpen(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not start a new chat.");
    }
  };

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || streaming) return;

    setError("");
    setDraft("");
    setStreaming(true);
    let conversationId = activeId;
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      sources: [],
    };
    const assistantId = crypto.randomUUID();

    try {
      if (!conversationId) {
        const conversation = await api<Conversation>("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        conversationId = conversation.id;
        setActiveId(conversation.id);
        setConversations((current) => [conversation, ...current]);
      }

      setMessages((current) => [
        ...current,
        userMessage,
        { id: assistantId, role: "assistant", content: "", sources: [] },
      ]);
      const response = await fetch(
        `${API_BASE}/api/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, top_k: 5 }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.detail ?? `Request failed (${response.status})`);
      }
      if (!response.body) throw new Error("The server did not start a response stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError = "";
      const processEvent = (eventText: string) => {
        const lines = eventText.split("\n");
        const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        const payload = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!eventName || !payload) return;
        if (eventName === "sources") {
          const sources = JSON.parse(payload) as Source[];
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId ? { ...message, sources } : message,
            ),
          );
        } else if (eventName === "token") {
          const token = JSON.parse(payload) as string;
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, content: message.content + token }
                : message,
            ),
          );
        } else if (eventName === "error") {
          streamError = (JSON.parse(payload) as { detail: string }).detail;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        events.forEach(processEvent);
        if (done) break;
      }
      if (buffer.trim()) processEvent(buffer);
      if (streamError) throw new Error(streamError);
      await refreshConversations();
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Something went wrong.";
      setError(message);
      if (conversationId) {
        try {
          setMessages(
            await api<Message[]>(`/api/conversations/${conversationId}/messages`),
          );
          await refreshConversations();
        } catch (historyError) {
          setError(
            `${message} ${
              historyError instanceof Error
                ? `Conversation reload failed: ${historyError.message}`
                : "Conversation reload failed."
            }`,
          );
          setMessages((current) =>
            current.filter(
              (item) => item.id !== userMessage.id && item.id !== assistantId,
            ),
          );
        }
      } else {
        setMessages((current) =>
          current.filter(
            (item) => item.id !== userMessage.id && item.id !== assistantId,
          ),
        );
      }
      setDraft(content);
    } finally {
      setStreaming(false);
    }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    if (!files.length) return;
    setUploading(true);
    setError("");
    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append("file", file);
      try {
        await api<{ name: string; chunks_added: number }>("/api/documents/upload", {
          method: "POST",
          body: formData,
        });
      } catch (requestError) {
        setError(
          `${file.name}: ${requestError instanceof Error ? requestError.message : "Upload failed."}`,
        );
        break;
      }
    }
    await refreshDocuments();
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(true);
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void uploadFiles(event.dataTransfer.files);
  };

  return (
    <div
      className="app-shell"
      onDragOver={handleDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <aside className={`sidebar ${mobileSidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Sparkles size={18} strokeWidth={2.2} /></div>
          <div>
            <div className="brand-name">atlas<span>.</span></div>
            <div className="brand-caption">YOUR KNOWLEDGE, IN CONVERSATION</div>
          </div>
          <button
            className="icon-button sidebar-close"
            aria-label="Close navigation"
            onClick={() => setMobileSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <button className="new-chat-button" onClick={() => void newConversation()}>
          <Plus size={17} />
          <span>New conversation</span>
          <span className="shortcut">⌘ K</span>
        </button>

        <div className="sidebar-section-label">
          <span>YOUR CHATS</span>
        </div>
        <div className="conversation-list">
          {conversations.length === 0 ? (
            <div className="empty-sidebar">Your conversations will appear here.</div>
          ) : (
            conversations.map((conversation) => (
              <button
                key={conversation.id}
                className={`conversation-item ${activeId === conversation.id ? "conversation-active" : ""}`}
                onClick={() => void selectConversation(conversation.id)}
              >
                <MessageSquare size={15} />
                <span>{conversation.title}</span>
              </button>
            ))
          )}
        </div>

        <div className="sidebar-spacer" />
        <div className="library-card">
          <div className="library-topline">
            <span className="library-icon"><BookOpen size={16} /></span>
            <span className="library-count">{documents.length} files</span>
          </div>
          <div className="library-title">Your knowledge base</div>
          <div className="library-copy">
            {indexedChunks.toLocaleString()} searchable passages, ready when you are.
          </div>
          <button className="library-link" onClick={() => setDocsOpen(true)}>
            View documents <ArrowDown size={13} className="arrow-tilt" />
          </button>
        </div>
        <button
          className="upload-sidebar-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          <Upload size={15} />
          {uploading ? "Adding documents..." : "Add documents"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,.md,.csv"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void uploadFiles(event.target.files);
          }}
        />
        <div className="sidebar-footer">
          <span className="avatar">A</span>
          <div className="profile-copy"><strong>AI Workspace</strong><span>Personal knowledge hub</span></div>
          <ChevronDown size={15} />
        </div>
      </aside>

      {mobileSidebarOpen && (
        <button
          className="mobile-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobileSidebarOpen(true)}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumb">
            <span>Workspace</span><span className="breadcrumb-slash">/</span>
            <strong>{activeId ? conversations.find((item) => item.id === activeId)?.title ?? "Conversation" : "New conversation"}</strong>
          </div>
          <div className="topbar-actions">
            <div className="secure-pill"><ShieldCheck size={14} /><span>Private workspace</span></div>
            <button className="documents-button" onClick={() => setDocsOpen(true)}>
              <BookOpen size={15} /> <span>Documents</span>
            </button>
          </div>
        </header>

        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-content">
            {loadingMessages ? (
              <div className="loading-state"><div className="loader" /> Loading conversation…</div>
            ) : messages.length === 0 ? (
              <section className="welcome">
                <div className="welcome-orb"><Sparkles size={22} /></div>
                <div className="eyebrow"><span className="eyebrow-dot" /> YOUR AI KNOWLEDGE ASSISTANT</div>
                <h1>Good ideas start<br />with a <span>good question.</span></h1>
                <p className="welcome-description">
                  Ask anything about your documents. Atlas finds the relevant context and gives you a clear answer, with sources.
                </p>
                <div className="suggestion-grid">
                  {PROMPTS.map(({ icon: Icon, title, prompt, tint }) => (
                    <button className="suggestion-card" key={title} onClick={() => setDraft(prompt)}>
                      <span className={`suggestion-icon ${tint}`}><Icon size={17} /></span>
                      <span className="suggestion-title">{title}</span>
                      <span className="suggestion-prompt">{prompt}</span>
                      <ArrowUp size={15} className="suggestion-arrow" />
                    </button>
                  ))}
                </div>
                <div className="welcome-footnote">
                  <span className="footnote-line" />
                  <span>Grounded in your knowledge base</span>
                  <span className="footnote-line" />
                </div>
              </section>
            ) : (
              <section className="message-list" aria-live="polite">
                {messages.map((message) => (
                  <article className={`message-row ${message.role}`} key={message.id}>
                    {message.role === "assistant" ? (
                      <div className="assistant-avatar"><Sparkles size={15} /></div>
                    ) : (
                      <div className="user-avatar">Y</div>
                    )}
                    <div className="message-body">
                      <div className="message-byline">
                        <strong>{message.role === "assistant" ? "Atlas" : "You"}</strong>
                        {message.role === "assistant" && <span className="answer-label">AI ASSISTANT</span>}
                      </div>
                      {message.content ? (
                        <div className="markdown-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{message.content}</ReactMarkdown>
                        </div>
                      ) : streaming && message.role === "assistant" ? (
                        <div className="thinking"><span /><span /><span /><em>Thinking through your question</em></div>
                      ) : null}
                      {message.role === "assistant" && message.sources.length > 0 && (
                        <div className="source-list">
                          <div className="source-heading"><BookOpen size={13} /> SOURCES <span>{message.sources.length}</span></div>
                          {message.sources.map((source, index) => (
                            <details className="source-card" key={`${source.title}-${index}`}>
                              <summary>
                                <span className="source-file-icon"><FileText size={14} /></span>
                                <span className="source-title">{source.title}{source.page ? <small> · Page {source.page}</small> : null}</span>
                                <ChevronDown size={14} className="source-chevron" />
                              </summary>
                              <p>{source.excerpt || "This source is part of your indexed knowledge base."}</p>
                            </details>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                ))}
                {streaming && messages[messages.length - 1]?.content && (
                  <div className="streaming-indicator"><span /> Atlas is writing</div>
                )}
              </section>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}><X size={14} /></button>
            </div>
          )}
          <form className="composer" onSubmit={(event) => void sendMessage(event)}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question about your documents..."
              rows={1}
              aria-label="Message"
              disabled={streaming}
            />
            <div className="composer-bottom">
              <div className="composer-hint"><Sparkles size={13} /><span>Answers are grounded in your documents</span></div>
              <button
                type="submit"
                className={`send-button ${draft.trim() && !streaming ? "send-ready" : ""}`}
                disabled={!draft.trim() || streaming}
                aria-label="Send message"
              >
                {streaming ? <span className="send-spinner" /> : <ArrowUp size={17} />}
              </button>
            </div>
          </form>
          <div className="disclaimer">Atlas can make mistakes. Verify important information with the source documents.</div>
        </div>
      </main>

      {docsOpen && (
        <div className="drawer-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDocsOpen(false);
        }}>
          <aside className="documents-drawer">
            <div className="drawer-header">
              <div><div className="drawer-kicker">KNOWLEDGE BASE</div><h2>Your documents</h2></div>
              <button className="icon-button" aria-label="Close documents" onClick={() => setDocsOpen(false)}><X size={18} /></button>
            </div>
            <div className="index-summary">
              <span className="index-summary-icon"><BookOpen size={17} /></span>
              <div><strong>{indexedChunks.toLocaleString()} passages indexed</strong><span>Powered by your local FAISS index</span></div>
              <Check size={16} className="index-check" />
            </div>
            <button className="drawer-upload" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              <Upload size={16} /> {uploading ? "Processing documents..." : "Upload documents"}
            </button>
            <p className="upload-note">PDF, TXT, Markdown or CSV · Up to 15 MB each</p>
            <div className="drawer-section-title"><span>LIBRARY</span><span>{documents.length} FILES</span></div>
            <div className="document-list">
              {documents.length === 0 ? (
                <div className="document-empty">No documents yet. Upload a file to add it to your knowledge base.</div>
              ) : documents.map((document) => (
                <div className="document-row" key={document.path}>
                  <span className={`document-file-icon file-${document.extension}`}><FileText size={17} /></span>
                  <span className="document-meta"><strong title={document.name}>{document.name}</strong><span>{document.extension.toUpperCase()} · {formatBytes(document.size)}</span></span>
                  {document.uploaded && <span className="added-badge">ADDED</span>}
                </div>
              ))}
            </div>
            <div className="drawer-footer"><ShieldCheck size={15} /> Documents stay in your local project.</div>
          </aside>
        </div>
      )}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card"><Upload size={28} /><strong>Drop documents to add them</strong><span>PDF, TXT, Markdown or CSV</span></div>
        </div>
      )}
    </div>
  );
}

export default App;
