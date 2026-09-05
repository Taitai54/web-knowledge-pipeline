import { NextResponse } from "next/server";

export async function GET() {
  try {
    const res = await fetch("http://localhost:8765/namespaces", {
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { success: false, error: `Search server returned HTTP ${res.status}: ${text.slice(0, 200)}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json({ success: true, namespaces: data.namespaces || [] });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { success: false, error: `Search server is not running on port 8765: ${message}` },
      { status: 502 }
    );
  }
}
