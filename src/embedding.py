from typing import List,Any
from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer
import numpy as np
from src.data_loader import load_all_documents

class EmbeddingPipeline:
    def __init__(self,model_name:str="all-MiniLM-L6-v2",chunk_size:int=1000,chunk_overlap=200):
        self.chunk_size=chunk_size
        self.chunk_overlap=chunk_overlap
        self.model=SentenceTransformer(model_name)
        print(f"[INFO] Loaded embedding model:{model_name}")

    def chunk_documents(self,documents:List[Any])->List[Any]:
        """ Split documents into chunks using RecursiveCharacterTextSplitter"""
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
            length_function=len,
            separators=["\n\n", "\n"," ",""]
        )
        chunks =text_splitter.split_documents(documents)  ## It takes the original list of documents and returns a new list conatining smaller Document chunks
        print(f"[INFO] Split {len(documents)} documents into {len(chunks)} chunks")
        return chunks

    def embed_chunks(self,chunks:List[Any]) -> np.ndarray:
        texts=[chunk.page_content for chunk in chunks]
        print(f"Generating embeddings for {len(texts)} chunks...")
        embeddings = self.model.encode(texts, show_progress_bar=True)
        print(f"Generated embeddings with shape: {embeddings.shape}")
        return embeddings
        