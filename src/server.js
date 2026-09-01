import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { EpostError } from './eship.js';
import { cacheStats, cacheClear } from './cache.js';
import {
  getNations, getStoppedNations, getRateQuote, getEnglishAddress,
  getKpgJuDo, getKpgSiDo, getKpgZipCodes, checkDestination,
} from './queries.js';
import {
  createShipment, confirmShipment, cancelShipment,
  validateShipment, listContracts, ValidationError,
} from './shipment.js';
import { traceShipment } from './trace.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server
    cb(null, config.allowedOrigins.includes(origin));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-proxy-key'],
  maxAge: 86400,
}));

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.get('x-proxy-key') !== config.proxySecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
});

const ok = (res) => (data, cached = false) => res.json({ ok: true, cached, data });
const wrap = (h) => async (req, res, next) => { try { await h(req, res); } catch (e) { next(e); } };

app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'epost-proxy',
  mode: config.live ? 'LIVE' : 'DEV',
  traceConfigured: Boolean(config.trace.key && config.trace.param),
  cache: cacheStats(),
}));

/* ---------------------------------- 조회 ---------------------------------- */

app.get('/api/epost/nations', wrap(async (req, res) => {
  const { value, fromCache } = await getNations(req.query.premiumcd);
  ok(res)(value, fromCache);
}));

app.get('/api/epost/destination/:code', wrap(async (req, res) => {
  ok(res)(await checkDestination(req.params.code, req.query.premiumcd));
}));

app.get('/api/epost/suspensions', wrap(async (req, res) => {
  const { value, fromCache } = await getStoppedNations(req.query.premiumcd);
  ok(res)(value, fromCache);
}));

app.get('/api/epost/rate', wrap(async (req, res) => {
  const { value, fromCache } = await getRateQuote({
    premiumcd: req.query.premiumcd,
    em_ee: req.query.em_ee,
    countrycd: req.query.country,
    totweight: req.query.weight,
    insured: req.query.insured === 'true',
    insuredValue: req.query.insuredValue,
    boxLength: req.query.length,
    boxWidth: req.query.width,
    boxHeight: req.query.height,
  });
  ok(res)(value, fromCache);
}));

app.get('/api/epost/address/en', wrap(async (req, res) => {
  const { value, fromCache } = await getEnglishAddress(req.query.q);
  ok(res)(value, fromCache);
}));

app.get('/api/epost/kpg/:nation', wrap(async (req, res) => {
  const { value, fromCache } = await getKpgJuDo(req.params.nation);
  ok(res)(value, fromCache);
}));

app.get('/api/epost/kpg/:nation/:judo', wrap(async (req, res) => {
  const { value, fromCache } = await getKpgSiDo(req.params.nation, req.params.judo);
  ok(res)(value, fromCache);
}));

app.get('/api/epost/kpg/:nation/:judo/:sido', wrap(async (req, res) => {
  const { value, fromCache } = await getKpgZipCodes(req.params.nation, req.params.judo, req.params.sido);
  ok(res)(value, fromCache);
}));

app.get('/api/epost/contracts', wrap(async (req, res) => {
  ok(res)(await listContracts(req.query.custno));
}));

/* --------------------------------- 접수신청 --------------------------------- */

// Dry run: same validation the real call performs, without spending a request.
app.post('/api/epost/shipments/validate', wrap(async (req, res) => {
  ok(res)(validateShipment(req.body ?? {}));
}));

app.post('/api/epost/shipments', wrap(async (req, res) => {
  ok(res)(await createShipment(req.body ?? {}));
}));

app.get('/api/epost/shipments/:orderno', wrap(async (req, res) => {
  ok(res)(await confirmShipment(req.params.orderno));
}));

app.post('/api/epost/shipments/cancel', wrap(async (req, res) => {
  ok(res)(await cancelShipment(req.body ?? {}));
}));

/* ---------------------------------- 행방조회 --------------------------------- */

app.get('/api/epost/track/:number', wrap(async (req, res) => {
  const { value, fromCache } = await traceShipment(req.params.number);
  ok(res)(value, fromCache);
}));

/* ---------------------------------- admin ---------------------------------- */

app.post('/api/epost/cache/clear', wrap(async (req, res) => {
  cacheClear(req.body?.prefix);
  res.json({ ok: true, cache: cacheStats() });
}));

app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof ValidationError) {
    return res.status(400).json({ ok: false, error: err.message, issues: err.issues });
  }
  if (err instanceof EpostError) {
    if (config.logBodies && err.raw) console.error('[epost raw]', err.raw);
    console.error('[epost]', err.message);
    return res.status(err.status || 502).json({
      ok: false, error: err.message, code: err.code, hint: err.hint,
    });
  }
  console.error('[proxy]', err);
  res.status(500).json({ ok: false, error: 'internal error' });
});

app.listen(config.port, () => {
  console.log(`epost-proxy listening on :${config.port}`);
  console.log(
    config.live
      ? '*** LIVE MODE — 접수신청 creates real shipments and real 등기번호 ***'
      : 'DEV mode — 접수신청 uses the DEV endpoint (throwaway tracking numbers, no post office). Set EPOST_LIVE=1 to go live.',
  );
});
