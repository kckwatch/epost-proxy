/**
 * Config for the 우체국 계약고객 EMS/K-Packet OpenAPI (eship.epost.go.kr)
 * and the separate 행방조회 service (openapi.epost.go.kr).
 *
 * Required env:
 *   EPOST_EMS_KEY         인증키 for EMS/K-Packet (sent as regkey or key)
 *   EPOST_EMS_SECRET      보안키, exactly 16 bytes — SEED-128 key for regData
 *   EPOST_CUST_NO         (우체국) 고객번호, up to 10 digits
 *   EPOST_APPR_NO         계약승인번호
 *   PROXY_SHARED_SECRET   gate for our own callers
 *
 * Optional:
 *   EPOST_LIVE=1          use the production 접수신청 endpoint. WITHOUT THIS every
 *                         shipment goes to the DEV endpoint, which mints throwaway
 *                         tracking numbers and never reaches a post office. Leave
 *                         it unset until you have deliberately decided to ship for real.
 *   EPOST_TRACE_KEY       행방조회 service key (a different service entirely)
 *   EPOST_TRACE_PARAM     undocumented request param — see scripts/probe-trace.js
 */

const required = (name) => {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
};

const secret = required('EPOST_EMS_SECRET');
if (Buffer.byteLength(secret, 'binary') !== 16) {
  throw new Error(
    `EPOST_EMS_SECRET must be exactly 16 bytes (SEED-128 key); got ${secret.length} chars`,
  );
}

export const config = {
  port: Number(process.env.PORT || 8081),
  proxySecret: required('PROXY_SHARED_SECRET'),

  ems: {
    regKey: required('EPOST_EMS_KEY'),
    secretKey: secret,
    custNo: required('EPOST_CUST_NO'),
    apprNo: required('EPOST_APPR_NO'),
  },

  // Guard rail: production shipment creation is opt-in, never the default.
  live: process.env.EPOST_LIVE === '1',

  trace: {
    key: process.env.EPOST_TRACE_KEY || null,
    param: process.env.EPOST_TRACE_PARAM || null,
    url: 'http://openapi.epost.go.kr/trace/retrieveLongitudinalEMSService/retrieveLongitudinalEMSService/getLongitudinalEMSList',
  },

  // The manual writes https:// in the usage section and http:// in the examples.
  // https keeps regData off the wire in clear text; override only if TLS fails.
  baseUrl: process.env.EPOST_BASE_URL || 'https://eship.epost.go.kr',

  /**
   * The manual states plainly that calls arriving without HTTP headers can be
   * dropped by the firewall once a customer's call volume crosses a threshold.
   * These are not optional politeness.
   */
  headers: {
    Connection: 'keep-alive',
    'User-Agent': process.env.EPOST_USER_AGENT || 'Apache-HttpClient/4.5.1 (Java/1.8.0_91)',
    Accept: 'application/xml, text/xml, */*',
  },

  messages: {
    // 조회 — plaintext params, authenticated with regkey
    nationList: 'api.RetrieveNationListRequest.ems',
    nationCondition: 'api.EmsApplyGoCondition.ems',
    stopOrDelayNations: 'api.RetrieveStopOrDelayNationList.ems',
    engZipCode: 'api.EmsSearchNewEngZipCodeInfo.ems',
    kpgJuDo: 'api.RetrieveJuDoListRequest.ems',
    kpgSiDo: 'api.RetrieveSiDoListRequest.ems',
    kpgZipCode: 'api.RetrieveZipCodeListRequest.ems',
    rateQuote: 'api.EmsTotProcCmd.ems',
    ecommerceResult: 'api.RetrieveECommerceRequest.ems',
    exportResult: 'api.RetrieveExportExecutionRequest.ems',

    // 신청 — SEED-encrypted regData, authenticated with key
    custNo: 'api.EmsIdCustnoInfo.ems',
    contractInfo: 'api.EmsPrcPayMethodList.ems',
    applyLive: 'api.EmsApplyInsertReceiveTempCmdNew.ems',
    applyDev: 'api.EmsApplyInsertReceiveTempCmdNewDEV.ems',
    applyConfirm: 'api.RetrieveEMSResDset.ems',
    applyCancel: 'api.EmsApplyCancel.ems',
  },

  /** 국제우편물 구분코드 (premiumcd) — manual footnote 2. */
  premiumCodes: {
    EMS: '31',
    EMS_PREMIUM: '32',
    K_PACKET: '14',
    NORMAL_MAIL: '11',
    REGISTERED_MAIL: '12',
    LOGISTICS: '90',
  },

  /** 국제우편물 종류코드 (em_ee) — manual footnote 2. */
  mailKinds: {
    DOCUMENT: 'ee',
    NON_DOCUMENT: 'em',
    SEA_EXPRESS: 'es',
    SMALL_PACKET: 'ge',
    REGISTERED_SMALL_PACKET: 're',
    K_PACKET: 'rl',
  },

  /** 등기번호 prefixes — footnote 29 (live) and footnote 10 (dev). */
  trackingPrefixes: {
    live: { '31:ee': 'ED', '31:em': 'EG', '32:ee': 'UP', '32:em': 'UP', '14:rl': 'LK/LI/LP', '14:re': 'RK' },
    dev: { '31:ee': 'MD', '31:em': 'MG', '32:ee': 'PW', '32:em': 'PW', '14:rl': 'ML', '14:re': 'MR' },
  },

  /** Countries requiring 사전통관 customs data — footnote 21. */
  preClearanceCountries: new Set([
    'AE', 'AT', 'AU', 'BE', 'BG', 'BR', 'CA', 'CH', 'CN', 'CY', 'CZ', 'DE', 'DK',
    'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HK', 'HR', 'HU', 'ID', 'IE', 'IT', 'JO',
    'JP', 'KG', 'KZ', 'LI', 'LT', 'LU', 'LV', 'MD', 'MN', 'MO', 'MT', 'NL', 'NO',
    'PL', 'PT', 'QA', 'RO', 'RW', 'SA', 'SE', 'SI', 'SK', 'TH', 'UA', 'US',
  ]),

  /** EU members — only these may quote in EUR (footnote 28). */
  euCountries: new Set([
    'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
    'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
  ]),

  /** Max customs line items submittable / printable — footnote 21. */
  customsLimits: {
    '31:ee': { submit: 1, print: 1 },
    '31:em': { submit: 30, print: 4 },
    '31:es': { submit: 15, print: 4 },
    '32:ee': { submit: 1, print: 1 },
    '32:em': { submit: 30, print: 4 },
    '14:rl': { submit: 10, print: 5 },
    '14:re': { submit: 10, print: 5 },
  },

  ttl: {
    nations: 24 * 60 * 60 * 1000,
    conditions: 12 * 60 * 60 * 1000,
    stopNations: 60 * 60 * 1000, // suspensions change on short notice
    rate: 60 * 60 * 1000,
    geo: 24 * 60 * 60 * 1000,
    trace: 10 * 60 * 1000,
  },

  allowedOrigins: (process.env.ALLOWED_ORIGINS ||
    'https://standardtime.watch,https://www.standardtime.watch,http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean),

  logBodies: process.env.LOG_BODIES === '1',
};
