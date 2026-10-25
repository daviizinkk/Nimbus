import type { AuthSession } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    authSession?: AuthSession | null;
  }
}
