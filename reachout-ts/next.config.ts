import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents/PPR target mixed static+dynamic apps; every ReachOut
  // page is auth-gated and reads live DB data, so classic dynamic rendering
  // is the right model and keeps the build free of prerender workarounds.
  serverExternalPackages: ["better-sqlite3", "bcryptjs"],
};

export default nextConfig;
