import { describe, expect, it } from "vitest";
import {
  protectCredentials,
  unprotectCredentials,
} from "../src/lib/credential-protection";
describe("Windows credential protection", () => {
  it.skipIf(process.platform !== "win32")(
    "round trips synthetic tokens with DPAPI without storing plaintext",
    async () => {
      const fake = { access_token: "synthetic-only-token", scope: "test" };
      const protectedValue = await protectCredentials(fake);
      expect(protectedValue).not.toContain(fake.access_token);
      expect(Buffer.from(protectedValue, "base64").toString()).not.toContain(
        fake.access_token,
      );
      expect(await unprotectCredentials(protectedValue)).toEqual(fake);
    },
    30000,
  );
});
