import { NextResponse } from 'next/server';
import FirecrawlApp from '@mendable/firecrawl-js';
import fs from 'fs/promises';
import path from 'path';
import slugify from 'slugify';

const fcApp = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

export async function POST(request: Request) {
  try {
    const { url, category, title, returnContentOnly } = await request.json();

    if (!process.env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY.startsWith("fc-xxx")) {
      return NextResponse.json({ success: false, error: 'Firecrawl API key is missing or invalid' }, { status: 500 });
    }

    if (!url) {
      return NextResponse.json({ success: false, error: 'URL is required' }, { status: 400 });
    }

    const inputCategory = category || 'general';
    const isCustomPath = path.isAbsolute(inputCategory) || inputCategory.includes('/') || inputCategory.includes('\\') || inputCategory.startsWith('.');

    let saveDir: string;
    let frontmatterCategory: string;

    if (isCustomPath) {
      saveDir = path.isAbsolute(inputCategory) ? inputCategory : path.resolve(process.cwd(), inputCategory);
      frontmatterCategory = path.basename(saveDir) || 'general';
    } else {
      frontmatterCategory = slugify(inputCategory, { lower: true });
      saveDir = path.join(process.cwd(), 'content', 'knowledge-base', frontmatterCategory);
    }

    const safeTitle = slugify(title || 'untitled', { lower: true, strict: true });

    // Scrape URL
    const scrapeResponse = await fcApp.scrape(url, {
      formats: ['markdown'],
    });

    if (!scrapeResponse || !scrapeResponse.markdown) {
      throw new Error("Scraping failed or returned no markdown content");
    }

    const markdownContent = scrapeResponse.markdown || '';

    // Create frontmatter
    const frontmatter = `---
title: "${title.replace(/"/g, '\\"')}"
url: "${url}"
category: "${frontmatterCategory}"
date: "${new Date().toISOString()}"
---

`;

    const fullContent = frontmatter + markdownContent;

    if (returnContentOnly) {
      return NextResponse.json({ success: true, content: fullContent });
    }

    await fs.mkdir(saveDir, { recursive: true });

    const filePath = path.join(saveDir, `${safeTitle}.md`);
    await fs.writeFile(filePath, fullContent, 'utf-8');

    return NextResponse.json({ success: true, path: filePath });
  } catch (error) {
    console.error('Scrape API error:', error);
    const errMsg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: errMsg || 'Internal Server Error' }, { status: 500 });
  }
}
