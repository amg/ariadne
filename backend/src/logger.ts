import type { RequestRecord } from '@ari/lib/api/schemas/appRecords/records';
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
 *   Request line — one per request, from its request record:
 *     POST /api/threads/:threadId/generate-title → 502 5666ms
 *       method+route bright cyan
 *       → 2xx green · 3xx blue · 4xx yellow · 5xx bright red
 *       latency      dim gray
 *
 *   Provider call — DEBUG=true only, the payloads of external calls:
 *     ▼ generate-title 1/3 request     yellow  = input sent
 *     ▲ generate-title 1/3 response    green   = output received
 *     ✖ generate-title 1/3 error       red     = failure detail
 *
 * Everything else (warns, errors, startup lines) passes through
 * pino-pretty's defaults (level-colored label, cyan message).
 *
 * Verbose mode: `DEBUG=true` in `.env` drops the level to `debug`
 * (titling's sent prompt + returned text get logged as the provider call
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

const isProduction = env.NODE_ENV === 'production';

const TRUTHY = /^(1|true|yes|on)$/i;
const debugRequested = TRUTHY.test(env.DEBUG ? 'true' : 'false');

/** Verbose provider-payload logging: honored outside production only. */
const debugEnabled = !isProduction && debugRequested;

// Standard color conventions (also read by colorette itself): npm's dev
// scripts set FORCE_COLOR=1 so the pretty stream survives concurrently's
// child-stdout pipe on Windows; NO_COLOR keeps the layout but strips ANSI.
const forceColor = env.FORCE_COLOR;
const colorDisabled = forceColor === '0' || env.NO_COLOR !== undefined;
const prettyRequested = process.stdout.isTTY || (forceColor !== undefined && forceColor !== '0');

/** Shapes consumed by `messageFormat`; suppresses the default key:value dump. */
const PRETTY_IGNORED_KEYS = 'pid,hostname,providerCall';

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

type ProviderCall = {
  label?: unknown;
  request?: unknown;
  response?: unknown;
  error?: unknown;
};

function statusTone(code: number, colors: Colorette) {
  if (code >= 500) return colors.redBright;
  if (code >= 400) return colors.yellow;
  if (code >= 300) return colors.blue;
  if (code >= 200) return colors.green;
  return colors.gray;
}

/** `POST /api/... → 502 5666ms` — colored by status class, dim latency. */
function formatRequestRecord(request: RequestRecord, colors: Colorette) {
  const route = request.route ?? 'no route';
  return [
    colors.bold(colors.cyanBright(`${request.method} ${route}`)),
    statusTone(request.statusCode, colors)(`→ ${request.statusCode}`),
    colors.gray(`${Math.round(request.durationMs)}ms`),
  ].join(' ');
}

/** Multi-line payload body: objects pretty-printed, strings indented as-is. */
function renderBody(value: unknown) {
  const text =
    typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/** One colored block: bold label line + tinted body. */
function paintBlock({
  label,
  body,
  tone,
  colors,
}: {
  label: string;
  body: unknown;
  tone: (input: string) => string;
  colors: Colorette;
}) {
  const bodyLines = renderBody(body)
    .split('\n')
    .map((line) => tone(line))
    .join('\n');
  return `${colors.bold(tone(label))}\n${bodyLines}`;
}

/** ▼/▲/✖ blocks — input yellow, output green, error red. */
function formatProviderCall(call: ProviderCall, colors: Colorette) {
  const label = typeof call.label === 'string' ? call.label : 'provider';
  const blocks: string[] = [];
  if (call.request !== undefined) {
    blocks.push(
      paintBlock({ label: `▼ ${label} request`, body: call.request, tone: colors.yellow, colors }),
    );
  }
  if (call.response !== undefined) {
    blocks.push(
      paintBlock({
        label: `▲ ${label} response`,
        body: call.response,
        tone: colors.greenBright,
        colors,
      }),
    );
  }
  if (call.error !== undefined) {
    blocks.push(
      paintBlock({ label: `✖ ${label} error`, body: call.error, tone: colors.redBright, colors }),
    );
  }
  return blocks.join('\n');
}

/** Whether a logged `appRecord` is the record of a request. */
function isRequestRecord(value: unknown): value is RequestRecord {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'request';
}

// biome-ignore lint/complexity/useMaxParams: pino-pretty's messageFormat fixes this signature
const messageFormat: MessageFormatter = (log, messageKey, _levelLabel, { colors }) => {
  if (isRequestRecord(log.appRecord)) return formatRequestRecord(log.appRecord, colors);
  const call = log.providerCall as ProviderCall | undefined;
  if (call && typeof call === 'object') {
    return formatProviderCall(call, colors);
  }
  const message = log[messageKey];
  return typeof message === 'string' ? message : '';
};

// pino-pretty drops a field whose prettifier answers undefined and keeps any other answer as
// it is, though its type allows only text, so the function is cast to that type.
/** Shows every field of a record as it is, except a request record, which has none to show. */
const fieldsShownOfAppRecord = ((record: unknown) =>
  isRequestRecord(record) ? undefined : record) as unknown as NonNullable<
  PrettyOptions['customPrettifiers']
>[string];

function prettyOptions(): PrettyOptions {
  return {
    colorize: true,
    sync: true, // keep line order under tsx watch / concurrently
    translateTime: 'SYS:HH:MM:ss.l',
    ignore: PRETTY_IGNORED_KEYS,
    singleLine: true,
    messageFormat,
    // A request record is shown by its line alone; the other records show their fields.
    customPrettifiers: { appRecord: fieldsShownOfAppRecord },
  };
}

function createLogger() {
  const options: pino.LoggerOptions = { level: debugEnabled ? 'debug' : 'info' };
  if (isProduction || !prettyRequested) return pino(options);
  return pino(options, pinoPretty({ ...prettyOptions(), colorize: !colorDisabled }));
}

export const logger = createLogger();

if (isProduction && debugRequested) {
  logger.info('DEBUG was requested but is ignored in production');
}

/** Renders an error as a compact one-line detail for provider-call and log fields. */
export function errorReason(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error ?? 'unknown');
}

/** Payload sent to a provider (DEBUG-only; noop otherwise via level filter). */
export function logProviderRequest({ label, request }: { label: string; request: unknown }) {
  logger.debug({ providerCall: { label, request } }, 'provider request');
}

/** Payload returned by a provider (DEBUG-only). */
export function logProviderResponse({ label, response }: { label: string; response: unknown }) {
  logger.debug({ providerCall: { label, response } }, 'provider response');
}

/** Provider-call failure detail (DEBUG-only; the summary still gets a warn). */
export function logProviderError({ label, error }: { label: string; error: unknown }) {
  logger.debug({ providerCall: { label, error: errorReason(error) } }, 'provider error');
}
