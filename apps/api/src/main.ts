import 'reflect-metadata';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import * as tls from 'node:tls';
import { HttpsOptions } from '@nestjs/common/interfaces/external/https-options.interface';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Request, Response, NextFunction } from 'express';
import { SessionsController } from './sessions';
import { ProductsController } from './products';
import { FeishuController } from './feishu';

@Controller('health')
class HealthController {
  @Get()
  check() {
    return { status: 'ok', service: 'price-drop-api' };
  }
}

@Module({
  controllers: [HealthController, ProductsController, SessionsController, FeishuController],
})
class AppModule {}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function resolveWebDistDir(): string | null {
  const candidates = [
    join(process.cwd(), 'apps', 'web', 'dist'),
    join(__dirname, '..', '..', 'web', 'dist'),
    join(process.cwd(), '..', 'web', 'dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) {
      return dir;
    }
  }
  return null;
}

function buildHttpsOptions(): HttpsOptions | null {
  const certPath = process.env.TLS_CERT_FILE;
  const keyPath = process.env.TLS_KEY_FILE;
  if (!certPath || !keyPath || !existsSync(certPath) || !existsSync(keyPath)) {
    return null;
  }

  let cachedMtime = 0;
  let cachedContext: tls.SecureContext | null = null;

  const getContext = (): tls.SecureContext => {
    const stat = statSync(certPath);
    if (!cachedContext || stat.mtimeMs !== cachedMtime) {
      cachedMtime = stat.mtimeMs;
      cachedContext = tls.createSecureContext({
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
      });
    }
    return cachedContext;
  };

  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    SNICallback: (_servername: string, cb: (err: Error, ctx: tls.SecureContext) => void) => {
      try {
        cb(null as unknown as Error, getContext());
      } catch (err) {
        cb(err as Error, undefined as unknown as tls.SecureContext);
      }
    },
  };
}

async function bootstrap() {
  const httpsOptions = buildHttpsOptions();
  const app = await NestFactory.create(AppModule, httpsOptions ? { httpsOptions } : undefined);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  const webDistDir = resolveWebDistDir();
  if (webDistDir) {
    const indexHtmlPath = join(webDistDir, 'index.html');
    const expressApp = app.getHttpAdapter().getInstance();

    expressApp.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return next();
      }

      const safeRelPath = normalize(decodeURIComponent(req.path)).replace(/^(\.\.(\/|\\|$))+/, '');
      const candidateFile = join(webDistDir, safeRelPath);

      if (
        candidateFile.startsWith(webDistDir) &&
        existsSync(candidateFile) &&
        statSync(candidateFile).isFile()
      ) {
        const ext = extname(candidateFile).toLowerCase();
        res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
        if (ext !== '.html') {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
        createReadStream(candidateFile).pipe(res);
        return;
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      createReadStream(indexHtmlPath).pipe(res);
    });
  }

  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  await app.listen(port, host);
}
void bootstrap();

