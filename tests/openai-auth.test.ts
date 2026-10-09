import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { generateKeyPair, SignJWT } from "jose";
const verification = vi.hoisted(() => ({
  key: undefined as CryptoKey | undefined,
}));
vi.mock("jose", async (original) => ({
  ...(await original<typeof import("jose")>()),
  createRemoteJWKSet: () => async () => verification.key!,
}));
vi.mock("../src/lib/credential-protection", () => ({
  protectCredentials: async (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64"),
  unprotectCredentials: async (value: string) =>
    JSON.parse(Buffer.from(value, "base64").toString()),
}));
import {
  beginSignIn,
  finishSignIn,
  activeAccount,
  accessToken,
  accounts,
  chooseModels,
  modelName,
  signOut,
} from "../src/lib/openai-auth";
import { exec, row } from "../src/lib/db";
let privateKey: CryptoKey;
beforeAll(async () => {
  process.env.DATABASE_PATH = `data/tests/openai-auth-${process.pid}-${Date.now()}.sqlite`;
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  verification.key = pair.publicKey;
});
beforeEach(() => {
  vi.stubEnv("OPENAI_AUTH_MODE", "chatgpt");
  for (const table of [
    "openai_auth_meta",
    "openai_auth_pending",
    "openai_accounts",
  ])
    exec(`DELETE FROM ${table}`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function attempt() {
  const url = new URL(await beginSignIn("browser"));
  const state = url.searchParams.get("state")!;
  const saved = row<{ secrets: string }>(
    "SELECT secrets FROM openai_auth_pending WHERE state=?",
    state,
  )!;
  const pending = JSON.parse(Buffer.from(saved.secrets, "base64").toString());
  const callback = new URL("http://127.0.0.1:3000/auth/callback");
  callback.search = new URLSearchParams({
    state,
    code: "test-code",
    client_id: "oaiapp_test",
  }).toString();
  return { url, state, pending, callback };
}
async function token(
  nonce: string,
  changes: {
    nonce?: string;
    issuer?: string;
    audience?: string;
    expired?: boolean;
    signingKey?: CryptoKey;
  } = {},
) {
  return new SignJWT({
    nonce: changes.nonce ?? nonce,
    email: "test@example.invalid",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(changes.issuer || "https://auth.openai.com")
    .setAudience(changes.audience || "oaiapp_test")
    .setSubject("test-subject")
    .setIssuedAt()
    .setExpirationTime(
      changes.expired ? Math.floor(Date.now() / 1000) - 100 : "1h",
    )
    .sign(changes.signingKey || privateKey);
}
function fetchTokens(
  idToken: string,
  scope = "openid resource.invoke chatgpt.tokens.use.direct offline_access",
) {
  const fetcher = vi.fn().mockImplementation(async (url, request) => {
    if (String(url).endsWith("/oauth/token")) {
      expect(new URLSearchParams(request.body).get("client_id")).toBe(
        "oaiapp_test",
      );
      return Response.json({
        access_token: "test-access",
        refresh_token: "test-refresh",
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope,
      });
    }
    return Response.json({
      models: [
        { slug: "test-luna", display_name: "Fast", visibility: "list" },
        { slug: "test-sol", display_name: "Strong", visibility: "list" },
        { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
      ],
    });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function connect() {
  const pending = await attempt();
  fetchTokens(await token(pending.pending.nonce));
  await finishSignIn(pending.callback, "browser");
  return pending;
}
describe("ChatGPT sign-in and renewal", () => {
  it("uses dynamic registration, loopback callback, PKCE and a stable host", async () => {
    const first = await attempt(),
      second = await attempt();
    expect(first.url.searchParams.get("client_id")).toBe(
      "dynamic_agent_client",
    );
    expect(first.url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3000/auth/callback",
    );
    expect(first.url.searchParams.get("ext_agent_host_id")).toBe(
      second.url.searchParams.get("ext_agent_host_id"),
    );
    expect(first.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(first.state).not.toBe(second.state);
  });
  it("validates sign-in, loads account models and reuses the issued registration", async () => {
    await connect();
    expect(accounts()).toHaveLength(1);
    expect(activeAccount()?.subject).toBe("test-subject");
    expect(modelName()).toBe("test-luna");
    expect(modelName(true)).toBe("test-sol");
    expect(JSON.parse(activeAccount()!.models)).toHaveLength(2);
    const repeat = new URL(await beginSignIn("browser", "oaiapp_test"));
    expect(repeat.searchParams.get("client_id")).toBe("oaiapp_test");
    expect(repeat.searchParams.has("agent_name_hint")).toBe(false);
    expect(repeat.searchParams.has("id_token_hint")).toBe(true);
    expect(() => chooseModels("hidden", "test-sol")).toThrow("available");
  });
  it("rejects an unrelated browser, expired state and replay", async () => {
    const pending = await attempt();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      finishSignIn(pending.callback, "different-browser"),
    ).rejects.toThrow("state");
    exec("UPDATE openai_auth_pending SET expires_at=0");
    await expect(finishSignIn(pending.callback, "browser")).rejects.toThrow(
      "state",
    );
    expect(fetcher).not.toHaveBeenCalled();
    const complete = await connect();
    await expect(finishSignIn(complete.callback, "browser")).rejects.toThrow(
      "state",
    );
  });
  it.each(["nonce", "issuer", "audience", "expired", "signature"])(
    "rejects an invalid ID token (%s)",
    async (field) => {
      const pending = await attempt();
      const changes: Parameters<typeof token>[1] = {};
      if (field === "expired") changes.expired = true;
      else if (field === "signature")
        changes.signingKey = (await generateKeyPair("RS256")).privateKey;
      else changes[field as "nonce" | "issuer" | "audience"] = "wrong";
      fetchTokens(await token(pending.pending.nonce, changes));
      await expect(finishSignIn(pending.callback, "browser")).rejects.toThrow();
      expect(activeAccount()).toBeUndefined();
    },
  );
  it("rejects identity-only permission", async () => {
    const pending = await attempt();
    fetchTokens(await token(pending.pending.nonce), "openid email profile");
    await expect(finishSignIn(pending.callback, "browser")).rejects.toThrow(
      "plan usage",
    );
    expect(accounts()).toHaveLength(0);
  });
  it("serializes refreshes and atomically saves the rotated token", async () => {
    await connect();
    exec("UPDATE openai_accounts SET expires_at=0");
    const fetcher = vi.fn().mockImplementation(async (_url, request) => {
      const body = new URLSearchParams(request.body);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("scope")).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await Promise.all([accessToken(), accessToken()])).toEqual([
      "rotated-access",
      "rotated-access",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const secret = JSON.parse(
      Buffer.from(activeAccount()!.secrets!, "base64").toString(),
    );
    expect(secret.refresh_token).toBe("rotated-refresh");
  });
  it("clears local tokens while retaining the account registration if revocation fails", async () => {
    await connect();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Error("offline")));
    expect(await signOut()).toBe(false);
    expect(activeAccount()?.secrets).toBeNull();
    expect(accounts()).toHaveLength(1);
    await expect(accessToken()).rejects.toThrow("Continue with ChatGPT");
  });
});
