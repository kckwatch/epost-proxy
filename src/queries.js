import { config } from './config.js';
import { callQuery, collectNodes, findScalar, EpostError } from './eship.js';
import { cached } from './cache.js';

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const upper = (v) => str(v).toUpperCase();

const PREMIUM_VALUES = new Set(Object.values(config.premiumCodes));

function assertPremiumCd(premiumcd) {
  const v = str(premiumcd);
  if (!PREMIUM_VALUES.has(v)) {
    throw new EpostError(
      `Unknown premiumcd "${v}". Use 31 (EMS), 32 (EMS프리미엄), 14 (K-Packet), 12 (등기통상), 11 (일반통상), 90 (국제물류).`,
      { status: 400 },
    );
  }
  return v;
}

/**
 * 보험취급 코드 (insutreatcd) — manual footnote 3.
 * The sibling `insuyn` field comes back EMPTY from the live service for every
 * country, on both premiumcd 31 and 32, so it cannot be used to decide
 * insurability. Trusting it would mark all 184 destinations uninsurable, which
 * for watch shipments is the difference between an insured parcel and an
 * uninsured one.
 */
const INSURANCE_TREATMENT = {
  '0': { insurable: false, label: '취급안함' },
  '1': { insurable: true, label: '전국' },
  '2': { insurable: true, label: '적용지역에 한함' },
};

export function readInsurance(row) {
  const code = str(row.insutreatcd);
  const known = INSURANCE_TREATMENT[code];
  const flag = upper(row.insuyn);

  return {
    // Prefer the explicit flag when the server actually sends one; fall back to
    // the treatment code, which it does populate.
    insurable: flag === 'Y' ? true : flag === 'N' ? false : (known?.insurable ?? false),
    insuranceCode: code,
    insuranceNote: known?.label ?? (code ? `알 수 없는 코드 ${code}` : '정보 없음'),
    // Region-limited cover is not blanket cover — surface it so a high-value
    // shipment isn't assumed covered without checking.
    insuranceRegionLimited: code === '2',
  };
}

/**
 * 발송가능 국가 조회 — which countries this product can be sent to, with the
 * rate zone and whether insurance is available.
 */
export async function getNations(premiumcd = config.premiumCodes.EMS_PREMIUM) {
  const cd = assertPremiumCd(premiumcd);
  return cached(`nations:${cd}`, config.ttl.nations, async () => {
    const parsed = await callQuery(config.messages.nationList, { premiumcd: cd });

    const rows = collectNodes(parsed, 'RetrieveNationList');
    if (rows.length === 0) {
      throw new EpostError('발송가능 국가 조회 returned no rows', { status: 502 });
    }

    return rows
      .map((r) => ({
        code: upper(r.nationcd),
        nameKo: str(r.nationnm),
        nameEn: str(r.nationfn),
        zone: str(r.prcapplyareacd),
        premiumcd: str(r.premiumcd),
        mailKind: str(r.frnmailkindcd) || null,
        ...readInsurance(r),
      }))
      .filter((r) => r.code);
  });
}

/** 국가별 발송 조건 조회 — weight caps, prohibited items, per-country rules. */
export async function getNationCondition(nation, premiumcd, em_ee) {
  const key = `cond:${upper(nation)}:${str(premiumcd)}:${str(em_ee)}`;
  return cached(key, config.ttl.conditions, async () => {
    const parsed = await callQuery(config.messages.nationCondition, {
      nation: upper(nation),
      premiumcd: assertPremiumCd(premiumcd),
      em_ee: str(em_ee),
    });
    return { raw: parsed };
  });
}

/**
 * 접수중지 및 배송지연 국가 조회.
 *
 * The manual presents `nationcd` as optional, but the live service rejects a
 * call without it: "ERR-111: 필수값이 입력되지 않았습니다. 국가코드(nationcd)를
 * 입력하여 주세요." So there is no way to fetch the whole suspension list —
 * it has to be checked one destination at a time, right before shipping.
 *
 * Cached for only an hour: suspensions appear with little notice (strikes,
 * disasters, customs actions) and shipping into one means the parcel comes back.
 */
export async function getSuspension(nation, premiumcd = config.premiumCodes.EMS_PREMIUM) {
  const country = upper(nation);
  const cd = assertPremiumCd(premiumcd);

  if (!/^[A-Z]{2}$/.test(country)) {
    throw new EpostError('nation must be a 2-letter country code', { status: 400 });
  }

  return cached(`stopped:${cd}:${country}`, config.ttl.stopNations, async () => {
    const parsed = await callQuery(config.messages.stopOrDelayNations, {
      nationcd: country,
      premiumcd: cd,
    });

    const rows = [
      ...collectNodes(parsed, 'RetrieveStopOrDelayNationList'),
      ...collectNodes(parsed, 'StopOrDelayNationList'),
    ];

    const entries = rows
      .map((r) => ({
        code: upper(r.nationcd ?? r.countrycd) || country,
        nameKo: str(r.nationnm),
        status: str(r.stopdelaysecd ?? r.sttus),
        note: str(r.rm ?? r.remark ?? r.cn),
      }))
      .filter((e) => e.status || e.note);

    return {
      country,
      suspended: entries.length > 0,
      entries,
    };
  });
}

/**
 * 배송 예상비용 조회. Returns the postage epost would charge in KRW.
 *
 * Volumetric weight matters: for non-document mail the post office bills on
 * whichever is greater, actual or volumetric, so box dimensions should always be
 * supplied for a quote you intend to rely on.
 */
export async function getRateQuote({
  premiumcd,
  em_ee,
  countrycd,
  totweight,
  insured = false,
  insuredValue = 0,
  boxLength,
  boxWidth,
  boxHeight,
}) {
  const cd = assertPremiumCd(premiumcd);
  const country = upper(countrycd);
  const weight = Number(totweight);

  if (!country || country.length !== 2) {
    throw new EpostError('countrycd must be a 2-letter country code', { status: 400 });
  }
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new EpostError('totweight must be a positive number of grams', { status: 400 });
  }

  const key = `rate:${cd}:${str(em_ee)}:${country}:${weight}:${insured}:${insuredValue}:${boxLength}:${boxWidth}:${boxHeight}`;
  return cached(key, config.ttl.rate, async () => {
    const parsed = await callQuery(config.messages.rateQuote, {
      premiumcd: cd,
      em_ee: str(em_ee),
      countrycd: country,
      totweight: weight,
      boyn: insured ? 'Y' : 'N',
      boprc: insured ? Number(insuredValue) : 0,
      boxlength: boxLength,
      boxwidth: boxWidth,
      boxheight: boxHeight,
      apprno: config.ems.apprNo,
    });

    const total = findScalar(parsed, 'emsTotProc');
    if (total === undefined) {
      throw new EpostError('Rate quote returned no emsTotProc value', { status: 502 });
    }
    return {
      currency: 'KRW',
      total: Number(total),
      country,
      premiumcd: cd,
      em_ee: str(em_ee),
      weightG: weight,
      insured,
    };
  });
}

/** 새우편번호 영문주소 조회 — Korean postcode to romanised address, for the sender block. */
export async function getEnglishAddress(query) {
  const q = str(query);
  if (q.length < 2) {
    throw new EpostError('query must be at least 2 characters', { status: 400 });
  }
  return cached(`engaddr:${q}`, config.ttl.geo, async () => {
    const parsed = await callQuery(config.messages.engZipCode, { query: q });
    const rows = [
      ...collectNodes(parsed, 'EmsSearchNewEngZipCodeInfo'),
      ...collectNodes(parsed, 'NewEngZipCodeInfo'),
      ...collectNodes(parsed, 'itemlist'),
    ];
    return rows.map((r) => ({
      zipCode: str(r.zipcode ?? r.zipNo ?? r.postcd),
      addressEn: str(r.engaddr ?? r.engAddr ?? r.address),
      addressKo: str(r.koraddr ?? r.korAddr),
    }));
  });
}

/** KPG 주도 → 시도 → 우편번호 cascade for destination address validation. */
export async function getKpgJuDo(nation) {
  const code = upper(nation);
  return cached(`kpg:judo:${code}`, config.ttl.geo, async () => {
    const parsed = await callQuery(config.messages.kpgJuDo, { nation: code });
    return collectNodes(parsed, 'RetrieveJuDoList')
      .map((r) => ({ code: str(r.judocd ?? r.judoCd), name: str(r.judonm ?? r.judoNm) }))
      .filter((r) => r.code);
  });
}

export async function getKpgSiDo(nation, judocd) {
  const key = `kpg:sido:${upper(nation)}:${str(judocd)}`;
  return cached(key, config.ttl.geo, async () => {
    const parsed = await callQuery(config.messages.kpgSiDo, {
      nation: upper(nation),
      judocd: str(judocd),
    });
    return collectNodes(parsed, 'RetrieveSiDoList')
      .map((r) => ({ code: str(r.sidocd ?? r.sidoCd), name: str(r.sidonm ?? r.sidoNm) }))
      .filter((r) => r.code);
  });
}

export async function getKpgZipCodes(nation, judocd, sidocd) {
  const key = `kpg:zip:${upper(nation)}:${str(judocd)}:${str(sidocd)}`;
  return cached(key, config.ttl.geo, async () => {
    const parsed = await callQuery(config.messages.kpgZipCode, {
      nation: upper(nation),
      judocd: str(judocd),
      sidocd: str(sidocd),
    });
    return collectNodes(parsed, 'RetrieveZipCodeList')
      .map((r) => str(r.zipcode ?? r.zipNo))
      .filter(Boolean);
  });
}

/**
 * Composite pre-flight check for one destination: can we ship there, is it
 * currently suspended, is insurance available, which currency is allowed.
 * One call for the order row before 접수신청.
 */
export async function checkDestination(countryCode, premiumcd = config.premiumCodes.EMS_PREMIUM) {
  const code = upper(countryCode);
  const cd = assertPremiumCd(premiumcd);

  const [nationsResult, suspensionResult] = await Promise.allSettled([
    getNations(cd),
    getSuspension(code, cd),
  ]);

  if (nationsResult.status === 'rejected') throw nationsResult.reason;
  const nation = nationsResult.value.value.find((n) => n.code === code) ?? null;

  // A suspension lookup failure must not read as "no suspension" — that would
  // wave through a shipment into a country that is refusing mail.
  const suspension =
    suspensionResult.status === 'fulfilled' ? suspensionResult.value.value : null;
  const suspensionUnknown = suspensionResult.status === 'rejected';

  return {
    country: code,
    premiumcd: cd,
    listed: Boolean(nation),
    shippable: Boolean(nation) && !suspension?.suspended && !suspensionUnknown,
    suspensionUnknown,
    suspensionError: suspensionUnknown ? String(suspensionResult.reason?.message ?? '') : null,
    nation,
    suspension,
    insurable: nation?.insurable ?? false,
    insuranceNote: nation?.insuranceNote ?? null,
    insuranceRegionLimited: nation?.insuranceRegionLimited ?? false,
    preClearanceRequired: config.preClearanceCountries.has(code),
    currencyOptions: config.euCountries.has(code) ? ['USD', 'EUR'] : ['USD'],
  };
}
