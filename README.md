# Atlas — AI document assistant

Atlas is a local-first, full-stack Retrieval-Augmented Generation (RAG)
application. Ask questions in a conversational web interface and receive
streamed answers grounded in your documents, with source excerpts alongside
the response.

The application wraps the project's existing LangChain, Sentence Transformers,
FAISS, and Groq implementation. It loads the existing `faiss_store` index and
metadata rather than rebuilding them. When you upload a supported document,
Atlas chunks and embeds its contents, then appends the new vectors and source
metadata to that same index.

## What it does

- **Ask questions about your documents.** Relevant passages are retrieved from
  the local FAISS index and supplied to the Groq chat model as context.
- **Stream answers as they are generated.** The chat API sends server-sent
  events, and the web interface renders the response as it arrives.
- **See where answers came from.** Responses include retrieved source names,
  page numbers when available, and expandable text excerpts.
- **Keep conversation history.** Conversations and messages are stored in a
  local SQLite database and can be reopened from the sidebar.
- **Add to your knowledge base.** Upload PDF, TXT, Markdown, or CSV files
  through the interface or by dropping them onto the page. Uploaded files are
  limited to 15 MB each.
- **Read rich answers.** The interface renders Markdown, tables, and
  syntax-highlighted code in a responsive React application.

## Technology

| Layer | Technologies |
| --- | --- |
| Frontend | React, TypeScript, Vite, Tailwind CSS, React Markdown, Highlight.js |
| API | FastAPI, Pydantic, Uvicorn, server-sent events |
| RAG | LangChain, `all-MiniLM-L6-v2` embeddings, FAISS, Groq `openai/gpt-oss-120b` |
| Persistence | Existing FAISS files and a local SQLite conversation database |

## Requirements

- Python 3.14 or newer (the project currently selects Python 3.14 in
  `.python-version`)
- Node.js 20 or newer and npm
- [uv](https://docs.astral.sh/uv/) for Python dependency management
- A Groq API key to generate chat responses

The embedding model is loaded from Sentence Transformers. On first startup, the
model may need to be downloaded and cached, so allow network access to the
Hugging Face Hub.

## Setup

### 1. Configure the Groq API key

Create a `.env` file in the project root:

```dotenv
groq_api_key=your_groq_api_key
```

Keep this key private. `.env` is ignored by Git. The API, document list, and
conversation endpoints can start without a key, but asking Atlas to generate an
answer requires it. Without a key, the chat endpoint returns HTTP 503.

### 2. Install backend dependencies

From the project root:

```bash
uv sync
```

### 3. Install frontend dependencies

```bash
cd web
npm ci
```

`npm ci` installs the exact versions recorded in `web/package-lock.json`.

## Run in development

Start the backend from the project root:

```bash
uv run uvicorn api.main:app --reload
```

In another terminal, start the Vite development server:

```bash
cd web
npm run dev
```

Open the URL printed by Vite (by default
<http://localhost:5173>). The Vite development server proxies `/api` requests
to the backend at <http://127.0.0.1:8000>.

- **Application:** <http://localhost:5173>
- **API health:** <http://localhost:8000/api/health>
- **Interactive API documentation:** <http://localhost:8000/docs>
- **Alternative API documentation:** <http://localhost:8000/redoc>

The health endpoint reports whether the FAISS files are available and whether
the Groq key is configured.

## Production build

Build the frontend:

```bash
cd web
npm ci
npm run build
```

Then, from the project root, run the API:

```bash
uv run uvicorn api.main:app --host 0.0.0.0 --port 8000
```

If `web/dist` exists, FastAPI serves the built frontend and the API from the
same origin. For local use, the API can instead be started without a frontend
build while the Vite development server is running.

To point the frontend at a separately hosted API, set `VITE_API_URL` in the
frontend build environment to the API's base URL (for example,
`https://api.example.com`). Configure the backend's `FRONTEND_ORIGINS`
environment variable with the allowed frontend origin or comma-separated
origins. The default CORS origins are `http://localhost:5173` and
`http://127.0.0.1:5173`.

## How the RAG pipeline works

1. The frontend submits a question to the conversation messages endpoint.
2. The backend embeds the question using the same Sentence Transformers model
   used by the existing vector store.
3. FAISS returns the nearest passages (five by default).
4. The backend sends the retrieved context, recent conversation history, and
   question to the configured Groq model.
5. The response is streamed to the browser as text events. Retrieved sources
   are sent separately and displayed with the answer.

The existing vector store is expected at:

```text
faiss_store/
├── faiss.index
└── metadata.pkl
```

Keep these files together and back them up before making manual changes. If
both files exist, the application loads them. If either is missing, the current
RAG initialization path builds a new store from PDF files under `data/`; that
can take time and will write a new index. The current embedding model is
`all-MiniLM-L6-v2`, and the default chunking configuration is 1,000 characters
with 200 characters of overlap. Use the same embedding model when extending an
existing index.

## Uploads and local data

- Uploaded documents are stored under `data/uploads/` using generated file
  names to avoid collisions. Their original names are retained as source
  metadata.
- Uploads are split into chunks and appended to `faiss_store/faiss.index` and
  `faiss_store/metadata.pkl`. The API does not rebuild the existing index for
  each upload.
- Chat history is stored in `data/chat_history.sqlite3`.
- The existing files under `data/` remain the project's document corpus.

The upload API accepts `.pdf`, `.txt`, `.md`, and `.csv` files, up to 15 MB
each. These local data files, the SQLite database, and uploads are not
automatically included in backups; back up anything you need to preserve.

## API reference

All routes are prefixed with `/api`.

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/health` | API status, Groq configuration, and FAISS availability |
| `GET` | `/conversations` | List conversations, newest activity first |
| `POST` | `/conversations` | Create a conversation |
| `GET` | `/conversations/{id}/messages` | Read a conversation's messages and sources |
| `DELETE` | `/conversations/{id}` | Delete a conversation and its messages |
| `POST` | `/conversations/{id}/messages` | Save a question and stream an AI answer |
| `GET` | `/documents` | List supported files under `data/` and report indexed chunk count |
| `POST` | `/documents/upload` | Upload, chunk, embed, and append a document |

### Create a conversation

`POST /api/conversations` accepts an optional title:

```json
{ "title": "Project research" }
```

An empty JSON object creates a conversation titled `New chat`.

### Send a question

`POST /api/conversations/{id}/messages` accepts:

```json
{
  "content": "What are the main findings?",
  "top_k": 5
}
```

`content` is required and limited to 20,000 characters. `top_k` is between 1
and 10, and defaults to 5. The response uses `text/event-stream` and emits:

- `sources` — JSON array of source title, page (if available), excerpt, and
  FAISS distance
- `token` — a JSON-encoded text fragment from the model
- `done` — indicates the answer finished and was saved
- `error` — indicates an error occurred while streaming

The question is saved before generation starts. A completed assistant response
and its sources are saved to the same conversation.

### Upload a document

`POST /api/documents/upload` accepts a `multipart/form-data` file field named
`file`. The response includes the original file name, number of chunks added,
and total indexed chunk count.

FastAPI's interactive endpoint descriptions and request schemas are available
at <http://localhost:8000/docs> when the backend is running.

## Project layout

```text
.
├── api/
│   ├── database.py       # SQLite conversation and message storage
│   └── main.py           # FastAPI routes, streaming, and document uploads
├── data/                 # Existing documents and local application data
├── faiss_store/          # Existing FAISS index and metadata
├── notebook/             # Reference notebooks for the original pipeline
├── src/
│   ├── data_loader.py    # Existing document loading code
│   ├── embedding.py      # Existing chunking and embedding pipeline
│   ├── search.py         # RAG retrieval and Groq answer generation
│   └── vectorstore.py    # Existing FAISS operations
├── web/
│   ├── src/              # React + TypeScript application and styles
│   ├── package.json      # Frontend dependencies and scripts
│   └── vite.config.ts    # Vite configuration and API proxy
├── .env                  # Local Groq key; create this file yourself
├── pyproject.toml        # Python project and dependencies
└── requirements.txt      # Python requirements alternative
```

## Troubleshooting

- **Chat returns “Configure groq_api_key”:** Check that the project-root
  `.env` contains `groq_api_key=...`, then restart the API process.
- **The API cannot find the FAISS store:** Check that both `faiss.index` and
  `metadata.pkl` exist in `faiss_store/`. The fallback build reads PDFs from
  `data/`, and rebuilding replaces the index files.
- **The first start is slow or cannot load embeddings:** Sentence Transformers
  may be downloading `all-MiniLM-L6-v2`; check network access and try again.
- **The frontend cannot reach the API:** In development, keep Uvicorn on
  `127.0.0.1:8000`. For a separate frontend/API deployment, set `VITE_API_URL`
  and allow the frontend origin in `FRONTEND_ORIGINS`.
- **An upload is rejected:** Check that the file is a non-empty PDF, TXT,
  Markdown, or CSV and is no larger than 15 MB.

## Security and deployment note

This project is intended as a local or trusted-network application. The API
does not implement user authentication or authorization, and uploaded files and
chat history are stored locally. Do not expose it directly to the public
internet without adding appropriate authentication, access controls, and
deployment-specific safeguards. Keep `.env` private and do not commit API keys.
