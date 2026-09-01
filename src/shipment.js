import { config } from './config.js';
import { callSecure, collectNodes, findScalar, EpostError } from './eship.js';

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const upper = (v) => str(v).toUpperCase();

/**
 * Characters epost rejects outright in name/address fields (manual v2.2):
 * apostrophe, plus, colon, question mark, pipe.
 */
const BANNED = /['+:?|]/;
/** In `contents` the server silently replaces these with spaces (manual v2.6). */
const CONTENTS_BANNED = /['+:?|^]/g;

const byteLen = (s) => Buffer.byteLength(str(s), 'utf8');

const PREMIUM_VALUES = new Set(Object.values(config.premiumCodes));
const MAIL_KIND_VALUES = new Set(Object.values(config.mailKinds));

class ValidationError extends EpostError {
  constructor(issues) {
    super(`Shipment validation failed: ${issues.length} issue(s)`, { status: 400 });
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * Validate before spending an API call.
 *
 * Every rule here comes from the manual's 요청변수 table, error-code list, or
 * version history. Catching these locally matters because a rejected 접수신청 is
 * not free — it is a round trip, and some failures (a stale 보안키, a malformed
 * customs block) are indistinguishable from a transport error at the call site.
 */
export function validateShipment(s) {
  const issues = [];
  const add = (field, msg) => issues.push({ field, message: msg });

  const premiumcd = str(s.premiumcd);
  const em_ee = str(s.em_ee);
  const kind = `${premiumcd}:${em_ee}`;
  const country = upper(s.countrycd);
  const isPremium = premiumcd === config.premiumCodes.EMS_PREMIUM;
  const isDocument = em_ee === config.mailKinds.DOCUMENT;

  if (!premiumcd) {
    add('premiumcd', '국제우편물 구분코드 is required (32 = EMS프리미엄)');
  } else if (!PREMIUM_VALUES.has(premiumcd)) {
    add(
      'premiumcd',
      `unknown code "${premiumcd}" — use 31 (EMS), 32 (EMS프리미엄), 14 (K-Packet), 12 (등기통상), 11 (일반통상), 90 (국제물류)`,
    );
  }

  if (!em_ee) {
    add('em_ee', '국제우편물 종류코드 is required (ee = 서류, em = 비서류)');
  } else if (!MAIL_KIND_VALUES.has(em_ee)) {
    add(
      'em_ee',
      `unknown code "${em_ee}" — use ee (서류), em (비서류), es (SeaExpress), ge/re (소형포장물), rl (K-Packet)`,
    );
  } else if (premiumcd && PREMIUM_VALUES.has(premiumcd) && !config.customsLimits[kind]) {
    // Not every 구분/종류 pairing exists — e.g. EMS프리미엄 has no SeaExpress variant.
    add('em_ee', `종류코드 "${em_ee}" is not a valid combination with 구분코드 "${premiumcd}"`);
  }

  if (!/^[A-Z]{2}$/.test(country)) add('countrycd', 'must be a 2-letter country code');

  // --- weight ---------------------------------------------------------------
  const weight = Number(s.totweight);
  if (!Number.isFinite(weight) || weight <= 0) {
    add('totweight', 'must be a positive weight in grams');
  } else if (isPremium && isDocument && weight > 500) {
    // Manual v2.8, effective 2026-03-26: the document limit dropped from 2000g to 500g.
    add(
      'totweight',
      'EMS프리미엄 서류 is limited to 500g since 2026-03-26. Send this as 비서류 (em_ee = "em") instead.',
    );
  }

  // --- insurance ------------------------------------------------------------
  const insured = upper(s.boyn) === 'Y';
  if (insured) {
    if (isPremium && isDocument) {
      // Manual v2.8, effective 2026-03-26.
      add('boyn', 'EMS프리미엄 서류 cannot be insured since 2026-03-26');
    }
    if (premiumcd === config.premiumCodes.K_PACKET && em_ee === config.mailKinds.K_PACKET) {
      add('boyn', 'K-Packet cannot be insured (등기소형포장물 can)');
    }
    if (!(Number(s.boprc) > 0)) add('boprc', 'boprc is required when boyn = Y');
  }

  // --- box dimensions -------------------------------------------------------
  // Volumetric weight has been mandatory for non-document mail since 2021-01-16.
  if (!isDocument && upper(s.volmwghtapplyexceptyn) !== 'Y') {
    for (const f of ['boxlength', 'boxwidth', 'boxheight']) {
      if (!(Number(s[f]) > 0)) {
        add(f, 'box dimensions (cm) are required for 비서류 — postage bills on the greater of actual and volumetric weight');
      }
    }
  }

  // --- sender ---------------------------------------------------------------
  if (!str(s.sender)) add('sender', 'required');
  else if (str(s.sender).length > 35) add('sender', 'max 35 characters');
  else if (BANNED.test(s.sender)) add('sender', "must not contain ' + : ? |");

  if (!str(s.senderzipcode)) add('senderzipcode', 'required');
  else if (str(s.senderzipcode).length > 6) add('senderzipcode', 'max 6 characters');

  if (!str(s.senderaddr1)) add('senderaddr1', 'required');
  else if (byteLen(s.senderaddr1) > 200) add('senderaddr1', 'max 200 bytes');
  if (!str(s.senderaddr2)) add('senderaddr2', 'required (시/군/구)');
  if (!str(s.senderaddr3)) add('senderaddr3', 'required (도/시) since manual v2.1');

  for (const f of ['senderaddr1', 'senderaddr2', 'senderaddr3']) {
    if (str(s[f]) && BANNED.test(s[f])) add(f, "must not contain ' + : ? |");
  }

  // --- receiver -------------------------------------------------------------
  if (!str(s.receivename)) add('receivename', 'required');
  else if (str(s.receivename).length > 35) add('receivename', 'max 35 characters');
  else if (BANNED.test(s.receivename)) add('receivename', "must not contain ' + : ? |");

  if (!str(s.receiveaddr1)) add('receiveaddr1', 'required (주/도)');
  if (!str(s.receiveaddr2)) add('receiveaddr2', 'required (시/군)');
  if (!str(s.receiveaddr3)) add('receiveaddr3', 'required (상세)');

  // Manual v2.9, effective 2026-04-16.
  if (isPremium && !str(s.receivetelno) && !str(s.receivetelno1)) {
    add('receivetelno', 'EMS프리미엄 requires a recipient phone number since 2026-04-16');
  }

  // --- tax identifiers ------------------------------------------------------
  if ((country === 'BR' || country === 'ID') && !str(s.cdremark)) {
    add('cdremark', `${country} requires a tax identification number`);
  }
  // Manual v2.7, effective 2025-02-20.
  if (isPremium && !isDocument && country === 'MX' && !str(s.vatdscrnno)) {
    add('vatdscrnno', 'EMS프리미엄 비서류 to Mexico requires a tax identification number');
  }

  // --- currency -------------------------------------------------------------
  const currency = upper(s.currunitcd);
  if (!currency) {
    add('currunitcd', 'required (USD, or EUR for EU destinations)');
  } else if (currency === 'EUR' && !config.euCountries.has(country)) {
    add('currunitcd', `EUR is only valid for EU destinations; ${country} must use USD`);
  } else if (!['USD', 'EUR'].includes(currency)) {
    add('currunitcd', 'must be USD or EUR');
  }

  // --- customs items --------------------------------------------------------
  const items = Array.isArray(s.items) ? s.items : [];
  if (items.length === 0) {
    add('items', 'at least one customs line item is required for every destination');
  } else {
    const limit = config.customsLimits[kind];
    if (limit && items.length > limit.submit) {
      add('items', `${kind} allows at most ${limit.submit} line item(s)`);
    }
    if (limit && items.length > limit.print) {
      // Not fatal — the shipment is accepted, but the label truncates.
      issues.push({
        field: 'items',
        message: `only ${limit.print} of ${items.length} items will fit on the printed 기표지`,
        severity: 'warning',
      });
    }

    items.forEach((it, i) => {
      const at = `items[${i}]`;
      if (!str(it.name)) add(`${at}.name`, 'required');
      if (!(Number(it.qty) > 0)) add(`${at}.qty`, 'must be a positive integer');
      if (!(Number(it.weight) > 0)) add(`${at}.weight`, 'net weight (g) is required');
      if (!str(it.hsCode)) add(`${at}.hsCode`, 'required');
      else if (isDocument && !/^49/.test(str(it.hsCode))) {
        add(`${at}.hsCode`, 'document mail requires an HS code beginning with 49');
      }
      if (!str(it.origin)) add(`${at}.origin`, 'required (2-letter country code)');
      if (!isDocument && !(Number(it.value) > 0)) {
        add(`${at}.value`, 'declared value is required for 비서류');
      }
      // Semicolons are the field separator in the wire format, so a value
      // containing one would silently split into extra phantom items.
      for (const f of ['name', 'hsCode', 'origin', 'model']) {
        if (str(it[f]).includes(';')) add(`${at}.${f}`, 'must not contain ";"');
      }
    });
  }

  const errors = issues.filter((i) => i.severity !== 'warning');
  return { valid: errors.length === 0, issues, errors };
}

/** Join customs line items into the semicolon-delimited parallel arrays epost wants. */
function encodeItems(items, isDocument) {
  const pick = (fn) => items.map(fn).join(';');
  return {
    EM_gubun: pick(() => (isDocument ? 'Document' : 'Merchandise')),
    contents: pick((it) => str(it.name).replace(CONTENTS_BANNED, ' ')),
    number: pick((it) => Number(it.qty)),
    weight: pick((it) => Number(it.weight)),
    value: pick((it) => Number(it.value ?? 0)),
    hs_code: pick((it) => str(it.hsCode)),
    origin: pick((it) => upper(it.origin)),
    ...(items.some((it) => str(it.model))
      ? { modelno: pick((it) => str(it.model)) }
      : {}),
  };
}

const splitPhone = (phone, prefix) => {
  const parts = str(phone).split('-').map((p) => p.replace(/\D/g, ''));
  const out = {};
  parts.slice(0, 4).forEach((p, i) => {
    if (p) out[`${prefix}${i + 1}`] = p;
  });
  return out;
};

/**
 * 접수신청(픽업요청) — creates the shipment and returns the 등기번호 immediately.
 *
 * Routes to the DEV message name unless EPOST_LIVE=1. The DEV endpoint issues
 * disposable tracking numbers (EMS프리미엄 gets a PW…KR prefix instead of the
 * live UP…KR) and never transmits to a post office, so development traffic
 * neither consumes real registered numbers nor summons a courier.
 */
export async function createShipment(input) {
  const { valid, issues, errors } = validateShipment(input);
  if (!valid) throw new ValidationError(errors.length ? errors : issues);

  const isDocument = str(input.em_ee) === config.mailKinds.DOCUMENT;
  const insured = upper(input.boyn) === 'Y';

  const fields = {
    custno: config.ems.custNo,
    apprno: input.apprno || config.ems.apprNo,
    premiumcd: str(input.premiumcd),
    em_ee: str(input.em_ee),
    countrycd: upper(input.countrycd),
    totweight: Number(input.totweight),

    boyn: insured ? 'Y' : 'N',
    ...(insured ? { boprc: Number(input.boprc) } : {}),

    ...(input.nextDayReserve
      ? { nextdayreserveyn: 'Y', reqhhmi: str(input.reqhhmi) || '0900' }
      : {}),

    orderno: str(input.orderno),
    ...(input.premiumExport ? { premiumexportyn: 'Y' } : {}),
    cdremark: str(input.cdremark),

    sender: str(input.sender),
    senderzipcode: str(input.senderzipcode),
    senderaddr1: str(input.senderaddr1),
    senderaddr2: str(input.senderaddr2),
    senderaddr3: str(input.senderaddr3),
    ...splitPhone(input.sendertelno, 'sendertelno'),
    ...splitPhone(input.sendermobile, 'sendermobile'),
    senderemail: str(input.senderemail),
    snd_message: str(input.senderMessage),

    receivename: str(input.receivename),
    receivezipcode: str(input.receivezipcode),
    receiveaddr1: str(input.receiveaddr1),
    receiveaddr2: str(input.receiveaddr2),
    receiveaddr3: str(input.receiveaddr3),
    buildnm: str(input.buildnm),
    ...splitPhone(input.receivetelno, 'receivetelno'),
    ...(str(input.receivetelno) ? { receivetelno: str(input.receivetelno) } : {}),
    receivemail: str(input.receivemail),

    ...encodeItems(input.items, isDocument),

    ...(input.customsExport
      ? {
          ecommerceyn: 'Y',
          exportsendprsnnm: str(input.customsExport.name),
          exportsendprsnaddr: str(input.customsExport.address),
          bizregno: str(input.customsExport.bizRegNo),
        }
      : {}),

    ...(upper(input.volmwghtapplyexceptyn) === 'Y'
      ? { volmwghtapplyexceptyn: 'Y' }
      : {
          boxlength: Number(input.boxlength),
          boxwidth: Number(input.boxwidth),
          boxheight: Number(input.boxheight),
        }),

    vatdscrnno: str(input.vatdscrnno),
    currunitcd: upper(input.currunitcd),
  };

  const message = config.live ? config.messages.applyLive : config.messages.applyDev;
  // option=001 also returns the 교환국코드 and any API notice.
  const parsed = await callSecure(message, fields, { option: '001' });

  const regino = findScalar(parsed, 'regino');
  if (!regino) {
    throw new EpostError('접수신청 returned no 등기번호', {
      status: 502,
      raw: JSON.stringify(parsed).slice(0, 600),
    });
  }

  return {
    live: config.live,
    trackingNumber: regino,
    receiveSeq: findScalar(parsed, 'receiveseq') ?? null,
    reqNo: findScalar(parsed, 'reqno') ?? null,
    orderNo: findScalar(parsed, 'orderno') ?? null,
    postageKrw: Number(findScalar(parsed, 'prerecevprc') ?? 0) || null,
    payMethod: findScalar(parsed, 'prcpaymethcd') === '12' ? '후납' : '즉납',
    officeCode: findScalar(parsed, 'treatporegipocd') ?? null,
    officeNameEn: findScalar(parsed, 'treatporegipoengnm') ?? null,
    exchangeOffice: findScalar(parsed, 'exchgPoCd') ?? null,
    reservation: {
      type: findScalar(parsed, 'reservedivcd') === '2' ? 'next-morning' : 'immediate',
      date: findScalar(parsed, 'reqymd') ?? null,
      time: findScalar(parsed, 'reqhhmi') ?? null,
    },
    notice: findScalar(parsed, 'noticeMsg') ?? null,
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}

/**
 * 접수신청 확인 — has the post office picked this up yet?
 * confirmyn = Y means the shipment can no longer be cancelled.
 */
export async function confirmShipment(orderno) {
  if (!str(orderno)) {
    throw new EpostError('orderno is required', { status: 400 });
  }
  const parsed = await callSecure(config.messages.applyConfirm, {
    custno: config.ems.custNo,
    orderno: str(orderno),
  });

  const regino = findScalar(parsed, 'regino');
  if (!regino) return { found: false, orderNo: str(orderno) };

  const confirmed = findScalar(parsed, 'confirmyn') === 'Y';
  return {
    found: true,
    trackingNumber: regino,
    receiveSeq: findScalar(parsed, 'receiveseq') ?? null,
    reqNo: findScalar(parsed, 'reqno') ?? null,
    orderNo: findScalar(parsed, 'orderno') ?? str(orderno),
    sender: findScalar(parsed, 'sender') ?? null,
    receiver: findScalar(parsed, 'receivename') ?? null,
    country: findScalar(parsed, 'countrycd') ?? null,
    confirmedByPostOffice: confirmed,
    cancellable: !confirmed,
  };
}

/** 접수신청 취소 — only possible before the post office confirms. */
export async function cancelShipment({ reqno, regino, apprno }) {
  if (!str(reqno) || !str(regino)) {
    throw new EpostError('both reqno (예약번호) and regino (등기번호) are required', {
      status: 400,
    });
  }

  const parsed = await callSecure(config.messages.applyCancel, {
    custno: config.ems.custNo,
    apprno: str(apprno) || config.ems.apprNo,
    reqno: str(reqno),
    regino: str(regino),
    cancelyn: 'Y',
  });

  // canceledyn is the RESULT of the attempt, not an echo of the request:
  // 'N' with a notcancelreason means the post office already took the parcel.
  const cancelled = findScalar(parsed, 'canceledyn') === 'Y';
  return {
    cancelled,
    reason: findScalar(parsed, 'notcancelreason') ?? null,
    trackingNumber: findScalar(parsed, 'regino') ?? str(regino),
    reqNo: findScalar(parsed, 'reqno') ?? str(reqno),
    orderNo: findScalar(parsed, 'orderno') ?? null,
  };
}

/** 고객번호 조회 — resolve an ePost member ID to a 고객번호. */
export async function lookupCustomerNumber(memberId) {
  const parsed = await callSecure(config.messages.custNo, { memberID: str(memberId) });
  return { custNo: findScalar(parsed, 'custno') ?? null };
}

/** 계약승인번호 조회 — list contracts and their billing mode. */
export async function listContracts(custNo) {
  const parsed = await callSecure(config.messages.contractInfo, {
    custno: str(custNo) || config.ems.custNo,
  });
  return collectNodes(parsed, 'contractInfo')
    .map((r) => ({
      apprNo: str(r.apprno),
      summary: str(r.expl),
      payMethod: str(r.prcpaymethcd) === '12' ? '후납' : '즉납',
      contractType: str(r.cntracdivcd),
      discountRate: Number(str(r.cntracdcrate)) || 0,
    }))
    .filter((r) => r.apprNo);
}

export { ValidationError };
