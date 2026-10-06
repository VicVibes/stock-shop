// The assistant acts through the same service functions the UI uses, so every
// rule (no negatives, reasons required, atomic transfers, audit log) applies to it too.
const s = require('./stock');

const aiEnabled = () => Boolean(process.env.LOCAL_AI_URL || process.env.GOOGLE_API_KEY);

const TOOLS = [
  { name: 'get_dashboard', description: 'Get totals, today\'s movement count, count progress and open alert counts.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'get_balances', description: 'Get Shop and Store balances per active item, optionally as of a date.',
    input_schema: { type: 'object', properties: { as_of: { type: 'string', description: 'YYYY-MM-DD' } } } },
  { name: 'list_items', description: 'List items, optionally filtered by name.',
    input_schema: { type: 'object', properties: { search: { type: 'string' }, include_inactive: { type: 'boolean' } } } },
  { name: 'create_item', description: 'Create a new item with unit, category, minimums and opening quantities.',
    input_schema: { type: 'object', required: ['name'], properties: {
      name: { type: 'string' }, category: { type: 'string' }, unit: { type: 'string' },
      min_shop: { type: 'integer' }, min_store: { type: 'integer' },
      opening_shop: { type: 'integer' }, opening_store: { type: 'integer' } } } },
  { name: 'update_item', description: 'Change an item\'s name, category, unit, minimums, or set active true/false (deactivate keeps history).',
    input_schema: { type: 'object', required: ['item'], properties: {
      item: { type: 'string', description: 'Item name or id' }, name: { type: 'string' }, category: { type: 'string' },
      unit: { type: 'string' }, min_shop: { type: 'integer' }, min_store: { type: 'integer' },
      active: { type: 'boolean' } } } },
  { name: 'transfer_stock', description: 'Move stock between Store and Shop. Fails if not enough stock.',
    input_schema: { type: 'object', required: ['item', 'direction', 'qty'], properties: {
      item: { type: 'string' }, direction: { type: 'string', enum: ['STORE_TO_SHOP', 'SHOP_TO_STORE'] },
      qty: { type: 'integer' }, date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
      note: { type: 'string' } } } },
  { name: 'record_daily_count', description: 'Record a physical Shop count. Shows the difference and MATCHED/SHORT/EXCESS. Does not change stock.',
    input_schema: { type: 'object', required: ['item', 'physical'], properties: {
      item: { type: 'string' }, physical: { type: 'integer' }, date: { type: 'string' } } } },
  { name: 'record_adjustment', description: 'Post a reason-required stock adjustment at Shop or Store (reconciliation).',
    input_schema: { type: 'object', required: ['item', 'location', 'delta', 'reason'], properties: {
      item: { type: 'string' }, location: { type: 'string', enum: ['SHOP', 'STORE'] },
      delta: { type: 'integer', description: 'Positive or negative, not zero' },
      reason: { type: 'string' }, date: { type: 'string' } } } },
  { name: 'get_monthly_account', description: 'Monthly stock account: opening, transfers, adjustments, closing per item.',
    input_schema: { type: 'object', required: ['month'], properties: { month: { type: 'string', description: 'YYYY-MM' } } } },
  { name: 'list_alerts', description: 'List open and acknowledged alerts (low, out, discrepancy).',
    input_schema: { type: 'object', properties: {} } },
  { name: 'review_alert', description: 'Acknowledge an alert, or clear it with a reason.',
    input_schema: { type: 'object', required: ['alert_id', 'action'], properties: {
      alert_id: { type: 'integer' }, action: { type: 'string', enum: ['acknowledge', 'clear'] },
      note: { type: 'string' } } } },
  { name: 'get_report', description: 'Run a report.',
    input_schema: { type: 'object', required: ['type'], properties: {
      type: { type: 'string', enum: ['balances', 'daily-shop', 'movements', 'low-stock', 'discrepancies', 'monthly'] },
      loc: { type: 'string', enum: ['SHOP', 'STORE'] }, date: { type: 'string' }, from: { type: 'string' },
      to: { type: 'string' }, month: { type: 'string' } } } },
];

const handlers = {
  get_dashboard: () => s.dashboard(),
  get_balances: (a) => s.balances(a.as_of && s.isDate(a.as_of) ? a.as_of : null).filter((r) => r.active),
  list_items: (a) => s.listItems(a.include_inactive !== false)
    .filter((i) => !a.search || i.name.toLowerCase().includes(a.search.toLowerCase())),
  create_item: (a, u) => s.createItem(a, u),
  update_item: (a, u) => s.updateItem(s.findItem(a.item).id, { ...a, item: undefined }, u),
  transfer_stock: (a, u) => s.transfer({ item: a.item, direction: a.direction, qty: a.qty, date: a.date, note: a.note }, u),
  record_daily_count: (a, u) => s.recordCount({ item: a.item, physical: a.physical, date: a.date }, u),
  record_adjustment: (a, u) => s.adjust({ item: a.item, location: a.location, delta: a.delta, reason: a.reason, date: a.date }, u),
  get_monthly_account: (a) => s.monthly(a.month),
  list_alerts: () => s.listAlerts(),
  review_alert: (a, u) => s.reviewAlert(a.alert_id, a.action, a.note, u),
  get_report: (a) => s.report(a.type, a),
};

const SYSTEM = () => `You are the stock assistant inside a storekeeper's inventory app. You can do everything the storekeeper can do in the app: check balances, move stock between Store and Shop, record daily Shop counts, post reasoned adjustments, manage items, review alerts, and run reports. You cannot record sales, prices, suppliers or invoices, and you cannot set current balances directly.
Rules: always use tools for numbers, never guess balances. If an item name is ambiguous or a quantity or direction is missing, ask one short question. After acting, reply briefly: what changed and the resulting balances. Today is ${s.today()}.`;

function toolDeclarations() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }));
}

function googleContents(history, message) {
  const contents = [];
  for (const item of Array.isArray(history) ? history : []) {
    if (item?.role === 'user' && typeof item.content === 'string') {
      contents.push({ role: 'user', parts: [{ text: item.content }] });
    } else if (item?.role === 'assistant' && typeof item.content === 'string') {
      contents.push({ role: 'model', parts: [{ text: item.content }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: message }] });
  return contents;
}

async function runAssistant(message, history, user) {
  const localUrl = process.env.LOCAL_AI_URL;
  const key = process.env.GOOGLE_API_KEY;
  if (!localUrl && !key) throw Object.assign(new Error('The AI assistant is off. Set LOCAL_AI_URL or GOOGLE_API_KEY on the server and restart.'), { status: 503 });
  if (!message.trim()) throw Object.assign(new Error('Type a message first.'), { status: 400 });

  const actions = [];
  const localMode = Boolean(localUrl);
  if (localMode && !message.trim()) throw Object.assign(new Error('Type a message first.'), { status: 400 });

  let contents = localMode
    ? [{ role: 'system', content: SYSTEM() }, ...history.map((item) => ({ role: item.role, content: item.content }))]
    : googleContents(history, message);
  let requestMessage = message;
  for (let step = 0; step < 8; step++) {
    let response;
    let data;
    if (localMode) {
      const endpoint = `${localUrl.replace(/\/$/, '')}/chat/completions`;
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: process.env.LOCAL_AI_MODEL || 'local-model',
          messages: [...contents, { role: 'user', content: requestMessage }],
          tools: toolDeclarations().map((tool) => ({ type: 'function', function: tool })),
          temperature: 0.2,
        }),
      });
      if (!response.ok) {
        const details = await response.text();
        throw Object.assign(new Error(`Local AI request failed (${response.status}). ${details.slice(0, 160)}`), { status: 502 });
      }
      data = await response.json();
      const messageData = data.choices?.[0]?.message;
      const messageContent = messageData?.content || '';
      const functionCalls = messageData?.tool_calls || [];
      if (functionCalls.length === 0) return { reply: messageContent || 'Done.', actions };
      const toolResponses = [];
      for (const call of functionCalls) {
        const toolCall = call.function;
        let output;
        try {
          const fn = handlers[toolCall.name];
          if (!fn) throw new Error(`Unknown tool ${toolCall.name}`);
          output = JSON.stringify(fn(JSON.parse(toolCall.arguments || '{}'), user) ?? null);
          actions.push({ tool: toolCall.name, input: JSON.parse(toolCall.arguments || '{}') });
        } catch (error) {
          output = error.message;
        }
        toolResponses.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
      contents = [...contents, { role: 'assistant', content: messageContent }, ...toolResponses];
      requestMessage = 'Continue using the available tools and provide the final result.';
    } else {
      const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GOOGLE_MODEL || 'gemini-2.5-flash'}:generateContent`;
      response = await fetch(`${baseUrl}?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM() }] }, tools: [{ functionDeclarations: toolDeclarations() }], contents }),
      });
      if (!response.ok) {
        const details = await response.text();
        throw Object.assign(new Error(`Google assistant request failed (${response.status}). ${details.slice(0, 160)}`), { status: 502 });
      }
      data = await response.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const textParts = parts.filter((part) => part.text).map((part) => part.text).join('\n').trim();
      const functionCalls = parts.filter((part) => part.functionCall);
      if (functionCalls.length === 0) return { reply: textParts || 'Done.', actions };
      const toolResponses = [];
      for (const part of functionCalls) {
        const call = part.functionCall;
        let output;
        try {
          const fn = handlers[call.name];
          if (!fn) throw new Error(`Unknown tool ${call.name}`);
          output = JSON.stringify(fn(call.args || {}, user) ?? null);
          actions.push({ tool: call.name, input: call.args || {} });
        } catch (error) { output = error.message; }
        toolResponses.push({ role: 'user', parts: [{ functionResponse: { name: call.name, response: { output } } }] });
      }
      contents = [...contents, { role: 'model', parts: functionCalls.map((part) => ({ functionCall: part.functionCall })) }, ...toolResponses];
    }
  }
  return { reply: 'I stopped after several steps. Please check the result and try again.', actions };
}

module.exports = { runAssistant, aiEnabled };
