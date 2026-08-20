/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile the shared workspace packages from source (raw .ts, no dist).
  transpilePackages: ["@nseluga/ui", "@nseluga/app-core"],
  // satteri (the markdown renderer behind lib/os/osFiles.ts) is ESM around a
  // native binding. Webpack emits its dist as a media asset and then fails to
  // minify it as non-module code, so it is require()'d at runtime instead of
  // bundled. Server-only by construction — nothing in app/ imports it from a
  // client component.
  experimental: { serverComponentsExternalPackages: ["satteri"] },
  // Self-contained server bundle — CI ships .next/standalone as the deploy artifact.
  output: "standalone",
};

export default nextConfig;
