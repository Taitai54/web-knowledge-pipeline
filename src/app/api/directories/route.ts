import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const reqPath = searchParams.get('path');
    if (reqPath && reqPath.includes('\0')) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }
    const currentPath = reqPath || os.homedir();

    const isWindows = os.platform() === 'win32';

    if (isWindows && currentPath === 'root') {
      // Return common Windows drives
      return NextResponse.json({ 
        currentPath: 'root', 
        parentPath: null,
        folders: ['C:\\', 'D:\\', 'E:\\', 'F:\\'] 
      });
    }

    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      const folders = entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b));

      let parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        if (isWindows) {
          parentPath = 'root';
        } else {
          parentPath = null as unknown as string;
        }
      }

      return NextResponse.json({ currentPath, parentPath, folders });
    } catch (e) {
      if (currentPath !== os.homedir()) {
        // Fallback to homedir if requested path fails
        const home = os.homedir();
        const entries = await fs.readdir(home, { withFileTypes: true });
        return NextResponse.json({
           currentPath: home,
           parentPath: path.dirname(home),
           folders: entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name),
           error: `Could not access ${currentPath}. Showing Home directory instead.`
        });
      }
      throw e;
    }
  } catch (error) {
    console.error('Directory API Error:', error);
    return NextResponse.json({ error: 'Failed to read directory' }, { status: 500 });
  }
}
