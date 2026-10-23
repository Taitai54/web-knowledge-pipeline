import path from "path";
import slugify from "slugify";

export interface ResolveSavePathResult {
  saveDir: string;
  frontmatterCategory: string;
  safeTitle: string;
}

export function resolveSavePath(
  category: string | undefined,
  title: string,
): ResolveSavePathResult {
  const inputCategory = (category || "general").trim();
  if (inputCategory.includes("\0")) {
    throw new Error("Invalid category: contains a null byte");
  }
  const isCustomPath =
    path.isAbsolute(inputCategory) ||
    inputCategory.includes("/") ||
    inputCategory.includes("\\") ||
    inputCategory.startsWith(".");

  let saveDir: string;
  let frontmatterCategory: string;

  if (isCustomPath) {
    saveDir = path.isAbsolute(inputCategory)
      ? inputCategory
      : path.resolve(process.cwd(), inputCategory);
    frontmatterCategory = path.basename(saveDir) || "general";
  } else {
    frontmatterCategory = slugify(inputCategory, { lower: true });
    saveDir = path.join(process.cwd(), "content", "knowledge-base", frontmatterCategory);
  }

  const safeTitle = slugify(title || "untitled", { lower: true, strict: true });

  return { saveDir, frontmatterCategory, safeTitle };
}
