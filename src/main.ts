// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

function parseCorsOrigins(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\/+$/, '')); // remove trailing slash
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Allow local dev + optionally allow production domains via env
  // Example on Render:
  // CORS_ORIGINS=https://your-web.vercel.app,https://your-web-git-main.vercel.app
  const envOrigins = parseCorsOrigins(process.env.CORS_ORIGINS);

  const localOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
  ];

  const allowedOrigins = Array.from(new Set([...localOrigins, ...envOrigins]));

  app.enableCors({
    origin: (origin, callback) => {
      // allow server-to-server calls (no Origin header) and tools like curl/postman
      if (!origin) return callback(null, true);

      const clean = origin.replace(/\/+$/, '');
      if (allowedOrigins.includes(clean)) return callback(null, true);

      return callback(
        new Error(
          `CORS blocked for origin: ${origin}. Set CORS_ORIGINS env to allow it.`,
        ),
        false,
      );
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Authorization',
    credentials: false,
  });

  const port = Number(process.env.PORT || 3333);
  await app.listen(port, '0.0.0.0');

  console.log(`[bac-api] Listening on http://localhost:${port}`);
  if (allowedOrigins.length) {
    console.log(`[bac-api] CORS allowed origins: ${allowedOrigins.join(', ')}`);
  }
}
bootstrap();
