/**
 * 행방조회 lives on a different service (openapi.epost.go.kr) with its own key —
 * it is not part of the 계약고객 EMS/K-Packet manual, and its request parameter
 * name is undocumented. See scripts/probe-trace.js.
 */
import { XMLParser } from 'fast-xml-parser';
import iconv from 'iconv-lite';
import { config } from './config.js';
import { EpostError, collectNodes, findScalar } from './eship.js';
import { cached } from './cache.js';

const parser = new XMLParser({ trimValues: true, parseTagValue: false });
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

export async function traceShipment(trackingNumber) {
  const num = upperClean(trackingNumber);

  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(num)) {
    throw new EpostError('Tracking number must be UPU S10 format, e.g. UP123456789KR', {
      status: 400,
    });
  }
  if (!config.trace.key) {
    throw new EpostError('EPOST_TRACE_KEY is not configured', { status: 503 });
  }
  if (!config.trace.param) {
    throw new EpostError(
      'EPOST_TRACE_PARAM is not configured — run `npm run probe:trace` to discover it',
      { status: 503 },
    );
  }

  return cached(`trace:${num}`, config.ttl.trace, async () => {
    const qs = new URLSearchParams({
      serviceKey: config.trace.key,
      [config.trace.param]: num,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(`${config.trace.url}?${qs}`, {
        signal: controller.signal,
        headers: config.headers,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new EpostError(`trace request failed: ${err.message}`, { status: 502 });
    }
    clearTimeout(timer);

    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.toString('utf8');
    if (text.includes('\uFFFD')) text = iconv.decode(buf, 'cp949');

    if (!text.trimStart().startsWith('<')) {
      throw new EpostError('trace service returned a non-XML body', {
        status: 502,
        raw: text.slice(0, 400),
      });
    }

    const parsed = parser.parse(text);
    const code = findScalar(parsed, 'errorCode') ?? findScalar(parsed, 'resultCode');
    if (code && !['00', '0', '03'].includes(code)) {
      throw new EpostError(`trace error ${code}`, { code, status: 502 });
    }

    const rows = [
      ...collectNodes(parsed, 'EMSTraceList'),
      ...collectNodes(parsed, 'TraceList'),
      ...collectNodes(parsed, 'DetailList'),
      ...collectNodes(parsed, 'detail'),
    ];

    const events = rows
      .map((r) => ({
        date: str(r.dlvyDate ?? r.procesDe ?? r.date),
        time: str(r.dlvyTime ?? r.procesTm ?? r.time),
        status: str(r.processSttus ?? r.dlvySttus ?? r.status),
        location: str(r.nowLc ?? r.procesPlace ?? r.location),
        detail: str(r.detailDc ?? r.dc ?? r.detail),
      }))
      .filter((e) => e.date || e.status);

    return {
      trackingNumber: num,
      found: events.length > 0,
      currentStatus: events.at(-1)?.status ?? null,
      events,
    };
  });
}

function upperClean(v) {
  return str(v).toUpperCase().replace(/\s+/g, '');
}
