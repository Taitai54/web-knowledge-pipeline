import { NextResponse } from "next/server";
import { excludeSource, listSources, scanSavedPages, setSourceIncluded } from "@/lib/discover/sources";

export async function GET() {
  return NextResponse.json({ success: true, ...(await listSources()) });
}

export async function POST(request: Request) {
  try {
    const { action, origin, included } = await request.json();
    if (action === "scan") {
      return NextResponse.json({ success: true, ...(await scanSavedPages()) });
    }
    if (action === "remove" && typeof origin === "string") {
      return NextResponse.json({ success: await excludeSource(origin) });
    }
    if (action === "include" && typeof origin === "string" && typeof included === "boolean") {
      return NextResponse.json({ success: await setSourceIncluded(origin, included) });
    }
    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
