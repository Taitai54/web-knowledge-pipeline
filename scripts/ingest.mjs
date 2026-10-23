// Local chunk preview only. This script does not embed or upload.
// Sync a folder from the app, or run pinecone-management/pinecone_bulk.py.

import fs from 'fs/promises';
import path from 'path';

const KNOWLEDGE_BASE_DIR = path.join(process.cwd(), 'content', 'knowledge-base');

async function getFiles(dir) {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(dirents.map((dirent) => {
    const res = path.resolve(dir, dirent.name);
    return dirent.isDirectory() ? getFiles(res) : res;
  }));
  return Array.prototype.concat(...files);
}

// Simple chunking function (mocking RecursiveCharacterTextSplitter)
function chunkText(text, chunkSize = 1000) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
}

async function runIngestion() {
    console.log("🚀 Starting RAG Ingestion Pipeline...");
    
    try {
        const files = await getFiles(KNOWLEDGE_BASE_DIR);
        const markdownFiles = files.filter(f => f.endsWith('.md'));

        console.log(`Found ${markdownFiles.length} markdown files in knowledge base.`);

        for (const file of markdownFiles) {
            console.log(`\n📄 Processing: ${path.basename(file)}`);
            
            const content = await fs.readFile(file, 'utf-8');
            
            // basic frontmatter parsing (splitting by ---)
            const parts = content.split('---');
            const frontmatter = parts[1];
            const body = parts.slice(2).join('---');

            if (!body) {
                console.warn(`Skipping ${path.basename(file)} (no content)`);
                continue;
            }

            const chunks = chunkText(body);
            
            console.log(`   > Extracted metadata...`);
            console.log(`   > Split into ${chunks.length} chunks.`);
            console.log(`   > Preview only. Nothing is embedded or uploaded.`);
            
            // Simulating latency
            await new Promise(r => setTimeout(r, 100)); 
            
            console.log(`   ✅ Done.`);
        }

        console.log("\nPreview complete. Upload with Sync to Pinecone in the app, or pinecone_bulk.py.");

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log("No knowledge-base directory found. Scrape some content first!");
        } else {
            console.error("Ingestion failed:", error);
        }
    }
}

runIngestion();
