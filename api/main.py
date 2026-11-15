import json
import logging
import os
import re
import threading
from pathlib import Path
from typing import Any
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from langchain_community.document_loaders import CSVLoader, PyPDFLoader, TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pydantic import BaseModel, Field

ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
FAISS_DIR = ROOT_DIR / "faiss_store"
load_dotenv(ROOT_DIR / ".env")

from api.database import ChatDatabase
from src.search import RAGSearch

logger = logging.getLogger(__name__)
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
ALLOWED_EXTENSIONS = {".pdf", ".txt", ".md", ".csv"}
database = ChatDatabase(DATA_DIR / "chat_history.sqlite3")
_rag: RAGSearch | None = None
_rag_initialization_lock = threading.Lock()
_vector_store_lock = threading.Lock()

app = FastAPI(title="LangChain RAG API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv(
        "FRONTEND_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateConversationRequest(BaseModel):
    title: str = Field(default="New chat", max_length=80)


class SendMessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)
    top_k: int = Field(default=5, ge=1, le=10)


def get_rag() -> RAGSearch:
    global _rag
    if _rag is None:
        with _rag_initialization_lock:
            if _rag is None:
                _rag = RAGSearch(
                    persist_dir=str(FAISS_DIR),
                    require_llm=False,
                )
    return _rag


def document_loader(file_path: Path):
    extension = file_path.suffix.lower()
    if extension == ".pdf":
        return PyPDFLoader(str(file_path)).load()
    if extension == ".csv":
        return CSVLoader(str(file_path), encoding="utf-8").load()
    return TextLoader(str(file_path), encoding="utf-8", autodetect_encoding=True).load()


def source_payload(result: dict[str, Any]) -> dict[str, Any]:
    metadata = result.get("metadata") or {}
    source_name = (
        metadata.get("source_file")
        or metadata.get("source")
        or metadata.get("file_name")
        or f"Indexed document {result.get('index', 0) + 1}"
    )
    page = metadata.get("page")
    try:
        page = int(page) + 1 if page is not None else None
    except (TypeError, ValueError):
        page = None
    return {
        "title": Path(str(source_name)).name,
        "page": page,
        "excerpt": str(metadata.get("text", ""))[:360],
        "distance": float(result["distance"]),
    }


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "llm_configured": bool(os.getenv("groq_api_key")),
        "faiss_available": (FAISS_DIR / "faiss.index").is_file()
        and (FAISS_DIR / "metadata.pkl").is_file(),
    }


@app.get("/api/conversations")
def list_conversations():
    return database.list_conversations()


@app.post("/api/conversations", status_code=201)
def create_conversation(request: CreateConversationRequest):
    return database.create_conversation(request.title.strip() or "New chat")


@app.get("/api/conversations/{conversation_id}/messages")
def get_messages(conversation_id: str):
    if not database.get_conversation(conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return database.list_messages(conversation_id)


@app.delete("/api/conversations/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str):
    if not database.delete_conversation(conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found")


@app.post("/api/conversations/{conversation_id}/messages")
def send_message(conversation_id: str, request: SendMessageRequest):
    conversation = database.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    rag = get_rag()
    if rag.llm is None:
        raise HTTPException(
            status_code=503,
            detail="AI chat is unavailable. Configure groq_api_key in the project .env file.",
        )

    prior_messages = database.list_messages(conversation_id)
    database.add_message(conversation_id, "user", request.content)
    history = [
        {"role": message["role"], "content": message["content"]}
        for message in prior_messages[-12:]
    ]

    def event_stream():
        answer_parts: list[str] = []
        try:
            with _vector_store_lock:
                results = rag.vectorstore.query(request.content, top_k=request.top_k)
            sources = [source_payload(result) for result in results if result.get("metadata")]
            yield f"event: sources\ndata: {json.dumps(sources)}\n\n"
            for token in rag.stream_answer(request.content, results, history):
                answer_parts.append(token)
                yield f"event: token\ndata: {json.dumps(token)}\n\n"
            answer = "".join(answer_parts)
            if answer:
                database.add_message(conversation_id, "assistant", answer, sources)
            yield "event: done\ndata: {}\n\n"
        except Exception:
            logger.exception("Failed while generating a RAG response")
            yield (
                "event: error\ndata: "
                + json.dumps({"detail": "The AI response could not be completed."})
                + "\n\n"
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/documents")
def list_documents():
    documents = []
    for path in DATA_DIR.rglob("*"):
        if (
            path.is_file()
            and path.suffix.lower() in ALLOWED_EXTENSIONS
            and "vector_store" not in path.relative_to(DATA_DIR).parts
        ):
            documents.append(
                {
                    "name": path.name,
                    "path": path.relative_to(ROOT_DIR).as_posix(),
                    "size": path.stat().st_size,
                    "extension": path.suffix.lower().lstrip("."),
                    "uploaded": UPLOAD_DIR in path.parents,
                }
            )
    documents.sort(key=lambda document: (not document["uploaded"], document["name"].lower()))
    return {
        "documents": documents,
        "indexed_chunks": get_rag().vectorstore.index.ntotal,
    }


@app.post("/api/documents/upload", status_code=201)
def upload_document(file: UploadFile = File(...)):
    original_name = Path(file.filename or "").name
    extension = Path(original_name).suffix.lower()
    if not original_name or extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Supported file types are PDF, TXT, Markdown, and CSV.",
        )

    content = file.file.read(MAX_UPLOAD_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Files must be 15 MB or smaller.")

    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(original_name).stem).strip(".-_")
    stored_name = f"{uuid4().hex[:8]}-{safe_stem or 'document'}{extension}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    destination = UPLOAD_DIR / stored_name
    destination.write_bytes(content)

    try:
        documents = document_loader(destination)
        for document in documents:
            document.metadata.update(
                {
                    "source_file": original_name,
                    "file_type": extension.lstrip("."),
                }
            )

        rag = get_rag()
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=rag.vectorstore.chunk_size,
            chunk_overlap=rag.vectorstore.chunk_overlap,
            separators=["\n\n", "\n", " ", ""],
        )
        chunks = splitter.split_documents(documents)
        if not chunks:
            raise ValueError("No readable text was found in the uploaded document.")

        embeddings = rag.vectorstore.model.encode(
            [chunk.page_content for chunk in chunks],
            show_progress_bar=False,
        ).astype("float32")
        metadatas = [
            {"text": chunk.page_content, **chunk.metadata}
            for chunk in chunks
        ]
        with _vector_store_lock:
            rag.vectorstore.add_embeddings(embeddings, metadatas)
            rag.vectorstore.save()
    except Exception as error:
        destination.unlink(missing_ok=True)
        if isinstance(error, (ValueError, UnicodeError)):
            raise HTTPException(status_code=422, detail=str(error)) from error
        logger.exception("Failed to process uploaded document %s", original_name)
        raise HTTPException(
            status_code=422,
            detail="The uploaded document could not be processed.",
        ) from error

    return {
        "name": original_name,
        "chunks_added": len(chunks),
        "indexed_chunks": rag.vectorstore.index.ntotal,
    }


WEB_DIST = ROOT_DIR / "web" / "dist"
if WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
