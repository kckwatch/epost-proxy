/**
 * First thing to run against the live service.
 *
 * The manual embeds its "출력 XML" examples as screenshots, so the exact tag
 * nesting had to be inferred from the field tables. This script dumps the raw
 * response for each 조회 API so the parsers can be pinned to what the server
 * actually sends rather than what we guessed.
 *
 *   node scripts/probe-api.js
 *   node scripts/probe-api.js --raw     # print full bodies, not just a head
 *
 * Only read-only APIs are called. Nothing here creates a shipment.
 */
import { config } from '../src/config.js';
import { callQuery, callSecure, collectNodes } from '../src/eship.js';
import { readInsurance } from '../src/queries.js';

const FULL = process.argv.includes('--raw');
const head = (s) => (FULL ? s : s.slice(0, 900));

const PREMIUM = config.premiumCodes.EMS_PREMIUM;

/** Re-issue the call at the transport level so we can see the untouched body. */
async function raw(messageName, params) {
  const qs = new URLSearchParams({ regkey: config.ems.regKey, ...params });
  const url = `${config.baseUrl}/${messageName}?${qs}`;
  const res = await fetch(url, {
    headers: { ...config.headers, Host: new URL(config.baseUrl).host },
  });
  return { status: res.status, body: await res.text() };
}

async function step(label, fn) {
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    await fn();
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
    if (err.code) console.log(`  code: ${err.code}`);
    if (err.hint) console.log(`  hint: ${err.hint}`);
    if (err.raw) console.log(`  raw: ${head(err.raw)}`);
  }
}

console.log(`base URL : ${config.baseUrl}`);
console.log(`고객번호   : ${config.ems.custNo}`);
console.log(`승인번호   : ${config.ems.apprNo}`);
console.log(`mode     : ${config.live ? 'LIVE' : 'DEV'}`);

await step('1. 발송가능 국가 조회 (EMS프리미엄) — RAW', async () => {
  const { status, body } = await raw(config.messages.nationList, { premiumcd: PREMIUM });
  console.log(`HTTP ${status}, ${body.length} bytes`);
  console.log(head(body));
});

await step('2. 발송가능 국가 조회 — PARSED', async () => {
  const parsed = await callQuery(config.messages.nationList, { premiumcd: PREMIUM });

  // Try a few plausible wrappers and report which one the server actually uses.
  for (const tag of ['RetrieveNationList', 'NationList', 'itemlist', 'item']) {
    const n = collectNodes(parsed, tag).length;
    if (n) console.log(`  tag "${tag}": ${n} rows`);
  }
  const rows = collectNodes(parsed, 'RetrieveNationList');
  if (rows.length) {
    console.log('  first row keys:', Object.keys(rows[0]).join(', '));
    console.log('  first row:', JSON.stringify(rows[0]));
    for (const cc of ['US', 'JP', 'GB', 'DE', 'AU', 'SG', 'HK', 'CH']) {
      const hit = rows.find((r) => String(r.nationcd).toUpperCase() === cc);
      if (!hit) { console.log(`  ${cc}: NOT LISTED`); continue; }
      const ins = readInsurance(hit);
      console.log(
        `  ${cc}: zone ${hit.prcapplyareacd}, 보험 ${ins.insurable ? 'O' : 'X'} (${ins.insuranceNote})`,
      );
    }
  } else {
    console.log('  no rows under RetrieveNationList — check the raw dump above and fix queries.js');
  }
});

// nationcd is mandatory on the live service despite the manual marking it optional.
await step('3. 접수중지/배송지연 국가 (US) — RAW', async () => {
  const { status, body } = await raw(config.messages.stopOrDelayNations, {
    nationcd: 'US',
    premiumcd: PREMIUM,
  });
  console.log(`HTTP ${status}, ${body.length} bytes`);
  console.log(head(body));
});

await step('4. 배송 예상비용 조회 (프리미엄 비서류, 1.2kg → US) — RAW', async () => {
  const { status, body } = await raw(config.messages.rateQuote, {
    premiumcd: PREMIUM,
    em_ee: config.mailKinds.NON_DOCUMENT,
    countrycd: 'US',
    totweight: 1200,
    boyn: 'N',
    boprc: 0,
    boxlength: 30,
    boxwidth: 20,
    boxheight: 15,
    apprno: config.ems.apprNo,
  });
  console.log(`HTTP ${status}, ${body.length} bytes`);
  console.log(head(body));
});

await step('5. 계약승인번호 조회 (encrypted — proves the 보안키 works)', async () => {
  const parsed = await callSecure(config.messages.contractInfo, {
    custno: config.ems.custNo,
  });
  console.log(JSON.stringify(parsed, null, 2).slice(0, 1200));
});

console.log(`
Next:
  - If step 2 printed rows, queries.js is correct as written.
  - If it printed the fallback message, paste the raw dump from step 1 and the
    parser tag can be corrected in one edit.
  - Step 5 failing with a 보안키 message means the key expired (30 days unused);
    regenerate it at 고객센터 > 오픈API 신청결과 > EMS/K-Packet 보안키 생성.
`);
