import type { NextConfig } from 'next';
import path from 'node:path';
// Next injects inline hydration scripts and the UI uses inline styles, so script/style allow 'unsafe-inline'; everything else is same-origin only.
const csp=["default-src 'self'","script-src 'self' 'unsafe-inline'","style-src 'self' 'unsafe-inline'","img-src 'self' data: blob:","font-src 'self' data:","connect-src 'self'","frame-src 'self'","object-src 'none'","base-uri 'self'","form-action 'self'","frame-ancestors 'self'"].join('; ');
const securityHeaders=[
  {key:'Content-Security-Policy',value:csp},
  {key:'X-Content-Type-Options',value:'nosniff'},
  {key:'X-Frame-Options',value:'SAMEORIGIN'},
  {key:'Referrer-Policy',value:'same-origin'},
  {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=(), payment=()'},
];
const config:NextConfig={
  outputFileTracingRoot:path.resolve(process.cwd()),
  serverExternalPackages:['pg','pdfjs-dist','mailparser'],
  experimental:{serverActions:{bodySizeLimit:'15mb'}},
  poweredByHeader:false,
  async headers(){return [{source:'/:path*',headers:securityHeaders}];},
};
export default config;
