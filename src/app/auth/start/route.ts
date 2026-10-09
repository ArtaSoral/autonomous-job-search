import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import {
  beginSignIn,
  chooseModels,
  refreshModels,
  signOut,
  switchAccount,
} from "@/lib/openai-auth";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (
    origin !== "http://127.0.0.1:3000" ||
    request.headers.get("host") !== "127.0.0.1:3000"
  )
    return new NextResponse(
      "Open Settings at http://127.0.0.1:3000 to connect ChatGPT.",
      { status: 403 },
    );
  const form = await request.formData();
  const action = form.get("action");
  try {
    if (action === "signin") {
      const browser = randomBytes(32).toString("base64url");
      const clientId = form.get("clientId");
      const url = await beginSignIn(
        browser,
        typeof clientId === "string" && clientId ? clientId : undefined,
      );
      const response = NextResponse.redirect(url, 303);
      response.cookies.set("chatgpt_signin", browser, {
        httpOnly: true,
        sameSite: "lax",
        path: "/auth/callback",
        maxAge: 600,
      });
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
    let status = "saved";
    if (action === "models")
      chooseModels(String(form.get("fast")), String(form.get("strong")));
    else if (action === "refresh") await refreshModels();
    else if (action === "switch") switchAccount(String(form.get("clientId")));
    else if (action === "signout")
      status = (await signOut()) ? "signedout" : "revocation";
    else return new NextResponse("Unknown action", { status: 400 });
    return NextResponse.redirect(
      new URL(`/settings?connection=${status}`, "http://127.0.0.1:3000"),
      303,
    );
  } catch {
    return NextResponse.redirect(
      new URL("/settings?connection=error", "http://127.0.0.1:3000"),
      303,
    );
  }
}
