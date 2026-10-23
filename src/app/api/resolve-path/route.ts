import { NextResponse } from 'next/server';
import { resolveSavePath } from '@/lib/kb/paths';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const inputCategory = searchParams.get('path') || 'general';

  try {
    const { saveDir, frontmatterCategory } = resolveSavePath(inputCategory, 'dummy');
    return NextResponse.json({ saveDir, frontmatterCategory });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid path';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
