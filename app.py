from src.data_loader import load_all_documents
from src.embedding import EmbeddingPipeline
from src.vectorstore import FaissVectorStore
from src.search import RAGSearch

#Example usage

if __name__ == "__main__":
    # docs=load_all_documents("data")  #Load all documents
    # chunks=EmbeddingPipeline().chunk_documents(docs)  #chunking
    # chunkvectors=EmbeddingPipeline().embed_chunks(chunks)  #embedding chunking 
    store=FaissVectorStore("faiss_store")
    store.load()
    # print(store.query("Give me the Job Description of Facto?",top_k=3))

    # store.build_from_documents(docs) # For one time only because it was for builing only
    # print(chunkvectors)
    # print(docs)

    rag_search=RAGSearch()
    query="Give me the Job Description of Facto?"
    summary=rag_search.search_and_summarize(query,top_k=3)
    print("Summary",summary)

