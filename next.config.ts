import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow LAN clients (e.g. the dev box reached over the VPN at 10.0.40.13)
  // to request dev-only assets like /_next/webpack-hmr.
  allowedDevOrigins: ["10.0.40.13"],
  experimental: {
    // Turbopack's persistent FileSystem cache (default-on since Next 16.1) uses
    // qfilter, which requires x86-64 BMI2 instructions and panics on CPUs/VMs
    // without them. Disable it for dev so the worker thread stops crashing.
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
