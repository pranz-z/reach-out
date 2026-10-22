import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken, SESSION_COOKIE } from './lib/session';

/**
 * Auth gate — every page requires a session except /login (and Next
 * internals/static assets, excluded by the matcher). Server actions also
 * re-check inside each action; this is the page-level redirect.
 */
export async function proxy(request: NextRequest) {
  const session = await verifyToken(request.cookies.get(SESSION_COOKIE)?.value);
  const onLogin = request.nextUrl.pathname === '/login';

  if (!session && !onLogin) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  if (session && onLogin) {
    return NextResponse.redirect(new URL('/', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
