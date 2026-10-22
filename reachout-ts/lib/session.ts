import { SignJWT, jwtVerify } from 'jose';
import { config } from './config';

/**
 * Session token signing/verification — deliberately DB-free so proxy.ts
 * can use it without pulling better-sqlite3 into the middleware bundle.
 */
export const SESSION_COOKIE = 'reachout_session';
export const SESSION_TTL = '12h';

function secret(): Uint8Array {
  const s = config.sessionSecret || 'reachout-dev-secret-change-me';
  return new TextEncoder().encode(s);
}

export interface Session { uid: number; email: string }

export async function signSession(payload: Session): Promise<string> {
  return new SignJWT({ uid: payload.uid, email: payload.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt().setExpirationTime(SESSION_TTL)
    .sign(secret());
}

export async function verifyToken(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return { uid: Number(payload.uid), email: String(payload.email) };
  } catch {
    return null;
  }
}
