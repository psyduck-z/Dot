/*
 * Mirror relay. Development only — nothing in the shipped app talks to this.
 *
 * The watch has no USB, no developer options and no root, so none of the usual
 * ways to see what a device is doing are available. What is available is that
 * Dot is a web app whose source we control, and that the watch can already
 * reach this machine over WiFi. So the app describes its own screen and posts
 * it here, and picks up anything queued for it to do in the reply.
 *
 * Deliberately one round trip: the watch is on a slow processor and a metered
 * radio, so the snapshot POST carries the commands back in its response rather
 * than costing a second request.
 *
 *   POST /snapshot   the watch, every tick: body is the snapshot, reply is
 *                    whatever commands were queued (and clears the queue)
 *   GET  /snapshot   what the watch last sent
 *   POST /command    queue one command for the next tick
 *   GET  /           plain-text status
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.RELAY_PORT ?? 5175);

let snapshot = null;
let received = 0;
let lastSeen = 0;
let commands = [];

function body(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      // A runaway page should not be able to exhaust this process.
      if (data.length > 4_000_000) req.destroy();
    });
    req.on('end', () => resolve(data));
  });
}

function json(res, code, value) {
  const text = JSON.stringify(value);
  res.writeHead(code, {
    'content-type': 'application/json',
    // The watch may be on a different origin to whatever is reading this.
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(text);
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (req.method === 'POST' && url === '/snapshot') {
    const raw = await body(req);
    try {
      const incoming = JSON.parse(raw);
      // A tick with nothing new leaves the DOM out to save sending it again,
      // so keep the last one rather than replacing it with nothing.
      if (incoming.unchanged && snapshot) {
        snapshot = { ...snapshot, ...incoming, html: snapshot.html };
      } else {
        snapshot = incoming;
      }
    } catch {
      snapshot = { error: 'unparseable snapshot', raw: raw.slice(0, 200) };
    }
    received++;
    lastSeen = Date.now();
    // Handing the queue back in the reply is what keeps this to one request.
    const pending = commands;
    commands = [];
    return json(res, 200, { commands: pending });
  }

  if (req.method === 'GET' && url === '/snapshot') {
    return json(res, 200, {
      snapshot,
      received,
      ageMs: lastSeen ? Date.now() - lastSeen : null,
    });
  }

  if (req.method === 'POST' && url === '/command') {
    const raw = await body(req);
    try {
      const parsed = JSON.parse(raw);
      for (const c of Array.isArray(parsed) ? parsed : [parsed]) commands.push(c);
      return json(res, 200, { queued: commands.length });
    } catch {
      return json(res, 400, { error: 'bad command json' });
    }
  }

  if (url === '/') {
    const age = lastSeen ? Math.round((Date.now() - lastSeen) / 1000) + 's ago' : 'never';
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(
      `Dot mirror relay\n  snapshots received: ${received}\n  last: ${age}\n  commands queued: ${commands.length}\n`,
    );
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Dot mirror relay\n  → http://localhost:${PORT}\n`);
});
