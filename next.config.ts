import type { NextConfig } from "next";
const config: NextConfig = {
  serverExternalPackages: ["drizzle-orm", "better-sqlite3", "node-cron"],
};
export default config;
