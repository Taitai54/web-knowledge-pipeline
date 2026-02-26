# Web-to-Markdown RAG Knowledge Ingestion Pipeline

This project is a modern "Web-to-LLM" pipeline tool. It allows you to search the live web, select high-quality results, scrape them into clean Markdown using Firecrawl, and organize them for a RAG knowledge base.

## Features

- **Search**: Interactive search UI powered by Tavily API.
- **Selection**: Review and select multiple URLs to scrape.
- **Extraction**: Automatic conversion of web pages to clean Markdown via Firecrawl.
- **Organization**: Save scrapes into categorized folders with YAML frontmatter.
- **RAG Ingestion**: A script to simulate the ingestion and chunking process for Vector DBs.

## Prerequisites

- Node.js 18+
- API Keys for:
  - [Tavily AI](https://tavily.com/) (for search)
  - [Firecrawl](https://firecrawl.dev/) (for scraping)

## Setup

1. **Clone the repository** (if not already local).
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Configure Environment Variables**:
   Create a `.env.local` file in the root directory:

   ```env
   # API Keys
   TAVILY_API_KEY=tvly-xxxxxxxxxxxx
   FIRECRAWL_API_KEY=fc-xxxxxxxxxxxx

   # Firebase (Optional, for history/auth)
   NEXT_PUBLIC_FIREBASE_API_KEY=...
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
   ```

## Usage

### 1. Run the Web Interface

Start the Next.js development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to search and scrape.

### 2. View Scraped Content

Scraped Markdown files are saved in:
`root/content/knowledge-base/{category}/{title}.md`

### 3. Run RAG Ingestion Pipeline

To process the knowledge base for RAG (simulated):

```bash
node scripts/ingest.mjs
```

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Styling**: Vanilla CSS Modules (Premium Dark Mode)
- **Search**: Tavily API
- **Scraper**: Firecrawl SDK
- **Database**: Firebase (Configured but optional for MVP)

## License

MIT
