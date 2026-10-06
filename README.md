# Stock Shop

Stock management for one storekeeper: Main Store and Shop quantities, transfers, daily Shop counts, monthly reconciliation, alerts and reports.

Stack: Node.js + Express, SQLite (better-sqlite3), plain HTML/JS frontend. No Google Sheets, no Apps Script.

## Run it

Requires Node.js 18 or newer.

    npm install
    npm start

Open http://localhost:3000. The first run loads clearly labelled SAMPLE items. Delete `data/stock.db` to start clean.

Optional environment variables:

- `PORT` (default 3000)
- `STOCK_USER` name recorded on every action (default "Storekeeper")
- `GOOGLE_API_KEY` enables the Google Gemini assistant using the free-tier API
- `GOOGLE_MODEL` (default `gemini-2.5-flash`)
- `DB_PATH` database file location

The API key must remain on the server. It is never sent to the browser.

Run the tests with `npm test`.

## How stock is calculated

Balance = opening quantity + net transfers + reasoned adjustments. Every screen, report and the assistant use the same function in `src/stock.js`, so they always agree.

- Transfers are atomic: both locations change in one database transaction, or neither does. Each one stores the before/after balances, user and timestamp.
- Transfers are rejected if the quantity is zero or invalid, the item is inactive, the date is invalid or in the future, the request is a duplicate, or the source would go negative.
- Daily counts record the physical quantity, the difference and MATCHED / SHORT / EXCESS. They never change stock. A discrepancy raises an alert for review.
- Only an explicit adjustment (with a required reason) changes stock.
- Deactivating an item keeps all its history visible.

## Alerts

Low and out-of-stock alerts are derived from current balances and clear automatically when stock recovers. Discrepancy alerts clear on a matching recount or when reviewed with a reason. All alerts live in the app; email is a future setting and is not needed.

## AI assistant

The assistant calls the same service functions as the UI through tool use, so every rule applies to it. It can check balances, move stock, record counts and adjustments, manage items, review alerts and run reports. It cannot record sales, prices, suppliers or invoices, and it cannot set balances directly.

## Project layout

    src/db.js          schema, indexes, sample seed
    src/stock.js       all business rules (balances, transfers, counts, adjustments, monthly, alerts, reports)
    src/assistant.js   AI assistant tool definitions and loop
    src/server.js      REST API
    public/index.html  the app UI
    tests/smoke.js     rule tests

## Not included (by design)

External email, multi-role permissions, sales/accounting, invoices, suppliers, and manually editable current balances.

## Notes

- Back up `data/stock.db`. It is the only copy of your data.
- For multiple devices or a hosted deployment, put the server behind your own HTTPS and login. This version has no authentication, so run it on a trusted machine or network.
