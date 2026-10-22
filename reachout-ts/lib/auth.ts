import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { users } from './db/schema';
import { db } from './db';
import { SESSION_COOKIE, Session, signSession, verifyToken } from './session';

export { SESSION_COOKIE, verifyToken };
export type { Session };

/** Check credentials against the shared users table; issue the session cookie. */
export async function attemptLogin(email: string, password: string): Promise<boolean> {
  const user = db().select().from(users).where(eq(users.email, email.trim().toLowerCase())).get();
  if (!user) return false;
  // Laravel bcrypt hashes verify fine with bcryptjs ($2y$ is accepted as $2a$ variant).
  const hash = user.password.replace(/^\$2y\$/, '$2a$');
  if (!(await bcrypt.compare(password, hash))) return false;

  const token = await signSession({ uid: user.id, email: user.email });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 12 * 3600,
  });
  return true;
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** For server components/actions — reads the request cookie. */
export async function currentUser(): Promise<Session | null> {
  return verifyToken((await cookies()).get(SESSION_COOKIE)?.value);
}
