import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The end-to-end tests set this, so their dev server does not clash with yours (one dev server
  // per output folder).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Keeps magic-link URLs (with tokens) from leaking via the Referer header.
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
