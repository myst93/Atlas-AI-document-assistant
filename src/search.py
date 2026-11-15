
import os
from dotenv import load_dotenv
from src.vectorstore import FaissVectorStore
from langchain_groq import ChatGroq
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

load_dotenv()

class RAGSearch:
    def __init__(
        self,
        persist_dir: str = "faiss_store",
        embedding_model: str = "all-MiniLM-L6-v2",
        llm_model: str = "openai/gpt-oss-120b",
        require_llm: bool = True,
    ):
        self.vectorstore = FaissVectorStore(persist_dir, embedding_model)

        # Load or build vectorstore
        faiss_path = os.path.join(persist_dir, "faiss.index")
        meta_path = os.path.join(persist_dir, "metadata.pkl")

        if not (os.path.exists(faiss_path) and os.path.exists(meta_path)):
            from src.data_loader import load_all_documents

            data_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
            docs = load_all_documents(data_dir)
            self.vectorstore.build_from_documents(docs)
        else:
            self.vectorstore.load()

        groq_api_key = os.getenv("groq_api_key")

        if not groq_api_key and require_llm:
            raise ValueError("Groq API key not found in .env file")

        self.llm = (
            ChatGroq(groq_api_key=groq_api_key, model_name=llm_model)
            if groq_api_key
            else None
        )

        if self.llm:
            print(f"[INFO] Groq LLM initialized: {llm_model}")

    def search_and_summarize(self, query: str, top_k: int = 5) -> str:
        results = self.vectorstore.query(query, top_k)
        texts = [
            r["metadata"].get("text", "")
            for r in results
            if r["metadata"]
        ]
        context = "\n\n".join(texts)
        if not context:
            return "No relevant documents found."
        if self.llm is None:
            raise ValueError("Groq API key not found in .env file")
        prompt = f"""Summarize the following context for the query: '{query}'
        Context:
        {context}
        """
        response = self.llm.invoke(prompt)
        return response.content

    def stream_answer(self, query: str, results: list[dict], history: list[dict] | None = None):
        if self.llm is None:
            raise ValueError("Groq API key not found in .env file")

        context = "\n\n".join(
            result["metadata"].get("text", "")
            for result in results
            if result.get("metadata") and result["metadata"].get("text")
        )
        if not context:
            context = "No matching document excerpts were found."

        messages = [
            SystemMessage(
                content=(
                    "You are a helpful assistant that answers using the supplied "
                    "document context. Be accurate, clearly say when the context "
                    "does not contain an answer, and do not invent citations.\n\n"
                    f"Document context:\n{context}"
                )
            )
        ]
        for item in (history or [])[-12:]:
            content = item.get("content", "")
            if not content:
                continue
            if item.get("role") == "assistant":
                messages.append(AIMessage(content=content))
            elif item.get("role") == "user":
                messages.append(HumanMessage(content=content))
        messages.append(HumanMessage(content=query))

        for chunk in self.llm.stream(messages):
            content = chunk.content
            if isinstance(content, str) and content:
                yield content
