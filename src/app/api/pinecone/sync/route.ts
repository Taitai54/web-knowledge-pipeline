import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { resolveSavePath } from "@/lib/kb/paths";
import path from "path";

export async function POST(request: Request) {
  try {
    const { category, indexName = "peace", namespace } = await request.json();

    if (!category) {
      return NextResponse.json({ success: false, error: "Category is required" }, { status: 400 });
    }

    const { saveDir, frontmatterCategory } = resolveSavePath(category, "dummy");
    const targetNamespace = namespace || frontmatterCategory;

    const encoder = new TextEncoder();
    const customStream = new ReadableStream({
      start(controller) {
        const pythonPath = "python";
        const scriptPath = path.resolve(process.cwd(), "pinecone-management", "pinecone_bulk.py");

        const args = [
          scriptPath,
          saveDir,
          "--index-name",
          indexName,
          "--namespace",
          targetNamespace,
          "--prune-by-source"
        ];

        controller.enqueue(encoder.encode(JSON.stringify({ type: "status", message: `Starting sync on folder: ${saveDir} for namespace: ${targetNamespace}...` }) + "\n"));

        const child = spawn(pythonPath, args, {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1"
          }
        });

        child.stdout.on("data", (data) => {
          const chunk = data.toString();
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.trim()) {
              controller.enqueue(encoder.encode(JSON.stringify({ type: "stdout", message: line }) + "\n"));
            }
          }
        });

        child.stderr.on("data", (data) => {
          const chunk = data.toString();
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.trim()) {
              controller.enqueue(encoder.encode(JSON.stringify({ type: "stderr", message: line }) + "\n"));
            }
          }
        });

        child.on("close", (code) => {
          controller.enqueue(encoder.encode(JSON.stringify({ type: "close", code }) + "\n"));
          controller.close();
        });

        child.on("error", (err) => {
          controller.enqueue(encoder.encode(JSON.stringify({ type: "error", message: err.message }) + "\n"));
          controller.close();
        });
      }
    });

    return new Response(customStream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });

  } catch (error: any) {
    console.error("Sync API error:", error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
