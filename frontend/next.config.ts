import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Avoids workspace root inference warnings when this repo contains other lockfiles
    root: __dirname,
  },
  async rewrites() {
    const base = process.env.NEXT_PUBLIC_DATAVENTS_BASE_URL;
    if (base) {
      const trimmed = base.replace(/\/$/, "");
      return [
        {
          // Call e.g. /dv/v1/noauth/kalshi/markets?limit=10
          source: "/dv/:path*",
          destination: `${trimmed}/:path*`,
        },
      ];
    }
    return [];
  },
};

export default nextConfig;
