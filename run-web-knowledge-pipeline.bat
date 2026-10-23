@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title Web Knowledge Pipeline (azure-hawking)

set "PIPELINE_PORT=3010"

echo.
echo  Web Knowledge Pipeline
echo  ======================
echo  Repo: %CD%
echo  URL:  http://localhost:%PIPELINE_PORT%
echo.
echo  (Port %PIPELINE_PORT% avoids clashing with apps on 3000. Dev uses webpack,
echo   not Turbopack — more reliable on OneDrive-synced folders.)
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found. Install Node.js 18+ from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found. Reinstall Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist "package.json" (
    echo [ERROR] package.json not found. Run this bat from the azure-hawking folder.
    pause
    exit /b 1
)

if not exist "src\app\api\search\route.ts" (
    echo [ERROR] This does not look like the azure-hawking project folder.
    echo        Expected: src\app\api\search\route.ts
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo Installing dependencies ^(first run^)...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

call :LoadEnvFile "%~dp0global.env"
if defined GLOBAL_ENV_PATH call :LoadEnvFile "%GLOBAL_ENV_PATH%"
if exist "%USERPROFILE%\Global.env" call :LoadEnvFile "%USERPROFILE%\Global.env"
if exist "%USERPROFILE%\global.env" call :LoadEnvFile "%USERPROFILE%\global.env"

if not exist ".env.local" (
    echo [NOTE] Copy env.example to .env.local. For free local search/scrape:
    echo        Run scripts\start-docker-services.bat then set SEARXNG_URL and CRAWL4AI_BASE_URL.
    echo.
) else (
    if not defined SEARXNG_URL (
        echo [TIP] Local Docker: scripts\start-docker-services.bat ^(SearXNG + Crawl4AI^)
        echo.
    )
)

call :EnsureDocker
call :EnsureSearchServer
call :ResolveDevPort

if "%DEVPORT%"=="READY" (
    echo The app is already running at http://localhost:%PIPELINE_PORT%
    start "" http://localhost:%PIPELINE_PORT%/
    echo.
    pause
    exit /b 0
)

if "%DEVPORT%"=="STUCK" (
    echo Port %PIPELINE_PORT% is held by a Node process that is not responding.
    echo Stopping that process and starting fresh...
    echo.
    powershell -NoProfile -File "%~dp0scripts\dev-port.ps1" -StopStuck
)

echo Starting dev server... browser opens when ready.
echo Press Ctrl+C to stop the web app. The search server stays open in its own window.
echo.

start "" /MIN cmd /c "timeout /t 8 /nobreak >nul && start http://localhost:%PIPELINE_PORT%/"

REM Trust the Windows certificate store so antivirus HTTPS scanning does not break web fetches.
node --use-system-ca -e "" >nul 2>&1 && set "NODE_OPTIONS=--use-system-ca %NODE_OPTIONS%"

call npm run dev

if errorlevel 1 (
    echo.
    echo [ERROR] The dev server exited with an error.
    pause
    exit /b 1
)

endlocal
exit /b 0

:ResolveDevPort
set "DEVPORT=FREE"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -File "%~dp0scripts\dev-port.ps1" -Port %PIPELINE_PORT%`) do set "DEVPORT=%%A"
exit /b 0

:EnsureDocker
where docker >nul 2>&1
if errorlevel 1 (
    echo [NOTE] Docker was not found. Local SearXNG and Crawl4AI stay offline.
    echo.
    exit /b 0
)
docker info >nul 2>&1
if errorlevel 1 (
    echo [NOTE] Docker Desktop is not running. SearXNG and Crawl4AI stay offline.
    echo.
    exit /b 0
)
echo Starting SearXNG and Crawl4AI...
docker compose -f docker\docker-compose.yml up -d
if errorlevel 1 (
    echo [NOTE] Docker did not start. Open Docker Desktop, then run this script again.
    echo.
)
exit /b 0

:EnsureSearchServer
where python >nul 2>&1
if errorlevel 1 (
    echo [NOTE] Python was not found. RAG chat stays offline.
    echo.
    exit /b 0
)
if not defined PINECONE_API_KEY (
    echo [NOTE] PINECONE_API_KEY is not set. RAG chat stays offline.
    echo.
    exit /b 0
)
powershell -NoProfile -Command "exit ([int](-not [bool](Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)))"
if not errorlevel 1 (
    echo RAG search server is already listening on http://localhost:8765
    echo.
    exit /b 0
)
echo Starting RAG search server. Chat stays disabled until the model finishes loading.
start "WKP Search Server" /D "%~dp0." cmd /k "set PYTHONUNBUFFERED=1&& python pinecone-management\search_server.py"
echo.
exit /b 0

:LoadEnvFile
if not exist "%~1" exit /b 0
echo Loading environment from %~1
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~1") do (
    if not "%%A"=="" set "%%A=%%B"
)
exit /b 0
