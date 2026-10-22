/**
 * reachout CLI — the artisan-command equivalents for the TS app.
 * Usage: npx tsx cli.ts <command> [args]
 *
 *   run <profile> [--force]   Run the agent for one profile now (inline)
 *   discover                  Queue a run per active profile (back-pressure)
 *   send-approved             Queue send_draft jobs for approved drafts
 *   poll-replies              Fetch UNSEEN inbox messages (IMAP)
 *   draft-followups           Draft the one allowed follow-up per eligible lead
 *   prune                     Retention sweep (snippets, steps, dead leads)
 *   backup                    Dated SQLite copy under storage/backups
 *   forget <id|email>         Erase a lead; keep the opt-out as a hash
 *   export <lead_id>          Dump everything stored about a lead as JSON
 *   doctor [--quick]          Readiness report; non-zero exit on blockers
 *   show-run <id>             Print an agent run and its steps
 *   create-admin <email> <pw> Create a dashboard user
 */
import './lib/env';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { agentRuns, agentSteps, searchProfiles, users } from './lib/db/schema';
import { db } from './lib/db';
import { config, ts } from './lib/config';
import { Setting } from './lib/settings';
import { AgentRunner } from './lib/agent/runner';
import { LlmClient } from './lib/llm/client';
import { healthReport } from './lib/health';
import { ImapSource } from './lib/replies/imap-source';
import { exportLead, forgetLead } from './lib/privacy';
import * as tasks from './lib/tasks';
import { registerHandlers } from './lib/jobs';
import { workOnce } from './lib/queue';

const [cmd, ...args] = process.argv.slice(2);

async function main(): Promise<number> {
  switch (cmd) {
    case 'run': {
      const key = args[0];
      if (!key) return fail('usage: run <profile id|name> [--force]');
      if (Setting.bool('discovery_paused') && !args.includes('--force')) {
        return fail('Discovery is paused (Settings → Pause discovery). Use --force to run anyway.');
      }
      const profile = db().select().from(searchProfiles)
        .where(eq(searchProfiles.active, true)).all()
        .find((p) => String(p.id) === key || p.name === key);
      if (!profile) return fail(`No active search profile matches '${key}'.`);
      console.log(`Running agent for profile: ${profile.name} (model: ${config.llm.model})`);
      const run = await new AgentRunner(new LlmClient()).run(profile);
      console.log(`Status: ${run.status} | steps: ${run.stepsUsed} | leads: ${run.leadsSaved} | drafts: ${run.draftsQueued}`);
      if (run.error) console.warn(run.error);
      console.log('Review drafts in the dashboard: /review');
      return run.status === 'failed' ? 1 : 0;
    }

    case 'discover': return ok(tasks.discover());
    case 'send-approved': return ok(tasks.sendApproved());
    case 'poll-replies': return ok(await tasks.pollReplies());
    case 'draft-followups': return ok(await tasks.draftFollowups());
    case 'prune': return ok(tasks.prune());
    case 'backup': return ok(await tasks.backup());

    case 'forget': {
      const key = args[0];
      if (!key) return fail('usage: forget <lead id|email>');
      return ok(forgetLead(key));
    }

    case 'export': {
      const json = exportLead(Number(args[0]));
      if (!json) return fail(`No lead #${args[0]}.`);
      console.log(json);
      return 0;
    }

    case 'doctor': {
      const quick = args.includes('--quick');
      const rows = healthReport();
      if (!quick) {
        rows.push(await imapCheck());
        rows.push(await llmCheck());
      }
      for (const r of rows) {
        const icon = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]', skip: '[SKIP]' }[r.status];
        console.log(`${icon} ${r.name}: ${r.detail}`);
      }
      const fails = rows.filter((r) => r.status === 'fail').length;
      const warns = rows.filter((r) => r.status === 'warn').length;
      console.log();
      if (fails > 0) {
        console.error(`${fails} blocking problem(s) — fix them before real sending.`);
        return 1;
      }
      console.log(warns > 0 ? `No blockers. ${warns} warning(s) worth reading.` : 'All checks pass.');
      return 0;
    }

    case 'show-run': {
      const run = db().select().from(agentRuns).where(eq(agentRuns.id, Number(args[0]))).get();
      if (!run) return fail(`No run #${args[0]}.`);
      console.log(`Run #${run.id} — profile ${run.profileId} — ${run.status} (model ${run.model ?? '?'})`);
      console.log(`steps ${run.stepsUsed} · leads ${run.leadsSaved} · drafts ${run.draftsQueued}` + (run.error ? ` · error: ${run.error}` : ''));
      for (const s of db().select().from(agentSteps).where(eq(agentSteps.runId, run.id)).all()) {
        const bits = [s.role, s.tool].filter(Boolean).join(' ');
        const detail = s.result ? JSON.stringify(s.result).slice(0, 160) : '';
        console.log(`  #${s.id} step ${s.step} ${bits} ${detail}`);
      }
      return 0;
    }

    case 'create-admin': {
      const [email, password] = args;
      if (!email || !password) return fail('usage: create-admin <email> <password>');
      if (password.length < 8) return fail('Password must be at least 8 characters.');
      const addr = email.trim().toLowerCase();
      const hash = await bcrypt.hash(password, 10);
      const existing = db().select().from(users).where(eq(users.email, addr)).get();
      if (existing) {
        db().update(users).set({ password: hash, updatedAt: ts() }).where(eq(users.id, existing.id)).run();
        return ok(`Password updated for ${addr}.`);
      }
      db().insert(users).values({
        name: addr.split('@')[0], email: addr, password: hash,
        createdAt: ts(), updatedAt: ts(),
      }).run();
      return ok(`Admin user ${addr} created.`);
    }

    case 'work-once': {
      // Run a single queued job — handy for debugging the queue.
      registerHandlers();
      const did = await workOnce();
      return ok(did ? 'Worked one job.' : 'Nothing due.');
    }

    default:
      console.error(`Unknown command '${cmd ?? ''}'. Commands: run, discover, send-approved, poll-replies, draft-followups, prune, backup, forget, export, doctor, show-run, create-admin, work-once`);
      return 1;
  }
}

async function imapCheck() {
  if (!ImapSource.configured()) return { name: 'IMAP reply inbox', status: 'skip' as const, detail: 'not configured' };
  const okProbe = await ImapSource.probe();
  return { name: 'IMAP reply inbox', status: okProbe ? 'ok' as const : 'fail' as const, detail: okProbe ? 'connected' : 'connection failed — check IMAP_* settings' };
}

async function llmCheck() {
  try {
    const res = await new LlmClient().chat([{ role: 'user', content: 'Reply with the word ok.' }]);
    const content = (res.content ?? '').toLowerCase();
    return { name: 'LLM endpoint', status: 'ok' as const, detail: `responded (${config.llm.model})${content.includes('ok') ? '' : ' — unexpected reply'}` };
  } catch (e) {
    return { name: 'LLM endpoint', status: 'fail' as const, detail: (e as Error).message.slice(0, 200) };
  }
}

function ok(msg: string): number { console.log(msg); return 0; }
function fail(msg: string): number { console.error(msg); return 1; }

main().then((code) => process.exit(code)).catch((e) => {
  console.error((e as Error).stack ?? String(e));
  process.exit(1);
});
