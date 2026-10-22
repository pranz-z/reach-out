import { redirect } from 'next/navigation';
import { attemptLogin, currentUser } from '@/lib/auth';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentUser()) redirect('/');
  const { error } = await searchParams;

  async function login(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');
    if (await attemptLogin(email, password)) redirect('/');
    redirect('/login?error=1');
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="logo"><span className="mark">R</span><span>ReachOut</span></div>
        <p className="sub">Private outreach console — sign in to continue.</p>
        {error && <div className="note">Invalid credentials.</div>}
        <form action={login}>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required autoFocus />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" required />
          <button type="submit" className="btn primary">Sign in</button>
        </form>
      </div>
    </div>
  );
}
