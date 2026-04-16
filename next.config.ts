import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: false,
  serverExternalPackages: ['pdfkit', 'sharp', 'ssh2-sftp-client'],
  allowedDevOrigins: ['ims.onetwo3d.co.uk', 'ims-stage.onetwo3d.co.uk'],
  outputFileTracingExcludes: {
    '/api/backup/restore': ['./next.config.ts'],
  },
};

export default nextConfig;
