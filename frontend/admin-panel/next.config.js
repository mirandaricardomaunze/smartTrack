/** @type {import('next').NextConfig} */
const nextConfig = {
  // Habilita React Strict Mode para detectar problemas
  reactStrictMode: true,

  // Variáveis de ambiente públicas (acessíveis no browser)
  env: {
    NEXT_PUBLIC_APP_NAME: 'SmartTrack Admin',
    NEXT_PUBLIC_APP_VERSION: '1.0.0',
  },

  // Headers de segurança
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
