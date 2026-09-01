import { XMLParser } from 'fast-xml-parser';
import iconv from 'iconv-lite';
import { config } from './config.js';
import { encryptData } from './seed128.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  parseTagValue: false, // 등기번호, 우편번호, HS codes must stay strings
  parseAttributeValue: false,
});

export class EpostError extends Error {
  constructor(message, { code = null, status = 502, raw = null, hint = null } = {}) {
    super(message);
    this.name = 'EpostError';
    this.code = code;
    this.status = status;
    this.raw = raw;
    this.hint = hint;
  }
}

/** Some epost endpoints still emit CP949 despite declaring UTF-8. Sniff and fix. */
function decodeBody(buffer, contentType = '') {
  const declared = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  const asUtf8 = buffer.toString('utf8');
  const declaredKorean =
    declared && ['euc-kr', 'ks_c_5601-1987', 'cp949', 'ksc5601'].includes(declared);
  if (asUtf8.includes('\uFFFD') || declaredKorean) return iconv.decode(buffer, 'cp949');
  return asUtf8;
}

/** Collect every node with the given tag, always as an array. */
export function collectNodes(node, tagName, out = []) {
  if (node === null || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === tagName) {
      if (Array.isArray(value)) out.push(...value);
      else out.push(value);
    }
    if (Array.isArray(value)) value.forEach((v) => collectNodes(v, tagName, out));
    else if (typeof value === 'object') collectNodes(value, tagName, out);
  }
  return out;
}

/** First scalar value for a tag, anywhere in the tree. */
export function findScalar(node, tagName) {
  if (node === null || typeof node !== 'object') return undefined;
  for (const [key, value] of Object.entries(node)) {
    if (key === tagName && (typeof value === 'string' || typeof value === 'number')) {
      return String(value);
    }
    const nested = Array.isArray(value)
      ? value.map((v) => findScalar(v, tagName)).find((v) => v !== undefined)
      : typeof value === 'object'
        ? findScalar(value, tagName)
        : undefined;
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * Build the regData plaintext. Order matters only for readability — the server
 * parses it as a query string — but empty values are dropped so we never send
 * `foo=` for an optional field we didn't set.
 *
 * NOTE: values are NOT url-encoded here. They go into the SEED plaintext as-is,
 * and the ciphertext is hex, so the final URL is always safe. Encoding the
 * plaintext would make the server read literal %XX sequences as the value.
 */
export function buildRegData(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * epost signals failure with <error><error_code>ERR-xxx</error_code><message>…
 * rather than an HTTP status, so a 200 tells us nothing on its own.
 */
function assertNoApiError(parsed, raw) {
  const code = findScalar(parsed, 'error_code');
  if (!code) return;
  const message = findScalar(parsed, 'message') ?? 'unknown error';

  // ERR-125 is "no rows matched", a legitimate empty result for query APIs.
  if (code === 'ERR-125') return;

  let hint = null;
  if (/보안키/.test(message)) {
    hint =
      'The 보안키 expires after 30 days without use. Regenerate it at 고객센터 > 오픈API 신청결과 > EMS/K-Packet 보안키 생성, then update EPOST_EMS_SECRET.';
  }
  throw new EpostError(`${code}: ${message}`, { code, hint, raw: raw.slice(0, 600) });
}

async function call(messageName, params, { timeoutMs = 20000, method = 'GET' } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }

  const base = `${config.baseUrl}/${messageName}`;
  const url = method === 'GET' ? `${base}?${qs.toString()}` : base;
  const host = new URL(config.baseUrl).host;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        ...config.headers,
        Host: host,
        ...(method === 'POST'
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      ...(method === 'POST' ? { body: qs.toString() } : {}),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new EpostError(`epost timed out after ${timeoutMs}ms`, { status: 504 });
    }
    throw new EpostError(`epost request failed: ${err.message}`, { status: 502 });
  }
  clearTimeout(timer);

  const text = decodeBody(
    Buffer.from(await res.arrayBuffer()),
    res.headers.get('content-type') || '',
  );

  if (!res.ok) {
    throw new EpostError(`epost returned HTTP ${res.status}`, {
      status: 502,
      raw: text.slice(0, 600),
    });
  }
  if (!text.trimStart().startsWith('<')) {
    throw new EpostError('epost returned a non-XML body (check 인증키 and headers)', {
      status: 502,
      raw: text.slice(0, 600),
    });
  }

  const parsed = parser.parse(text);
  assertNoApiError(parsed, text);
  if (config.logBodies) console.error('[epost raw]', text.slice(0, 2000));
  return parsed;
}

/** 조회 API: plaintext params, authenticated with `regkey`. */
export function callQuery(messageName, params = {}, opts = {}) {
  return call(messageName, { regkey: config.ems.regKey, ...params }, opts);
}

/**
 * 신청 API: all business fields are SEED-encrypted into a single `regData`
 * parameter.
 *
 * TWO DEVIATIONS FROM THE MANUAL, both established against the live service:
 *
 * 1. The manual says the auth parameter is `key` for 신청 APIs and `regkey` for
 *    조회. It is `regkey` for both — sending `key` returns
 *    "ERR-111: 필수값이 입력되지 않았습니다. 인증키(regkey)을(를) 입력하여 주세요."
 *
 * 2. The manual lists REST(GET, POST). POST returns an HTML login page rather
 *    than XML, so only GET works.
 *
 * Do not "correct" either of these back to the manual without re-testing —
 * both failures are silent-ish and hard to diagnose from the response.
 *
 * The URL length is a real concern (hex doubles the byte count of an already
 * long 접수신청 plaintext), so oversized requests are caught below rather than
 * being truncated by the server.
 */
export function callSecure(messageName, fields, extraParams = {}, opts = {}) {
  const plain = buildRegData(fields);
  const regData = encryptData(config.ems.secretKey, plain);

  // Typical server/proxy limit is 8KB for the whole request line.
  if (regData.length > 7000) {
    throw new EpostError(
      `regData is ${regData.length} hex chars — too long for a GET request. ` +
        'Reduce the number of customs line items or shorten address fields.',
      { status: 400 },
    );
  }

  return call(
    messageName,
    { regkey: config.ems.regKey, regData, ...extraParams },
    { method: 'GET', ...opts },
  );
}
