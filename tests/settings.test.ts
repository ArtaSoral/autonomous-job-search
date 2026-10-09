import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../src/lib/bank", () => ({
  loadInputs: () => ({
    bankVersion: "3.3",
    specVersion: "2.2",
    bankHash: "bank",
    specHash: "spec",
  }),
}));
const account = vi.hoisted(() => ({
  client_id: "test-client",
  email: "test@example.invalid",
  secrets: "encrypted-secret-sentinel",
  fast_model: "fast",
  strong_model: "strong",
  models: JSON.stringify([
    { slug: "fast", display_name: "Fast model" },
    { slug: "strong", display_name: "Strong model" },
  ]),
}));
vi.mock("../src/lib/openai-auth", () => ({
  accounts: () => [account],
  activeAccount: () => account,
}));
import Settings from "../src/app/settings/page";
afterEach(() => vi.unstubAllEnvs());
describe("OpenAI connection mode presentation", () => {
  it("shows the active ChatGPT account and its model choices", async () => {
    vi.stubEnv("OPENAI_AUTH_MODE", "chatgpt");
    const html = renderToStaticMarkup(
      await Settings({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain("Using ChatGPT plan");
    expect(html).toContain('id="fast-model"');
    expect(html).not.toContain("OPENAI_API_KEY");
    expect(html).not.toContain(account.secrets);
  });
  it("shows API configuration instead of an inactive saved ChatGPT connection", async () => {
    vi.stubEnv("OPENAI_AUTH_MODE", "api");
    vi.stubEnv("OPENAI_API_KEY", "api-key-sentinel");
    vi.stubEnv("MODEL_FAST", "fast-api-model");
    vi.stubEnv("MODEL_STRONG", "strong-api-model");
    const html = renderToStaticMarkup(
      await Settings({
        searchParams: Promise.resolve({ connection: "connected" }),
      }),
    );
    expect(html).toContain("OpenAI · API access");
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).not.toContain("Continue with ChatGPT");
    expect(html).not.toContain("Using ChatGPT plan");
    expect(html).not.toContain("api-key-sentinel");
    expect(html).not.toContain(account.secrets);
  });
});
