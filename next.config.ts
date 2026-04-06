import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: false,
  serverExternalPackages: ['pdfkit', 'sharp', 'ssh2-sftp-client'],
};

export default nextConfig;
