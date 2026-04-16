/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for Railway / Docker deployment — outputs a self-contained
  // Node.js server in .next/standalone that does not need the full
  // node_modules tree at runtime.
  output: "standalone",

  async rewrites() {
    // In production, NEXT_PUBLIC_API_URL points to the Railway backend
    // service URL; in dev it falls back to localhost:3001.
    const backendUrl =
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
