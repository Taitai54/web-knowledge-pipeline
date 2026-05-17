@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

echo Starting SearXNG + Crawl4AI for Web Knowledge Pipeline...
docker compose -f docker/docker-compose.yml up -d
if errorlevel 1 (
    echo.
    echo [ERROR] docker compose failed. Is Docker Desktop running?
    pause
    exit /b 1
)

echo.
echo Services:
echo   SearXNG   http://localhost:8888
echo   Crawl4AI  http://localhost:11235
echo.
echo Add to .env.local:
echo   SEARXNG_URL=http://localhost:8888
echo   CRAWL4AI_BASE_URL=http://localhost:11235
echo   SCRAPE_ENGINE=crawl4ai
echo.
pause
