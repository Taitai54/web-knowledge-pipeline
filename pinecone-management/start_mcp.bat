@echo off
:: Pinecone MCP Server — manual launcher for testing outside Claude Code
:: Usage: Double-click or run from terminal to start the MCP server on stdio

if "%PINECONE_API_KEY%"=="" (
    echo WARNING: PINECONE_API_KEY not set in environment.
    echo The server will start but tool calls will fail.
    echo.
    echo Set it with:
    echo   setx PINECONE_API_KEY "your-key-here"
    echo Then restart this terminal.
    echo.
)

echo Starting Pinecone MCP server (stdio transport)...
echo Press Ctrl+C to stop.
echo.

python "%~dp0pinecone_mcp.py"
