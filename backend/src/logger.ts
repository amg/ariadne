import { env } from '@config/env';
/**
 * The app-wide pino singleton — the one place the logger is built.
 *
 * Dev console (non-prod + TTY) renders via pino-pretty in one scannable
 * palette; captured logs (Docker / CI / no TTY) stay plain JSON.
 *
 * Color scheme (computed inside pino-pretty's `messageFormat`, so it degrades
 * to plain text automatically when `colorize` is off):
 *
 *   Request line — one per request (server.ts onResponse hook):
 *     POST /api/threads/.../generate-title → 502 5666ms
 *       method+URL   bright cyan
 *       → 2xx green · 3xx blue · 4xx yellow · 5xx bright red
 *       latency      dim gray
 *
 *   Provider exchange — DEBUG=true only, the payloads of external calls:
 *     ▼ generate-title 1/3 request     yellow  = input sent
 *     ▲ generate-title 1/3 response    green   = output received
 *     ✖ generate-title 1/3 error       red     = failure detail
 *
 * Everything else (warns, errors, startup lines) passes through
 * pino-pretty's defaults (level-colored label, cyan message).
 *
 * Verbose mode: `DEBUG=true` in `.env` drops the level to `debug`
 * (titling's sent prompt + returned text get logged as the exchange
 * above). Strictly non-prod — production ignores the flag, payloads never
 * land in deployed logs.
 *
 * Rendering conventions: pretty output needs a TTY (auto-detected) or an
 * explicit `FORCE_COLOR` (0 disables; anything else forces pretty even
 * through pipes — e.g. `concurrently` on Windows PowerShell, which is why
 * the dev scripts set it). `NO_COLOR` strips the ANSI colors while keeping
 * the pretty layout. Production always logs plain JSON.
 */
import pino from 'pino';
import type { PrettyOptions } from 'pino-pretty';
import pinoPretty from 'pino-pretty';

export const isProduction = env.NODE_ENV === 'production';

const TRUTHY = /^(1|true|yes|on)$/i;
const debugRequested = TRUTHY.test(env.DEBUG ? 'true' : 'false');

/** Verbose provider-payload logging: honored outside production only. */
export const debugEnabled = !isProduction && debugRequested;

// Standard color conventions (also read by colorette itself): npm's dev
// scripts set FORCE_COLOR=1 so the pretty stream survives concurrently's
// child-stdout pipe on Windows; NO_COLOR keeps the layout but strips ANSI.
const forceColor = env.FORCE_COLOR;
const colorDisabled = forceColor === '0' || env.NO_COLOR !== undefined;
const prettyRequested = process.stdout.isTTY || (forceColor !== undefined && forceColor !== '0');

/** Shapes consumed by `messageFormat`; suppresses the default key:value dump. */
const PRETTY_IGNORED_KEYS = 'pid,hostname,req,res,responseTime,exchange';

/** The color helpers we use from pino-pretty's colorette passthrough. */
type Colorette = Record<
  'cyanBright' | 'greenBright' | 'redBright' | 'yellow' | 'blue' | 'green' | 'gray' | 'bold',
  (input: string) => string
>;

/** Derived because pino-pretty declares `MessageFormatFunc` in a namespace
 *  without a named export. */
type MessageFormatter = Extract<
  NonNullable<PrettyOptions['messageFormat']>,
  (...args: never[]) => string
>;

type Exchange = {
  label?: unknown;
  request?: unknown;
  response?: unknown;
  error?: unknown;
};

function statusTone(code: number, colors: Colorette): (input: string) => string {
  if (code >= 500) return colors.redBright;
  if (code >= 400) return colors.yellow;
  if (code >= 300) return colors.blue;
  if (code >= 200) return colors.green;
  return colors.gray;
}

/** `POST /api/... → 502 5666ms` — colored by status class, dim latency. */
function formatRequestLine(
  req: { method?: string; url?: string },
  res: { statusCode?: number },
  latencyMs: unknown,
  colors: Colorette,
): string {
  const parts: string[] = [];
  if (req.method && req.url) {
    parts.push(colors.bold(colors.cyanBright(`${req.method} ${req.url}`)));
  }
  if (res.statusCode !== undefined) {
    parts.push(statusTone(res.statusCode, colors)(`→ ${res.statusCode}`));
  }
  if (typeof latencyMs === 'number') {
    parts.push(colors.gray(`${Math.round(latencyMs)}ms`));
  }
  return parts.join(' ');
}

/** Multi-line payload body: objects pretty-printed, strings indented as-is. */
function renderBody(value: unknown): string {
  const text =
    typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/** One colored block: bold label line + tinted body. */
function paintBlock(
  label: string,
  body: unknown,
  tone: (input: string) => string,
  colors: Colorette,
): string {
  const bodyLines = renderBody(body)
    .split('\n')
    .map((line) => tone(line))
    .join('\n');
  return `${colors.bold(tone(label))}\n${bodyLines}`;
}

/** ▼/▲/✖ blocks — input yellow, output green, error red. */
function formatExchange(exchange: Exchange, colors: Colorette): string {
  const label = typeof exchange.label === 'string' ? exchange.label : 'provider';
  const blocks: string[] = [];
  if (exchange.request !== undefined) {
    blocks.push(paintBlock(`▼ ${label} request`, exchange.request, colors.yellow, colors));
  }
  if (exchange.response !== undefined) {
    blocks.push(paintBlock(`▲ ${label} response`, exchange.response, colors.greenBright, colors));
  }
  if (exchange.error !== undefined) {
    blocks.push(paintBlock(`✖ ${label} error`, exchange.error, colors.redBright, colors));
  }
  return blocks.join('\n');
}

function isRequestLog(log: Record<string, unknown>): boolean {
  const req = log.req as { method?: string } | undefined;
  const res = log.res as { statusCode?: number } | undefined;
  return typeof req?.method === 'string' && typeof res?.statusCode === 'number';
}

const messageFormat: MessageFormatter = (log, messageKey, _levelLabel, { colors }) => {
  if (isRequestLog(log)) {
    const req = log.req as { method?: string; url?: string };
    const res = log.res as { statusCode?: number };
    return formatRequestLine(req, res, log.responseTime, colors);
  }
  const exchange = log.exchange as Exchange | undefined;
  if (exchange && typeof exchange === 'object') {
    return formatExchange(exchange, colors);
  }
  const message = log[messageKey];
  return typeof message === 'string' ? message : '';
};

function prettyOptions(): PrettyOptions {
  return {
    colorize: true,
    sync: true, // keep line order under tsx watch / concurrently
    translateTime: 'SYS:HH:MM:ss.l',
    ignore: PRETTY_IGNORED_KEYS,
    singleLine: true,
    messageFormat,
  };
}

function createLogger(): pino.Logger {
  const options: pino.LoggerOptions = { level: debugEnabled ? 'debug' : 'info' };
  if (isProduction || !prettyRequested) return pino(options);
  return pino(options, pinoPretty({ ...prettyOptions(), colorize: !colorDisabled }));
}

export const logger = createLogger();

if (isProduction && debugRequested) {
  logger.info('DEBUG was requested but is ignored in production');
}

/** Renders an error as a compact one-line detail for exchange/log fields. */
export function errorReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error ?? 'unknown');
}

/** Payload sent to a provider (DEBUG-only; noop otherwise via level filter). */
export function logExchangeRequest(label: string, request: unknown): void {
  logger.debug({ exchange: { label, request } }, 'provider request');
}

/** Payload returned by a provider (DEBUG-only). */
export function logExchangeResponse(label: string, response: unknown): void {
  logger.debug({ exchange: { label, response } }, 'provider response');
}

/** Provider-call failure detail (DEBUG-only; the summary still gets a warn). */
export function logExchangeError(label: string, error: unknown): void {
  logger.debug({ exchange: { label, error: errorReason(error) } }, 'provider error');
}
