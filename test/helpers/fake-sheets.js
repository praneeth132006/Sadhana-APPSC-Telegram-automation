// ============================================================================
// An in-memory Google Sheets API (test/helpers/fake-sheets.js)
// ============================================================================
// Just enough of the Sheets v4 REST API for a workbook of plain tabs: read a
// range, create a tab, write a row, append rows, rewrite rows in a batch. A
// range naming a tab that does not exist fails the way the real API does
// ("Unable to parse range"), because that is how the code learns to create it.
//
// `book` is { tabName: rows[][] }, inspected directly by the tests.
// ============================================================================

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';

/** "'Sales'!A5:R5" → { tab: 'Sales', row: 5 } */
function parseRange(range) {
  const m = decodeURIComponent(range).match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+)(?::[A-Z]+\d*)?$/);
  if (!m) throw new Error('fake sheets: cannot parse range ' + range);
  return { tab: m[1].replace(/''/g, "'"), row: Number(m[3]) };
}

/**
 * fakeSheetsApi — replaces globalThis.fetch for one spreadsheet id.
 * Requests to anything else fall through to `fallback` (or are refused).
 */
function fakeSheetsApi(book, spreadsheetId, { fallback = null } = {}) {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url && url.url ? url.url : url);
    const method = init.method || 'GET';
    if (u.startsWith('https://oauth2.googleapis.com/token')) return reply(200, { access_token: 'tok', expires_in: 3600 });
    if (!u.startsWith(SHEETS_API + spreadsheetId)) {
      if (fallback) return fallback(url, init);
      throw new Error('fake sheets: unexpected request to ' + u.split('?')[0]);
    }
    const path = u.slice((SHEETS_API + spreadsheetId).length);
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null });

    // Spreadsheet metadata (sheet ids, for formatting requests).
    if (method === 'GET' && /^\?fields=sheets/.test(path)) {
      return reply(200, { sheets: Object.keys(book).map((title, i) => ({ properties: { sheetId: 100 + i, title } })) });
    }
    // Structural batch update: only addSheet changes anything here.
    if (method === 'POST' && path.startsWith(':batchUpdate')) {
      for (const request of JSON.parse(init.body).requests || []) {
        if (request.addSheet) book[request.addSheet.properties.title] = [];
        if (request.deleteSheet) {
          const title = Object.keys(book)[request.deleteSheet.sheetId - 100];
          if (title) delete book[title];
        }
      }
      return reply(200, { replies: [] });
    }
    // Rewriting whole rows.
    if (method === 'POST' && path.startsWith('/values:batchUpdate')) {
      for (const d of JSON.parse(init.body).data) {
        const r = parseRange(d.range);
        while (book[r.tab].length < r.row) book[r.tab].push([]);
        book[r.tab][r.row - 1] = d.values[0].slice();
      }
      return reply(200, {});
    }
    const append = path.match(/^\/values\/([^?:]+):append/);
    if (method === 'POST' && append) {
      const { tab } = parseRange(append[1]);
      const first = book[tab].length + 1;
      JSON.parse(init.body).values.forEach((v) => book[tab].push(v.slice()));
      return reply(200, { updates: { updatedRange: `'${tab}'!A${first}:Z${book[tab].length}` } });
    }
    const put = path.match(/^\/values\/([^?]+)/);
    if (method === 'PUT' && put) {
      const r = parseRange(put[1]);
      while (book[r.tab].length < r.row) book[r.tab].push([]);
      book[r.tab][r.row - 1] = JSON.parse(init.body).values[0].slice();
      return reply(200, {});
    }
    if (method === 'GET' && put) {
      const r = parseRange(put[1]);
      if (!book[r.tab]) return reply(400, { error: { message: `Unable to parse range: ${r.tab}` } });
      return reply(200, { values: book[r.tab].slice(r.row - 1).map((row) => row.slice()) });
    }
    throw new Error(`fake sheets: unhandled ${method} ${path}`);
  };
  return { calls };
}

module.exports = { fakeSheetsApi };
