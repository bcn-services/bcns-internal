/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile the shared workspace packages from source (raw .ts, no dist).
  transpilePackages: ["@nseluga/ui", "@nseluga/app-core"],
};

export default nextConfig;
