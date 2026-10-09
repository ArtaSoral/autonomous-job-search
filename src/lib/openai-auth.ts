import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { exec, row, rows, transaction } from "./db";
import {
  protectCredentials,
  unprotectCredentials,
} from "./credential-protection";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const scopes =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const random = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  token_type: z.string().refine((s) => s.toLowerCase() === "bearer"),
  scope: z.string().optional(),
});
const secretSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  id_token: z.string(),
  scopes: z.array(z.string()),
});
const pendingSchema = z.object({
  verifier: z.string(),
  nonce: z.string(),
  redirectUri: z.string(),
  clientId: z.string(),
  expectedSubject: z.string().nullable(),
});
export type AccountModel = { slug: string; display_name: string };
export type ChatGPTAccount = {
  client_id: string;
  subject: string;
  email: string;
  secrets: string | null;
  expires_at: number;
  models: string;
  fast_model: string;
  strong_model: string;
};
export const accounts = () =>
  rows<ChatGPTAccount>("SELECT * FROM openai_accounts ORDER BY rowid");
export function activeAccount() {
  const selected = row<{ value: string }>(
    "SELECT value FROM openai_auth_meta WHERE name='active'",
  );
  return selected
    ? row<ChatGPTAccount>(
        "SELECT * FROM openai_accounts WHERE client_id=?",
        selected.value,
      )
    : undefined;
}
export function modelName(strong = false) {
  if (process.env.OPENAI_AUTH_MODE === "api")
    return process.env[strong ? "MODEL_STRONG" : "MODEL_FAST"] || "";
  const account = activeAccount();
  return account?.[strong ? "strong_model" : "fast_model"] || "";
}
export const modelConfigured = () =>
  process.env.OPENAI_AUTH_MODE === "api"
    ? Boolean(process.env.OPENAI_API_KEY && modelName())
    : Boolean(activeAccount()?.secrets && modelName());
function setMeta(name: string, value: string) {
  exec(
    "INSERT INTO openai_auth_meta(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
    name,
    value,
  );
}
export async function beginSignIn(browser: string, clientId?: string) {
  const existing = clientId
    ? row<ChatGPTAccount>(
        "SELECT * FROM openai_accounts WHERE client_id=?",
        clientId,
      )
    : undefined;
  if (clientId && !existing) throw Error("Unknown saved account.");
  const hostId = transaction(() => {
    const saved = row<{ value: string }>(
      "SELECT value FROM openai_auth_meta WHERE name='host'",
    );
    if (saved) return saved.value;
    const value = `urn:uuid:${randomUUID()}`;
    setMeta("host", value);
    return value;
  });
  const pending = {
    verifier: random(),
    nonce: random(),
    redirectUri: "http://127.0.0.1:3000/auth/callback",
    clientId: existing?.client_id || "dynamic_agent_client",
    expectedSubject: existing?.subject || null,
  };
  const state = random();
  const secrets = await protectCredentials(pending);
  exec("DELETE FROM openai_auth_pending WHERE expires_at<?", Date.now());
  exec(
    "INSERT INTO openai_auth_pending(state,browser_hash,secrets,expires_at) VALUES(?,?,?,?)",
    state,
    hash(browser),
    secrets,
    Date.now() + 600000,
  );
  const url = new URL(`${issuer}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: pending.clientId,
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: pending.redirectUri,
    scope: scopes,
    resource,
    state,
    nonce: pending.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256")
      .update(pending.verifier)
      .digest("base64url"),
  }).toString();
  if (!existing) url.searchParams.set("agent_name_hint", "Personal Job Finder");
  else {
    if (existing.email) url.searchParams.set("login_hint", existing.email);
    if (existing.secrets) {
      const secret = secretSchema.parse(
        await unprotectCredentials(existing.secrets),
      );
      url.searchParams.set("id_token_hint", secret.id_token);
    }
  }
  return url.toString();
}
async function tokenRequest(body: URLSearchParams) {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok)
    throw Error(
      `ChatGPT authorization failed (${response.status}). Sign in again in Settings.`,
    );
  return tokenSchema.parse(await response.json());
}
export async function finishSignIn(url: URL, browser: string) {
  const state = url.searchParams.get("state") || "";
  const saved = transaction(() => {
    const pending = row<{
      secrets: string;
      browser_hash: string;
      expires_at: number;
    }>("SELECT * FROM openai_auth_pending WHERE state=?", state);
    if (
      !pending ||
      pending.browser_hash !== hash(browser) ||
      pending.expires_at <= Date.now()
    )
      throw Error("Sign-in state could not be verified.");
    exec("DELETE FROM openai_auth_pending WHERE state=?", state);
    return pending;
  });
  if (url.searchParams.has("error")) throw Error("Sign-in was not authorized.");
  const pending = pendingSchema.parse(
    await unprotectCredentials(saved.secrets),
  );
  const suppliedId = url.searchParams.get("client_id");
  const clientId =
    pending.clientId === "dynamic_agent_client" ? suppliedId : pending.clientId;
  if (
    !clientId ||
    clientId === "dynamic_agent_client" ||
    (suppliedId && suppliedId !== clientId)
  )
    throw Error("Incomplete or mismatched registration.");
  const code = url.searchParams.get("code");
  if (!code) throw Error("Missing authorization code.");
  const tokens = await tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      resource,
    }),
  );
  if (!tokens.id_token || !tokens.refresh_token)
    throw Error("Incomplete ChatGPT authorization.");
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer,
    audience: clientId,
    requiredClaims: ["sub", "exp", "iat"],
    clockTolerance: 5,
  });
  if (
    payload.nonce !== pending.nonce ||
    !payload.sub ||
    (pending.expectedSubject && payload.sub !== pending.expectedSubject)
  )
    throw Error("ChatGPT identity did not match this sign-in.");
  const granted = (tokens.scope || "").split(" ");
  if (
    !granted.includes("chatgpt.tokens.use.direct") ||
    !granted.includes("resource.invoke")
  )
    throw Error("ChatGPT plan usage was not enabled.");
  const secrets = await protectCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    scopes: granted,
  });
  // A verified identity never replaces a different identity's registration.
  await sessionLock(clientId, async () =>
    transaction(() => {
      const previous = row<ChatGPTAccount>(
        "SELECT * FROM openai_accounts WHERE client_id=?",
        clientId,
      );
      if (previous && previous.subject !== payload.sub)
        throw Error("Saved account identity mismatch.");
      exec(
        "INSERT INTO openai_accounts(client_id,subject,email,secrets,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET email=excluded.email,secrets=excluded.secrets,expires_at=excluded.expires_at",
        clientId,
        payload.sub!,
        typeof payload.email === "string" ? payload.email : "",
        secrets,
        Date.now() + tokens.expires_in * 1000,
      );
      setMeta("active", clientId);
    }),
  );
  await refreshModels();
}
async function sessionLock<T>(
  clientId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const name = `lock:${clientId}`,
    owner = random();
  for (let attempt = 0; attempt < 100; attempt++) {
    const acquired = transaction(() => {
      const existing = row<{ value: string }>(
        "SELECT value FROM openai_auth_meta WHERE name=?",
        name,
      );
      if (existing && JSON.parse(existing.value).expires > Date.now())
        return false;
      setMeta(name, JSON.stringify({ owner, expires: Date.now() + 60000 }));
      return true;
    });
    if (acquired) {
      try {
        return await fn();
      } finally {
        transaction(() => {
          const existing = row<{ value: string }>(
            "SELECT value FROM openai_auth_meta WHERE name=?",
            name,
          );
          if (existing && JSON.parse(existing.value).owner === owner)
            exec("DELETE FROM openai_auth_meta WHERE name=?", name);
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("ChatGPT credentials are being renewed. Try again shortly.");
}
export async function accessToken(clientId?: string) {
  if (process.env.OPENAI_AUTH_MODE === "api") {
    if (!process.env.OPENAI_API_KEY)
      throw Error("Set OPENAI_API_KEY locally for API access.");
    return process.env.OPENAI_API_KEY;
  }
  const selected = clientId
    ? row<ChatGPTAccount>(
        "SELECT * FROM openai_accounts WHERE client_id=?",
        clientId,
      )
    : activeAccount();
  if (!selected?.secrets)
    throw Error("Continue with ChatGPT in Settings to enable model features.");
  return sessionLock(selected.client_id, async () => {
    const account = row<ChatGPTAccount>(
      "SELECT * FROM openai_accounts WHERE client_id=?",
      selected.client_id,
    )!;
    if (!account.secrets) throw Error("This ChatGPT account is signed out.");
    const secret = secretSchema.parse(
      await unprotectCredentials(account.secrets),
    );
    if (account.expires_at > Date.now() + 60000) return secret.access_token;
    const tokens = await tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: account.client_id,
        refresh_token: secret.refresh_token,
        resource,
      }),
    );
    const granted = tokens.scope ? tokens.scope.split(" ") : secret.scopes;
    if (
      !granted.includes("chatgpt.tokens.use.direct") ||
      !granted.includes("resource.invoke")
    )
      throw Error("ChatGPT plan access was removed. Sign in again.");
    const encrypted = await protectCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || secret.refresh_token,
      id_token: tokens.id_token || secret.id_token,
      scopes: granted,
    });
    exec(
      "UPDATE openai_accounts SET secrets=?,expires_at=? WHERE client_id=?",
      encrypted,
      Date.now() + tokens.expires_in * 1000,
      account.client_id,
    );
    return tokens.access_token;
  });
}
export async function refreshModels() {
  const selected = activeAccount();
  if (!selected) throw Error("Sign in to ChatGPT first.");
  const token = await accessToken(selected.client_id);
  const response = await fetch(`${resource}/models`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(
      "Could not load the account's models. Refresh models in Settings.",
    );
  const catalog = z
    .object({
      models: z.array(
        z.object({
          slug: z.string().min(1),
          display_name: z.string(),
          visibility: z.string(),
        }),
      ),
    })
    .parse(await response.json());
  const models = catalog.models
    .filter((m) => m.visibility === "list")
    .map(({ slug, display_name }) => ({ slug, display_name }));
  const existing = (name: string) => models.some((m) => m.slug === name);
  const fast = existing(selected.fast_model)
    ? selected.fast_model
    : models.find((m) => m.slug.includes("luna"))?.slug ||
      models[0]?.slug ||
      "";
  const strong = existing(selected.strong_model)
    ? selected.strong_model
    : models.find((m) => m.slug.includes("sol"))?.slug || models[0]?.slug || "";
  exec(
    "UPDATE openai_accounts SET models=?,fast_model=?,strong_model=? WHERE client_id=?",
    JSON.stringify(models),
    fast,
    strong,
    selected.client_id,
  );
}
export function chooseModels(fast: string, strong: string) {
  const account = activeAccount();
  if (!account?.secrets) throw Error("Sign in to ChatGPT first.");
  const models = JSON.parse(account.models) as AccountModel[];
  if (![fast, strong].every((slug) => models.some((m) => m.slug === slug)))
    throw Error("Choose models available to this account.");
  exec(
    "UPDATE openai_accounts SET fast_model=?,strong_model=? WHERE client_id=?",
    fast,
    strong,
    account.client_id,
  );
}
export function switchAccount(clientId: string) {
  if (
    !row<ChatGPTAccount>(
      "SELECT * FROM openai_accounts WHERE client_id=? AND secrets IS NOT NULL",
      clientId,
    )
  )
    throw Error("Sign in to this account first.");
  setMeta("active", clientId);
}
export async function signOut() {
  const selected = activeAccount();
  if (!selected?.secrets) return true;
  return sessionLock(selected.client_id, async () => {
    const account = row<ChatGPTAccount>(
      "SELECT * FROM openai_accounts WHERE client_id=?",
      selected.client_id,
    )!;
    if (!account.secrets) return true;
    const secret = secretSchema.parse(
      await unprotectCredentials(account.secrets),
    );
    let revoked = false;
    try {
      const discovery = await fetch(
        `${issuer}/.well-known/openid-configuration`,
        { redirect: "error", signal: AbortSignal.timeout(5000) },
      );
      if (!discovery.ok) throw Error("Discovery unavailable");
      const config = z
        .object({ issuer: z.literal(issuer), revocation_endpoint: z.url() })
        .parse(await discovery.json());
      const endpoint = new URL(config.revocation_endpoint);
      if (endpoint.origin !== issuer)
        throw Error("Invalid revocation endpoint");
      for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
        const response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: secret.refresh_token,
            token_type_hint: "refresh_token",
            client_id: account.client_id,
          }),
        });
        revoked = response.status === 200;
        if (!revoked && response.status < 500) break;
        if (!revoked) await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } catch {
      /* Local sign-out still clears credentials. */
    }
    exec(
      "UPDATE openai_accounts SET secrets=NULL,expires_at=0 WHERE client_id=?",
      account.client_id,
    );
    return revoked;
  });
}
