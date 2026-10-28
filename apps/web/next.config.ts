import type { NextConfig } from 'next';
import path from 'node:path';
const config:NextConfig={
  outputFileTracingRoot:path.resolve(process.cwd()),
  serverExternalPackages:['pg','pdfjs-dist','mailparser'],
  experimental:{serverActions:{bodySizeLimit:'15mb'}},
  poweredByHeader:false,
};
export default config;
