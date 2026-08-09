@echo off
setlocal

cd /d "%~dp0"

:: Ensure required deps are present before launching the GUI.
python -c "import customtkinter, requests" 1>nul 2>nul
if errorlevel 1 (
    echo Installing missing GUI dependencies...
    python -m pip install -r requirements.txt -r requirements-gui.txt
    if errorlevel 1 (
        echo.
        echo [error] pip install failed. See output above.
        pause
        exit /b 1
    )
)

python pinecone_gui.py
if errorlevel 1 (
    echo.
    echo [error] pinecone_gui.py exited with code %errorlevel%.
    echo Window will stay open so you can read the error above.
    pause
)
