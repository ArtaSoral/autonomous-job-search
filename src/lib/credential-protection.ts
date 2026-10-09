import { spawn } from "node:child_process";

// DPAPI binds encrypted credentials to this Windows user. Secrets pass through
// stdin, never shell arguments, process listings, logs, or browser storage.
async function dpapi(value: string, decrypt: boolean): Promise<string> {
  if (process.platform !== "win32")
    throw Error("ChatGPT credential storage currently requires Windows.");
  const operation = decrypt ? "Unprotect" : "Protect";
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $outputBytes=[System.Security.Cryptography.ProtectedData]::${operation}($inputBytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($outputBytes))`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
    );
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Credential protection timed out."));
    }, 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1024 * 1024) child.kill();
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(Error("Could not protect local credentials."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(output))
        reject(Error("Could not read or protect local credentials."));
      else resolve(output);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(value);
  });
}
export const protectCredentials = (value: unknown) =>
  dpapi(Buffer.from(JSON.stringify(value)).toString("base64"), false);
export const unprotectCredentials = async (value: string): Promise<unknown> =>
  JSON.parse(Buffer.from(await dpapi(value, true), "base64").toString("utf8"));
