import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("../src/lib/openai-auth", () => ({
  beginSignIn: async () => "https://auth.openai.com/api/accounts/authorize?state=test",
  chooseModels: vi.fn(), refreshModels: vi.fn(), signOut: async () => true, switchAccount: vi.fn(),
}));
import { POST } from "../src/app/auth/start/route";
describe("Local ChatGPT sign-in route", () => {
  it("uses the actual Host header even when Next normalizes the request URL", async () => {
    const request = new NextRequest("http://localhost:3000/auth/start", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/x-www-form-urlencoded" }, body: "action=signin" });
    const response = await POST(request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("https://auth.openai.com/");
    expect(response.cookies.get("chatgpt_signin")?.value).toBeTruthy();
  });
  it("rejects cross-origin writes", async () => {
    const request = new NextRequest("http://localhost:3000/auth/start", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "https://example.com" } });
    expect((await POST(request)).status).toBe(403);
  });
});
