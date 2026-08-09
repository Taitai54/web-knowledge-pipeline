@echo off
if not defined PINECONE_API_KEY (
    echo PINECONE_API_KEY is not set.
    echo Copy start-search-server.local.bat.example to start-search-server.local.bat,
    echo fill in your key, and run that instead.
    pause
    exit /b 1
)
if not defined PINECONE_INDEX set PINECONE_INDEX=peace
echo Starting local search server on http://localhost:8765
echo First search will take 1-2 minutes to load the embedding model.
echo Keep this window open while using the app.
echo.
python search_server.py
pause
