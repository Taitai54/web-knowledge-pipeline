import { NextResponse } from 'next/server';
import path from 'path';
import slugify from 'slugify';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const inputCategory = searchParams.get('path') || 'general';
  
  const isCustomPath = path.isAbsolute(inputCategory) || inputCategory.includes('/') || inputCategory.includes('\\') || inputCategory.startsWith('.');

  let saveDir: string;

  if (isCustomPath) {
    saveDir = path.resolve(process.cwd(), inputCategory);
  } else {
    // We only use the slug if it's not a custom path
    const frontmatterCategory = slugify(inputCategory, { lower: true });
    saveDir = path.join(process.cwd(), 'content', 'knowledge-base', frontmatterCategory);
  }

  return NextResponse.json({ saveDir });
}
