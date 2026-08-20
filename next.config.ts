import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The LAN address this machine is reachable at changes with the DHCP lease,
  // so the list carries every one it has held — a request from an address
  // that is not here has its HMR socket and other dev assets blocked.
  allowedDevOrigins: ["10.0.21.161", "10.0.40.9", "odg.odienmall.com"],
  // The dev-tools bubble sits over the sidebar and hides a menu item. It only
  // appears under `next dev`, which is how this is currently served, so it is
  // in front of real users. Compile and runtime errors are still surfaced.
  devIndicators: false,
};

export default nextConfig;
