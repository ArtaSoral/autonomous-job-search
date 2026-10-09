import { NextRequest, NextResponse } from "next/server";
import { finishSignIn } from "@/lib/openai-auth";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  let status = "connected";
  try {
    await finishSignIn(
      request.nextUrl,
      request.cookies.get("chatgpt_signin")?.value || "",
    );
  } catch {
    status = "error";
  }
  const response = NextResponse.redirect(
    new URL(`/settings?connection=${status}`, "http://127.0.0.1:3000"),
    303,
  );
  response.cookies.set("chatgpt_signin", "", {
    path: "/auth/callback",
    maxAge: 0,
    httpOnly: true,
    sameSite: "lax",
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
