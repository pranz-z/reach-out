import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import './globals.css';
import { SESSION_COOKIE } from '@/lib/auth';
import { Sidebar } from './sidebar';

export const metadata: Metadata = {
  title: 'ReachOut',
  description: 'Private outreach pipeline — discover, draft, review, send.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const authed = Boolean((await cookies()).get(SESSION_COOKIE)?.value);

  if (!authed) {
    // Login page renders bare (no chrome).
    return <html lang="en"><body className="auth">{children}</body></html>;
  }

  return (
    <html lang="en">
      <body>
        <div className="app">
          <Sidebar />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
