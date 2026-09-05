#!/bin/bash
# Web Knowledge Pipeline — Mac launcher (mirrors run-web-knowledge-pipeline.bat)
# Usage: Double-click, or run from a terminal.
set -e
cd "$(dirname "$0")"

PIPELINE_PORT=3010

echo
echo "  Web Knowledge Pipeline"
echo "  ======================"
echo "  Repo: $(pwd)"
echo "  URL:  http://localhost:${PIPELINE_PORT}"
echo
echo "  (Port ${PIPELINE_PORT} avoids clashing with apps on 3000. Dev uses webpack,"
echo "   not Turbopack — more reliable on OneDrive-synced folders.)"
echo

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js was not found. Install it (e.g. 'brew install node') or from https://nodejs.org/"
    read -p "Press Enter to close..."
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "[ERROR] npm was not found. Reinstall Node.js."
    read -p "Press Enter to close..."
    exit 1
fi

if [ ! -f "package.json" ]; then
    echo "[ERROR] package.json not found. Run this from the web-knowledge-pipeline folder."
    read -p "Press Enter to close..."
    exit 1
fi

if [ ! -f "src/app/api/search/route.ts" ]; then
    echo "[ERROR] This does not look like the web-knowledge-pipeline project folder."
    echo "        Expected: src/app/api/search/route.ts"
    read -p "Press Enter to close..."
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies (first run)..."
    npm install
    echo
fi

# Mirrors the .bat's cascading env load: local global.env, $GLOBAL_ENV_PATH,
# then ~/Global.env / ~/global.env.
load_env_file() {
    local file="$1"
    [ -f "$file" ] || return 0
    echo "Loading environment from $file"
    set -a
    # shellcheck disable=SC1090
    source <(grep -v '^\s*#' "$file" | grep -v '^\s*$')
    set +a
}

load_env_file "$(pwd)/global.env"
[ -n "$GLOBAL_ENV_PATH" ] && load_env_file "$GLOBAL_ENV_PATH"
load_env_file "$HOME/Global.env"
load_env_file "$HOME/global.env"

if [ ! -f ".env.local" ]; then
    echo "[NOTE] Copy env.example to .env.local. For free local search/scrape:"
    echo "       Start SearXNG + Crawl4AI (docker compose -f docker/docker-compose.yml up -d)"
    echo "       then set SEARXNG_URL and CRAWL4AI_BASE_URL."
    echo
elif [ -z "$SEARXNG_URL" ]; then
    echo "[TIP] Local Docker: docker compose -f docker/docker-compose.yml up -d (SearXNG + Crawl4AI)"
    echo
fi

echo "Starting dev server... browser opens when ready."
echo "Press Ctrl+C to stop."
echo

( sleep 8 && open "http://localhost:${PIPELINE_PORT}/" ) &

npm run dev
