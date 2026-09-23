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
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = Number(process.env.RELAY_PORT ?? 5175);

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
/**
 * Both, because the stylesheet lives in index.html rather than the bundle. A
 * stamp taken from bundle.js alone meant every change to the styling — which is
 * most of what a layout pass consists of — silently failed to reach the device.
 */
const WATCHED = [path.join(PUBLIC, 'bundle.js'), path.join(PUBLIC, 'index.html')];

/**
 * When the bundle was last written.
 *
 * Reported to the device so it can notice a rebuild and reload itself. A
 * modification time rather than a build id because esbuild fixes `define`
 * values when the watch context is created, so a stamp compiled into the
 * bundle would be identical across every rebuild of a session — which is
 * precisely the case this needs to detect.
 *
 * The device compares it against the first value it saw rather than against a
 * clock, so the two machines' clocks never have to agree.
 */
function bundleStamp() {
  let newest = 0;
  for (const file of WATCHED) {
    try {
      newest = Math.max(newest, statSync(file).mtimeMs);
    } catch {
      /* a file that is not there cannot have changed */
    }
  }
  return newest;
}

let snapshot = null;
let received = 0;
let lastSeen = 0;
let commands = [];

function body(req) {
  return new Promise((resolve) => {
    // Collected as buffers and decoded once at the end. Appending each chunk to
    // a string decodes it in isolation, so any character whose bytes happen to
    // straddle a chunk boundary is destroyed — which showed up as the Shorts
    // "next" arrow arriving as two replacement characters, and had me looking
    // for a bug in the app when the source bytes were correct all along.
    // Anything non-ASCII in a title or a diagnostic was at risk of the same.
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      // A runaway page should not be able to exhaust this process.
      if (size > 4_000_000) req.destroy();
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
    // A gap means this is a device arriving rather than one already talking,
    // and that is the event worth seeing in the log — "is it connected yet" was
    // otherwise only answerable by refreshing a page and squinting at a number.
    const gap = Date.now() - lastSeen;
    if (!lastSeen || gap > 10_000) {
      const who = req.socket.remoteAddress ?? 'unknown';
      console.log(`  * connected  ${who}  ${snapshot?.width ?? '?'}x${snapshot?.height ?? '?'}`);
    }
    received++;
    lastSeen = Date.now();
    // Handing the queue back in the reply is what keeps this to one request.
    const pending = commands;
    commands = [];
    return json(res, 200, { commands: pending, bundle: bundleStamp() });
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
    const since = lastSeen ? Date.now() - lastSeen : null;
    // "Live" is a judgement, and a timestamp is what whoever is asking this
    // question would have to turn into one themselves. Do it for them.
    const state =
      since === null
        ? 'WAITING - no device has ever connected'
        : since < 5000
          ? 'LIVE - a device is mirroring now'
          : 'STALE - last seen ' + Math.round(since / 1000) + 's ago';
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(
      `Dot mirror relay\n\n  ${state}\n\n  snapshots received: ${received}\n  commands queued: ${commands.length}\n`,
    );
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Dot mirror relay\n  → http://localhost:${PORT}\n`);
});
