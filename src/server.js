const path = require('path');
const express = require('express');
const { seed, DB_PATH } = require('./db');
const s = require('./stock');
const { runAssistant, aiEnabled } = require('./assistant');

seed();

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const USER = () => process.env.STOCK_USER || 'Storekeeper';

function send(res, fn) {
  try {
    res.json(fn());
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({
      error: e.status ? e.message : 'Something went wrong on the server. Please try again.',
    });
  }
}
function sendReport(res, rows, format, name) {
  if (format === 'csv') return res.type('text/csv').attachment(`${name}.csv`).send(s.toCsv(rows));
  return res.json(rows);
}

app.get('/api/status', (req, res) => res.json({
  user: USER(),
  ai: aiEnabled(),
  aiProvider: process.env.LOCAL_AI_URL ? 'local' : 'google',
  localAiUrl: process.env.LOCAL_AI_URL || null,
  localAiModel: process.env.LOCAL_AI_MODEL || 'local-model',
  geminiModel: process.env.GOOGLE_MODEL || 'gemini-2.5-flash',
  email: 'not configured (future setting)',
  db: DB_PATH,
}));

app.get('/api/dashboard', (req, res) => send(res, () => s.dashboard()));

app.get('/api/balances', (req, res) => send(res, () =>
  s.balances(s.isDate(req.query.asOf) ? req.query.asOf : null)));

app.get('/api/items', (req, res) => send(res, () => s.listItems(req.query.all === '1')));
app.post('/api/items', (req, res) => send(res, () => s.createItem(req.body, USER())));
app.patch('/api/items/:id', (req, res) => send(res, () => s.updateItem(Number(req.params.id), req.body, USER())));

app.get('/api/movements', (req, res) => {
  try {
    const rows = s.report('movements', req.query);
    sendReport(res, rows, req.query.format, 'movements');
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/movements', (req, res) => send(res, () => s.transfer(req.body, USER())));

app.get('/api/counts', (req, res) => send(res, () => s.listCounts(req.query.date)));
app.post('/api/counts', (req, res) => send(res, () => {
  const { date, lines } = req.body || {};
  if (!Array.isArray(lines) || !lines.length) {
    throw Object.assign(new Error('No counts to save.'), { status: 400 });
  }
  const results = lines.map((l) => {
    try {
      return s.recordCount({ date, item: l.item_id, physical: l.physical }, USER());
    } catch (e) {
      return { item_id: l.item_id, error: e.message };
    }
  });
  return { results };
}));

app.get('/api/monthly', (req, res) => send(res, () => s.monthly(req.query.month)));
app.post('/api/adjustments', (req, res) => send(res, () => s.adjust(req.body, USER())));

app.get('/api/history', (req, res) => send(res, () => s.summary(
  req.query.period || 'month', req.query.date || s.today())));

app.get('/api/alerts', (req, res) => send(res, () => s.listAlerts(req.query.status)));
app.post('/api/alerts/:id/review', (req, res) => send(res, () =>
  s.reviewAlert(Number(req.params.id), req.body.action, req.body.note, USER())));

app.get('/api/reports/:type', (req, res) => {
  try {
    const q = { ...req.query, month: req.query.month || new Date().toISOString().slice(0, 7) };
    const rows = s.report(req.params.type, q);
    sendReport(res, rows, req.query.format, `${req.params.type}-${q.month || s.today()}`);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/assistant', async (req, res) => {
  try {
    const out = await runAssistant(String(req.body.message || '').slice(0, 2000), req.body.history, USER());
    res.json(out);
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Assistant error. Try again.' });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Stock Shop running at http://localhost:${PORT}`));
