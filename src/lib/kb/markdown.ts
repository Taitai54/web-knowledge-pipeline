import fs from "fs/promises";
import path from "path";

const DROP_LINE = [
  /^\s*\[skip to (main )?content\]\([^)]*\)\s*$/i,
  /^\s*skip to (main )?content\s*$/i,
  /^\s*email:\s*$/i,
  /^\s*leave this field blank\s*$/i,
  /^\s*yes, i['’]d also like to subscribe\b.*$/i,
  /^\s*work smart with our .+newsletter.*$/i,
];

export function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    const drop = [...url.searchParams.keys()].filter((key) => {
      const lower = key.toLowerCase();
      return lower.startsWith("utm_") || lower === "fbclid" || lower === "gclid";
    });
    for (const key of drop) url.searchParams.delete(key);
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function cleanScrapedMarkdown(markdown: string): string {
  const kept = markdown
    .split(/\r?\n/)
    .filter((line) => !DROP_LINE.some((pattern) => pattern.test(line)));
  const collapsed = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return collapsed ? `${collapsed}\n` : "";
}

function frontmatterField(head: string, key: string): string | null {
  const match = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const line = match[1].split(/\r?\n/).find((entry) => entry.startsWith(`${key}:`));
  if (!line) return null;
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, "");
}

async function readHead(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function walkMarkdown(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) files.push(...(await walkMarkdown(full)));
    else if (dirent.isFile() && dirent.name.endsWith(".md")) files.push(full);
  }
  return files;
}

export async function findExistingSource(
  roots: string[],
  url: string,
  exceptPath?: string,
): Promise<string | null> {
  const wanted = canonicalUrl(url);
  if (!wanted) return null;
  const except = exceptPath ? path.resolve(exceptPath) : "";
  const seen = new Set<string>();

  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (seen.has(resolvedRoot)) continue;
    seen.add(resolvedRoot);
    for (const filePath of await walkMarkdown(resolvedRoot)) {
      if (except && path.resolve(filePath) === except) continue;
      const head = await readHead(filePath);
      const saved = frontmatterField(head, "url");
      if (saved && canonicalUrl(saved) === wanted) return filePath;
    }
  }
  return null;
}

export async function listSavedPages(root: string): Promise<{ url: string; category: string }[]> {
  const pages: { url: string; category: string }[] = [];
  for (const filePath of await walkMarkdown(path.resolve(root))) {
    const head = await readHead(filePath);
    const url = frontmatterField(head, "url");
    if (!url) continue;
    const category = frontmatterField(head, "category") || path.basename(path.dirname(filePath));
    pages.push({ url, category });
  }
  return pages;
}
