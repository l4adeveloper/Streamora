import type { NextConfig } from "next";
const config: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  experimental: {
    // Keep build-time type checking on the compiler API when the CLI yields no config output.
    useTypeScriptCli: false,
  },
  rewrites() {
    const apiBase = (
      process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000/api/v1"
    ).replace(/\/$/, "");
    // Same-origin Swagger/API proxy. A relative URL means a reverse proxy already routes /api/v1.
    if (apiBase.startsWith("/")) return [];
    return [{ source: "/api/v1/:path*", destination: `${apiBase}/:path*` }];
  },
};
export default config;
