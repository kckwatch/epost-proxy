/**
 * The public guide zip documents the EMS 신청 service but NOT the request
 * parameter name for 행방조회. Rather than guessing in production, brute-force
 * the handful of plausible names once against a real tracking number and pin
 * whichever one returns actual events.
 *
 *   node scripts/probe-trace.js UP123456789KR
 *
 * Use a number you shipped in the last few weeks — a delivered-and-archived
 * parcel can legitimately return "no data" and make a correct param look wrong.
 *
 * Costs one API call per candidate (currently 10). The dev account allows
 * 10,000/day, so this is cheap. Run it once, write the result into .env, done.
 */
import { config } from '../src/config.js';

const CANDIDATES = [
  'rgist',
  'POST_CODE',
  'sid1',
  'rgistNo',
  'regNo',
  'emsNo',
  'trace_no',
  'traceNo',
  'ems_gubun',
  'sid',
];

const number = (process.argv[2] || '').trim().toUpperCase();

if (!config.trace.key) {
  console.error('EPOST_TRACE_KEY is not set in .env — nothing to probe with.');
  process.exit(1);
}

if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(number)) {
  console.error('Usage: node scripts/probe-trace.js <trackingNumber>');
  console.error('Example: node scripts/probe-trace.js UP123456789KR');
  process.exit(1);
}

/** Heuristic: does this body actually describe a parcel, or is it an empty shell? */
function scoreBody(text) {
  const signals = [
    /배달완료|발송|도착|접수|통관|Delivered|Dispatch|Arrival/i,
    /<(EMSTraceList|TraceList|DetailList|detail)\b/i,
    /\d{4}[-.]\d{2}[-.]\d{2}/,
  ];
  let score = signals.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  if (/errorCode>\s*0?3\s*</.test(text)) score -= 1; // explicit "No Data"
  if (/errorCode>\s*(01|02|04|99)\s*</.test(text)) score -= 2;
  return score;
}

const results = [];

for (const param of CANDIDATES) {
  const qs = new URLSearchParams();
  qs.set('serviceKey', config.trace.key);
  qs.set(param, number);
  const url = `${config.trace.url}?${qs.toString()}`;

  process.stdout.write(`  ${param.padEnd(12)} `);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);

    const text = await res.text();
    const score = scoreBody(text);
    const errorCode = /errorCode>\s*(\w+)\s*</.exec(text)?.[1] ?? '-';

    results.push({ param, status: res.status, errorCode, score, len: text.length });
    console.log(
      `HTTP ${res.status}  errorCode=${errorCode}  score=${score}  ${text.length}B`,
    );

    if (score >= 2) {
      console.log('\n--- looks like a hit, first 800 chars ---');
      console.log(text.slice(0, 800));
      console.log('--- end ---\n');
    }
  } catch (err) {
    results.push({ param, status: 'ERR', errorCode: '-', score: -99, len: 0 });
    console.log(`failed: ${err.message}`);
  }
}

results.sort((a, b) => b.score - a.score);
const winner = results[0];

console.log('\nRanked:');
for (const r of results) {
  console.log(`  ${String(r.score).padStart(3)}  ${r.param}  (${r.status}, ${r.len}B)`);
}

if (winner && winner.score >= 2) {
  console.log(`\nSet this in .env:\n\n  EPOST_TRACE_PARAM=${winner.param}\n`);
} else {
  console.log(
    '\nNo candidate returned parcel data.\n' +
      'Either the tracking number is too old, the trace key is not yet active,\n' +
      'or the param is something else entirely. Paste the highest-scoring raw\n' +
      'response above and we can widen the candidate list.\n',
  );
}
