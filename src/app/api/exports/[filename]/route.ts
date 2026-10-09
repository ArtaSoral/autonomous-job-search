import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { artifactDirectory } from "@/lib/storage";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  if (!["localhost", "127.0.0.1"].includes(new URL(request.url).hostname))
    return new NextResponse("Local access only", { status: 403 });
  const { filename } = await params;
  if (
    !/^(spec-proposal-[a-f0-9-]+\.md|resume_bank_v\d+\.\d+_[a-f0-9-]+\.json)$/.test(
      filename,
    )
  )
    return new NextResponse("Invalid export", { status: 400 });
  try {
    return new NextResponse(
      readFileSync(join(artifactDirectory("exports"), filename)),
      {
        headers: {
          "Content-Type": filename.endsWith(".json")
            ? "application/json"
            : "text/markdown",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    return new NextResponse("Export not found", { status: 404 });
  }
}
