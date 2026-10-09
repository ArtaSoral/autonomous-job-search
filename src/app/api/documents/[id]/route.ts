import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { resolve, basename, sep } from "node:path";
import { getDocument } from "@/lib/documents";
import { artifactDirectory } from "@/lib/storage";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!["localhost", "127.0.0.1"].includes(new URL(request.url).hostname))
    return new NextResponse("Local access only", { status: 403 });
  try {
    const d = getDocument((await params).id);
    if (!d.approved_by_user || !d.file_path)
      return new NextResponse(
        "Approve the verified document before downloading",
        { status: 403 },
      );
    const path = resolve(d.file_path);
    if (!path.startsWith(resolve(artifactDirectory("documents")) + sep))
      throw Error("Invalid document path");
    return new NextResponse(readFileSync(path), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${basename(path)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new NextResponse("Document unavailable", { status: 404 });
  }
}
