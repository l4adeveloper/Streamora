import type { NextConfig } from "next";
const config: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  rewrites() {
    const apiBase = (
      process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000/api/v1"
    ).replace(/\/$/, "");
    // Same-origin Swagger/API proxy. HTTPS Compose already routes /api/v1 in nginx.
    if (apiBase.startsWith("/")) return [];
    return [{ source: "/api/v1/:path*", destination: `${apiBase}/:path*` }];
  },
};
export default config;
