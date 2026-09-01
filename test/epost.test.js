/**
 * Run with: npm test
 *
 * The SEED vectors below were produced by executing the vendor's own
 * SEED128.java (shipped in SeedSampleCode.zip). They are the contract: if this
 * file goes red, the post office will not be able to decrypt our regData, and
 * every 접수신청 will fail with an opaque error. Do not "fix" a failure by
 * editing the expected values.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

process.env.EPOST_EMS_KEY ??= 'testkey';
process.env.EPOST_EMS_SECRET ??= '0123456789abcdef';
process.env.EPOST_CUST_NO ??= '0011223344';
process.env.EPOST_APPR_NO ??= '10186H0000';
process.env.PROXY_SHARED_SECRET ??= 'testsecret';

const { encryptData, decryptData, seedRoundKey, seedEncryptBlock } = await import(
  '../src/seed128.js'
);
const { buildRegData } = await import('../src/eship.js');
const { validateShipment } = await import('../src/shipment.js');

/* ------------------------------------------------------------------ *
 * SEED-128
 * ------------------------------------------------------------------ */

const VECTORS = [
  [
    '291a02e28846d7f6',
    'custNo=0001234567&reqType=1&countrycd=US',
    '46a9508006f4595809917b6cf6a89e34c96ffb687d0a38f46fb86fe35d8debee36dc0633a1a17957fd87c06ed860084b',
  ],
  ['0123456789abcdef', 'hello', '923befed1f7c1909fbb416870f4eb19c'],
  [
    '0123456789abcdef',
    '0123456789abcdef0123456789abcdef',
    '3bd75cb54b6765efc3d934c94238f6043bd75cb54b6765efc3d934c94238f604',
  ],
  ['0123456789abcdef', '', '1a9ac8191c4f444824871ea79bce58ea'],
  [
    '0123456789abcdef',
    'custno=0011223344&apprno=10186H0000&premiumcd=32&em_ee=em&countrycd=US&totweight=3000',
    'b879ff951ea43d3c20240c57e070c89dc9cbbba00dce5061b89675eeb12f9416e9d92fdce3c96ae1306cabbe4774b77dbfeaab3526fdb2a97708c7856275e2ce35ef3ed765cb34cf31b4b5030d2a591487134c4dbc055fc0a758b192aadf84ea',
  ],
];

test('SEED-128 matches the vendor Java implementation', () => {
  for (const [key, plain, expected] of VECTORS) {
    assert.equal(encryptData(key, plain), expected, `encrypt("${plain}")`);
  }
});

test('SEED-128 decrypt round-trips', () => {
  for (const [key, plain] of VECTORS) {
    assert.equal(decryptData(key, encryptData(key, plain)), plain);
  }
});

test('SEED-128 reproduces the vendor block vector, NOT the RFC 4269 one', () => {
  const k = Uint8Array.from({ length: 16 }, (_, i) => i);
  const p = Uint8Array.from({ length: 16 }, (_, i) => i);
  const ct = Buffer.from(seedEncryptBlock(p, seedRoundKey(k))).toString('hex');

  assert.equal(ct, 'a6e8d7325bbe0998cf235c1b57e64360');
  assert.notEqual(
    ct,
    '5ebac6e0054e166819aff1cc6d346cdb',
    'If this ever equals the RFC vector, someone swapped in a standards-compliant SEED library and epost will reject our ciphertext.',
  );
});

test('SEED-128 rejects a key that is not 16 bytes', () => {
  assert.throws(() => encryptData('tooshort', 'x'), /16 bytes/);
});

test('ECB: identical plaintext blocks produce identical ciphertext blocks', () => {
  // Documenting the weakness rather than hiding it — this is epost's choice.
  const ct = encryptData('0123456789abcdef', '0123456789abcdef0123456789abcdef');
  assert.equal(ct.slice(0, 32), ct.slice(32, 64));
});

/* ------------------------------------------------------------------ *
 * regData construction
 * ------------------------------------------------------------------ */

test('buildRegData drops empty and undefined fields', () => {
  const out = buildRegData({ a: '1', b: '', c: undefined, d: null, e: 0 });
  assert.equal(out, 'a=1&e=0');
});

test('buildRegData does not url-encode the plaintext', () => {
  // Encoding here would make the server read literal %20 as part of the value.
  assert.equal(buildRegData({ sender: 'Changkyu Kwon' }), 'sender=Changkyu Kwon');
});

/* ------------------------------------------------------------------ *
 * Shipment validation
 * ------------------------------------------------------------------ */

const base = {
  premiumcd: '32',
  em_ee: 'em',
  countrycd: 'US',
  totweight: 1200,
  boyn: 'N',
  boxlength: 30,
  boxwidth: 20,
  boxheight: 15,
  sender: 'Changkyu Kwon',
  senderzipcode: '10364',
  senderaddr1: '34 Kkotmaeul-ro, Star Palace 2F',
  senderaddr2: 'Goyang-si',
  senderaddr3: 'Gyeonggi-do',
  receivename: 'James Lee',
  receivezipcode: '07803',
  receiveaddr1: 'New Jersey',
  receiveaddr2: 'Mine Hill',
  receiveaddr3: '12 Main St',
  receivetelno: '1-201-555-0123',
  currunitcd: 'USD',
  items: [
    { name: 'Wristwatch', qty: 1, weight: 150, value: 2400, hsCode: '9102210000', origin: 'CH' },
  ],
};

const doc = {
  ...base,
  em_ee: 'ee',
  totweight: 300,
  boxlength: undefined,
  boxwidth: undefined,
  boxheight: undefined,
  items: [{ name: 'Documents', qty: 1, weight: 100, value: 0, hsCode: '4901990000', origin: 'KR' }],
};

const check = (patch, over = base) => validateShipment({ ...over, ...patch });
const failsOn = (result, field) => result.errors.some((e) => e.field === field);

test('a well-formed EMS Premium shipment to the US validates', () => {
  assert.equal(check({}).valid, true);
});

test('EMS Premium 서류 is capped at 500g since 2026-03-26', () => {
  assert.equal(check({}, doc).valid, true);
  assert.ok(failsOn(check({ totweight: 900 }, doc), 'totweight'));
});

test('EMS Premium 서류 cannot be insured since 2026-03-26', () => {
  assert.ok(failsOn(check({ boyn: 'Y', boprc: 100000 }, doc), 'boyn'));
});

test('box dimensions are mandatory for 비서류', () => {
  const r = check({ boxlength: undefined, boxwidth: undefined, boxheight: undefined });
  assert.ok(failsOn(r, 'boxlength'));
  // ...unless volumetric weight is explicitly waived
  assert.equal(
    check({
      boxlength: undefined,
      boxwidth: undefined,
      boxheight: undefined,
      volmwghtapplyexceptyn: 'Y',
    }).valid,
    true,
  );
});

test('EUR is rejected outside the EU', () => {
  assert.ok(failsOn(check({ currunitcd: 'EUR' }), 'currunitcd'));
  assert.equal(check({ countrycd: 'DE', currunitcd: 'EUR' }).valid, true);
});

test('Mexico requires a tax id for EMS Premium 비서류', () => {
  assert.ok(failsOn(check({ countrycd: 'MX' }), 'vatdscrnno'));
  assert.equal(check({ countrycd: 'MX', vatdscrnno: 'ABC123456' }).valid, true);
});

test('Brazil and Indonesia require cdremark', () => {
  assert.ok(failsOn(check({ countrycd: 'BR' }), 'cdremark'));
  assert.ok(failsOn(check({ countrycd: 'ID' }), 'cdremark'));
});

test('characters epost rejects are caught locally', () => {
  assert.ok(failsOn(check({ sender: "O'Brien Kwon" }), 'sender'));
  assert.ok(failsOn(check({ receivename: 'A|B' }), 'receivename'));
});

test('semicolons in item fields are rejected — they are the wire separator', () => {
  const r = check({
    items: [{ name: 'Watch; strap', qty: 1, weight: 150, value: 2400, hsCode: '9102210000', origin: 'CH' }],
  });
  assert.ok(failsOn(r, 'items[0].name'));
});

test('document mail requires an HS code starting with 49', () => {
  assert.ok(
    failsOn(
      check({ items: [{ name: 'Docs', qty: 1, weight: 100, value: 0, hsCode: '9102210000', origin: 'KR' }] }, doc),
      'items[0].hsCode',
    ),
  );
});

test('EMS Premium requires a recipient phone number since 2026-04-16', () => {
  assert.ok(failsOn(check({ receivetelno: undefined }), 'receivetelno'));
});

test('exceeding the label print limit warns without blocking', () => {
  const r = check({
    items: Array.from({ length: 5 }, (_, i) => ({
      name: `Item${i}`, qty: 1, weight: 100, value: 100, hsCode: '9102210000', origin: 'CH',
    })),
  });
  assert.equal(r.valid, true);
  assert.ok(r.issues.some((i) => i.severity === 'warning' && /기표지/.test(i.message)));
});

test('at least one customs item is always required', () => {
  assert.ok(failsOn(check({ items: [] }), 'items'));
});

test('an unknown premiumcd is rejected with the valid options', () => {
  assert.ok(failsOn(check({ premiumcd: '99' }), 'premiumcd'));
});

/* ------------------------------------------------------------------ *
 * Live-service behaviour learned from probe:api
 * ------------------------------------------------------------------ */

const { readInsurance } = await import('../src/queries.js');

test('insurability is read from insutreatcd, because insuyn arrives empty', () => {
  // The live service returns <insuyn></insuyn> for every country on both
  // premiumcd 31 and 32, while populating insutreatcd. Reading insuyn alone
  // would mark all 184 destinations uninsurable.
  assert.equal(readInsurance({ insuyn: '', insutreatcd: '1' }).insurable, true);
  assert.equal(readInsurance({ insuyn: '', insutreatcd: '2' }).insurable, true);
  assert.equal(readInsurance({ insuyn: '', insutreatcd: '0' }).insurable, false);
});

test('region-limited cover is flagged rather than treated as blanket cover', () => {
  const r = readInsurance({ insuyn: '', insutreatcd: '2' });
  assert.equal(r.insurable, true);
  assert.equal(r.insuranceRegionLimited, true);
  assert.match(r.insuranceNote, /적용지역/);
});

test('an explicit insuyn still wins if the service ever starts sending one', () => {
  assert.equal(readInsurance({ insuyn: 'N', insutreatcd: '1' }).insurable, false);
  assert.equal(readInsurance({ insuyn: 'Y', insutreatcd: '0' }).insurable, true);
});

test('an unknown or missing treatment code fails closed', () => {
  assert.equal(readInsurance({ insuyn: '', insutreatcd: '' }).insurable, false);
  assert.equal(readInsurance({ insuyn: '', insutreatcd: '9' }).insurable, false);
  assert.match(readInsurance({ insuyn: '', insutreatcd: '9' }).insuranceNote, /알 수 없는/);
});

test('a country row with an empty insuyn is still insurable when insutreatcd=1', () => {
  // Guard against a regression to `upper(r.insuyn) === 'Y'`.
  const src = readFileSync(new URL('../src/queries.js', import.meta.url), 'utf8');
  assert.ok(
    !/insurable:\s*upper\(r\.insuyn\)\s*===\s*'Y'/.test(src),
    'insurability must not be derived from insuyn alone',
  );
  assert.ok(
    /INSURANCE_TREATMENT/.test(src),
    'the insutreatcd lookup table must be present',
  );
});

test('secure calls use regkey and GET, matching the live service', () => {
  const src = readFileSync(new URL('../src/eship.js', import.meta.url), 'utf8');
  assert.ok(
    /regkey: config\.ems\.regKey, regData/.test(src),
    'the manual says `key`, but the server demands `regkey`',
  );
  assert.ok(
    /\{ method: 'GET', \.\.\.opts \}/.test(src),
    'POST returns an HTML login page; only GET works',
  );
});

test('suspension lookup sends the mandatory nationcd', () => {
  const src = readFileSync(new URL('../src/queries.js', import.meta.url), 'utf8');
  assert.ok(
    /nationcd: country/.test(src),
    'the live service rejects a suspension query without nationcd',
  );
});
