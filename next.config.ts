import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["10.0.40.9", "odg.odienmall.com"],
  // The dev-tools bubble sits over the sidebar and hides a menu item. It only
  // appears under `next dev`, which is how this is currently served, so it is
  // in front of real users. Compile and runtime errors are still surfaced.
  devIndicators: false,
};

export default nextConfig;
