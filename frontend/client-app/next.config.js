const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Build de produção autossuficiente (imagem Docker enxuta).
  output: 'standalone',
  // Monorepo: rastrear dependências a partir da raiz do repositório.
  // No Next 14 esta opção vive sob `experimental` (top-level só no Next 15+).
  experimental: {
    outputFileTracingRoot: path.join(__dirname, '../../'),
  },
  env: {
    NEXT_PUBLIC_APP_NAME: 'SmartTrack Cliente',
    NEXT_PUBLIC_APP_VERSION: '1.0.0',
  },
};

module.exports = nextConfig;
