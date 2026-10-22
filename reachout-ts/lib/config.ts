/**
 * Port of config/reachout.php — every knob reads from process.env with the
 * same env names and defaults, so .env values carry over unchanged.
 */

const int = (name: string, def: number): number => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
};
const str = (name: string, def = ''): string => process.env[name] ?? def;
const bool = (name: string, def: boolean): boolean => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === 'true' || v === '1';
};

export const config = {
  dbPath: str('DB_PATH', '../reachout/database/database.sqlite'),

  senderName: str('SENDER_NAME', 'Your Name'),
  senderAddress: str('SENDER_ADDRESS', 'you@example.com'),
  replyToAddress: str('REPLY_TO_ADDRESS', str('SENDER_ADDRESS', 'you@example.com')),
  portfolioUrl: str('PORTFOLIO_URL', 'https://example.com/portfolio'),
  dailySendLimit: int('DAILY_SEND_LIMIT', 20),
  requireApproval: bool('REQUIRE_APPROVAL', true),

  llm: {
    baseUrl: str('LLM_BASE_URL', 'https://api.groq.com/openai/v1'),
    apiKey: str('LLM_API_KEY'),
    model: str('LLM_MODEL', 'openai/gpt-oss-120b'),
    timeout: int('LLM_TIMEOUT', 120),
    fallbackBaseUrl: str('LLM_FALLBACK_BASE_URL') || null,
    fallbackModel: str('LLM_FALLBACK_MODEL', 'qwen3.5:4b'),
  },

  agent: {
    maxSteps: int('AGENT_MAX_STEPS', 40),
    maxLeadsPerRun: int('AGENT_MAX_LEADS_PER_RUN', 3),
    fullToolResults: int('AGENT_FULL_TOOL_RESULTS', 3),
    toolCallCaps: {
      search_places: 8,
      check_website: 20,
      find_facebook_link: 6,
      find_public_email: 8,
      check_suppression: 4,
      save_lead: 8,
      queue_draft_for_review: 6,
      list_draftable_leads: 2,
    } as Record<string, number>,
  },

  places: { apiKey: str('PLACES_API_KEY') || null },
  search: {
    provider: str('SEARCH_PROVIDER', 'brave'),
    apiKey: str('SEARCH_API_KEY') || null,
    engineId: str('SEARCH_ENGINE_ID') || null,
  },

  http: {
    userAgent: str('REACHOUT_USER_AGENT', `ReachOutBot/0.1 (+contact: ${str('SENDER_ADDRESS', 'you@example.com')})`),
    timeout: int('HTTP_TIMEOUT', 20),
  },

  requiredOptOutMarker: 'STOP',
  maxEmailWords: int('MAX_EMAIL_WORDS', 150),

  send: {
    timezone: 'Asia/Manila',
    windowStart: int('SEND_WINDOW_START', 9),
    windowEnd: int('SEND_WINDOW_END', 17),
    warmupWeek1: int('SEND_WARMUP_WEEK1', 5),
    warmupWeek2: int('SEND_WARMUP_WEEK2', 10),
    minDelaySeconds: int('SEND_MIN_DELAY_SECONDS', 180),
    maxDelaySeconds: int('SEND_MAX_DELAY_SECONDS', 720),
    followupDays: int('FOLLOWUP_AFTER_DAYS', 7),
  },

  resilience: {
    maxAttempts: int('RESILIENT_MAX_ATTEMPTS', 3),
    breakerFailures: int('RESILIENT_BREAKER_FAILURES', 3),
    breakerSeconds: int('RESILIENT_BREAKER_SECONDS', 900),
    retryAfterCap: int('RESILIENT_RETRY_AFTER_CAP', 60),
  },

  budgets: {
    llm: int('LLM_DAILY_CALLS', 500),
    places: int('PLACES_DAILY_CALLS', 50),
    search: int('SEARCH_DAILY_CALLS', 50),
    osm: int('OSM_DAILY_CALLS', 60),
  } as Record<string, number>,

  tokenBudgets: { llm: int('LLM_DAILY_TOKENS', 180000) } as Record<string, number>,

  discovery: {
    provider: str('DISCOVERY_PROVIDER', 'osm'),
    reviewQueueMax: int('REVIEW_QUEUE_MAX', 20),
    runMinutes: int('AGENT_RUN_MINUTES', 30),
    startHour: int('DISCOVERY_START_HOUR', 8),
    province: str('DISCOVERY_PROVINCE', 'Pampanga'),
    overpass: {
      urls: [
        str('OVERPASS_URL', 'https://overpass-api.de/api/interpreter'),
        'https://lz4.overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
      ],
      cacheHours: int('OVERPASS_CACHE_HOURS', 24),
      minDelayMs: int('OVERPASS_MIN_DELAY_MS', 1000),
      limit: int('OVERPASS_LIMIT', 15),
    },
    osmCategoryMap: {
      'restaurant': 'amenity=restaurant', 'cafe': 'amenity=cafe',
      'coffee shop': 'amenity=cafe', 'pharmacy': 'amenity=pharmacy',
      'bakery': 'shop=bakery', 'hardware store': 'shop=hardware',
      'hardware': 'shop=hardware', 'salon': 'shop=hairdresser',
      'barber': 'shop=hairdresser', 'barbershop': 'shop=hairdresser',
      'grocery': 'shop=convenience', 'convenience store': 'shop=convenience',
      'sari-sari': 'shop=convenience', 'sari sari': 'shop=convenience',
      'clinic': 'amenity=clinic', 'dental': 'amenity=dentist',
      'dentist': 'amenity=dentist', 'veterinary': 'amenity=veterinary',
      'car wash': 'amenity=car_wash', 'gym': 'leisure=fitness_centre',
      'hotel': 'tourism=hotel', 'school': 'amenity=school',
      'tailor': 'shop=tailor', 'laundry': 'shop=laundry',
      'printing': 'shop=copyshop', 'computer shop': 'shop=computer',
      'internet cafe': 'amenity=internet_cafe', 'water station': 'shop=water',
      'auto repair': 'shop=car_repair', 'tire shop': 'shop=tyres',
      'auto parts': 'shop=car_parts', 'car dealer': 'shop=car',
      'motorcycle repair': 'shop=motorcycle_repair',
    } as Record<string, string>,
    solutionHints: {
      'auto repair': 'job orders and quotes per plate number; service history per customer vehicle; maintenance reminders by message or email; parts and tire inventory with low-stock alerts; appointment booking; an AI assistant for customer questions',
      'car wash': 'job orders and quotes per plate number; service history per customer vehicle; maintenance reminders by message or email; parts and tire inventory with low-stock alerts; appointment booking; an AI assistant for customer questions',
      'tire shop': 'job orders and quotes per plate number; service history per customer vehicle; maintenance reminders by message or email; parts and tire inventory with low-stock alerts; appointment booking; an AI assistant for customer questions',
      'motorcycle repair': 'job orders and quotes per plate number; service history per customer vehicle; maintenance reminders by message or email; parts and tire inventory with low-stock alerts; appointment booking; an AI assistant for customer questions',
      'auto parts': 'parts inventory with low-stock alerts; quotes and orders per customer; an AI assistant for customer questions',
      'car dealer': 'test-drive appointment booking; lead tracking per customer; an AI assistant for customer questions',
      'restaurant': 'POS with table orders and daily sales reports; menu and price updates without printing; an AI assistant for customer questions',
      'cafe': 'POS with quick orders and daily sales reports; an AI assistant for customer questions',
      'pharmacy': 'inventory with expiry and low-stock alerts; an AI assistant for customer questions',
      'hardware store': 'inventory for many SKUs; quotes and delivery tracking; an AI assistant for customer questions',
      'salon': 'appointment booking with reminders; an AI assistant for customer questions',
    } as Record<string, string>,
  },

  replies: {
    imap: {
      host: str('IMAP_HOST') || null,
      port: int('IMAP_PORT', 993),
      user: str('IMAP_USER') || null,
      password: str('IMAP_PASSWORD') || null,
      encryption: str('IMAP_ENCRYPTION', 'ssl'),
      folder: str('IMAP_FOLDER', 'INBOX'),
    },
    suggest: bool('LLM_REPLY_SUGGEST', false),
    softBounceThreshold: int('SOFT_BOUNCE_THRESHOLD', 3),
  },

  mail: {
    mailer: str('MAIL_MAILER', 'log'), // 'log' keeps dev safe — nothing sends
    host: str('MAIL_HOST', '127.0.0.1'),
    port: int('MAIL_PORT', 2525),
    username: str('MAIL_USERNAME') || null,
    password: str('MAIL_PASSWORD') || null,
    encryption: str('MAIL_ENCRYPTION') || null,
  },

  sessionSecret: str('SESSION_SECRET', ''),
};

/** Asia/Manila "now" — the app's business timezone (UTC+8, no DST). */
export function manilaNow(): Date {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

/** Laravel-style UTC timestamp 'YYYY-MM-DD HH:MM:SS'. */
export function ts(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function todayManila(): string {
  return manilaNow().toISOString().slice(0, 10);
}
