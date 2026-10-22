import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fresh SQLite file per test process — never touches the real DB.
const dir = mkdtempSync(join(tmpdir(), 'reachout-test-'));
process.env.DB_PATH = join(dir, 'test.sqlite');
process.env.SENDER_NAME = 'Franz';
process.env.PORTFOLIO_URL = 'https://example.com/portfolio';
process.env.MAIL_MAILER = 'log';
process.env.LLM_API_KEY = '';
