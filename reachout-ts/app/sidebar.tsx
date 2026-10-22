import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { drafts, replies } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { logout } from '@/lib/auth';

const ICONS: Record<string, string> = {
  overview: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  leads: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  review: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z',
  sent: 'M2.01 21 23 12 2.01 3 2 10l15 2-15 2z',
  replies: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z',
  profiles: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
};

function NavIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Sidebar() {
  const pending = db().select().from(drafts).where(eq(drafts.status, 'pending')).all().length;
  const awaiting = db().select().from(replies).where(eq(replies.needsReview, true)).all().length;

  const nav = [
    ['overview', 'Overview', '/', 0],
    ['leads', 'Leads', '/leads', 0],
    ['review', 'Review', '/review', pending],
    ['sent', 'Sent', '/sent', 0],
    ['replies', 'Replies', '/replies', awaiting],
    ['profiles', 'Profiles', '/profiles', 0],
    ['settings', 'Settings', '/settings', 0],
  ] as const;

  async function signOut() {
    'use server';
    await logout();
    redirect('/login');
  }

  return (
    <aside>
      <Link href="/" className="logo">
        <span className="mark">R</span>
        <span>ReachOut</span>
      </Link>
      <nav>
        <div className="nav-label">Workspace</div>
        {nav.map(([icon, label, href, badge]) => (
          <Link key={href} href={href}>
            <NavIcon name={icon} />
            <span>{label}</span>
            {badge ? <span className="count">{badge}</span> : null}
          </Link>
        ))}
      </nav>
      <form action={signOut} className="logout-form">
        <button type="submit" className="logout-btn">Sign out</button>
      </form>
    </aside>
  );
}
