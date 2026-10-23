import { NextResponse } from "next/server";
import { getLlmStatus, saveLlmSettings, type LlmSaveInput } from "@/lib/rag/llm";

export async function GET() {
  const status = await getLlmStatus();
  return NextResponse.json({ success: true, ...status });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as LlmSaveInput;
    const status = await saveLlmSettings(body);
    return NextResponse.json({ success: true, ...status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save model settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
