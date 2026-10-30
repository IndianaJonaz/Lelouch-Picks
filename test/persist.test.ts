import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { kvGet, kvSet, openDb } from '../src/db.ts';
import { importInto, isSqlite, restoreSnapshot, snapshotBytes, Snapshotter, type SnapshotStore } from '../src/persist.ts';
import { Auth } from '../src/auth.ts';
import { Resolver } from '../src/resolve.ts';
import { createServer } from '../src/server.ts';
import { Headlines } from '../src/news.ts';
import { makeCtx } from './helpers.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'phq-persist-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** In-memory stand-in for the Postgres app_snapshot row. */
function fakeStore(fail = false) {
  const s = { row: null as Buffer | null, saves: 0, fail };
  const store: SnapshotStore = {
    async load() { return s.row ? Buffer.from(s.row) : null; },
    async save(d) { if (s.fail) throw new Error('pg down'); s.row = Buffer.from(d); s.saves++; },
    async close() {},
  };
  return { s, store };
}

const addSlip = (db: ReturnType<typeof openDb>, id: string) => {
  db.prepare(`INSERT INTO slips (id, user_id, user_name) VALUES (?, 'u1', 'Lelouch')`).run(id);
  db.prepare(`INSERT INTO legs (slip_id, idx, league, type, raw) VALUES (?, 0, 'nba', 'ml', 'MIA ML')`).run(id);
};

test('snapshot round trip: save from one DB file, restore into a fresh path before openDb', async () => {
  const { s, store } = fakeStore();
  const a = openDb(path.join(dir, 'a.db'));
  addSlip(a, 'AAA111'); kvSet(a, 'app_secret', 'xyz');
  const snap = new Snapshotter(a, store);
  assert.equal(await snap.saveNow(), true);
  assert.ok(s.row && isSqlite(s.row));
  a.close();

  const fresh = path.join(dir, 'restored', 'picks.db'); // ephemeral disk wiped: directory doesn't even exist
  writeFileSync(path.join(dir, 'stale.db-wal'), 'junk');
  assert.ok((await restoreSnapshot(store, fresh)) > 0);
  const b = openDb(fresh);
  assert.equal((b.prepare('SELECT COUNT(*) n FROM slips').get() as any).n, 1);
  assert.equal((b.prepare('SELECT raw FROM legs').get() as any).raw, 'MIA ML');
  assert.equal(kvGet(b, 'app_secret'), 'xyz');
  b.close();
  assert.equal(await restoreSnapshot(fakeStore().store, path.join(dir, 'none.db')), 0); // no row => normal open
});

test('snapshotter: debounces writes, skips identical bytes, flush saves on shutdown, errors fail soft', async () => {
  const { s, store } = fakeStore();
  let now = 0;
  const db = openDb(':memory:');
  const snap = new Snapshotter(db, store, { quietMs: 5000, maxWaitMs: 60_000, now: () => now });
  await snap.saveNow(); assert.equal(s.saves, 1);
  assert.equal(await snap.tick(), false); // nothing changed
  addSlip(db, 'B1');
  now = 1000; assert.equal(await snap.tick(), false); // still within quiet window
  now = 7000; assert.equal(await snap.tick(), true); assert.equal(s.saves, 2);
  // a write that leaves identical bytes doesn't re-upload
  db.prepare(`UPDATE slips SET user_name = user_name`).run();
  now = 20_000; await snap.tick(); now = 30_000; await snap.tick(); assert.equal(s.saves, 2);
  // constant writes still save once maxWait elapses
  for (let t = 31_000; t <= 95_000; t += 2000) { now = t; addSlip(db, 'C' + t); await snap.tick(); }
  assert.ok(s.saves >= 3);
  addSlip(db, 'LAST');
  assert.equal(await snap.flush(1000), true);
  const restored = openDb(path.join(dir, 'flush.db')); restored.close();
  await restoreSnapshot(store, path.join(dir, 'flush.db'));
  const r = openDb(path.join(dir, 'flush.db'));
  assert.ok(r.prepare(`SELECT 1 FROM slips WHERE id = 'LAST'`).get());
  r.close();
  s.fail = true; addSlip(db, 'X');
  assert.equal(await snap.saveNow(), false); assert.equal(snap.lastError, 'pg down');
});

test('admin export/import: bearer only, raw SQLite bytes, import replaces data in place', async () => {
  const { ctx, espn, db } = makeCtx({});
  const { s, store } = fakeStore();
  const snapshots = new Snapshotter(db, store);
  const auth = new Auth(db, 'test-secret', 'America/Chicago');
  const { server } = createServer({ ctx, auth, resolver: new Resolver(espn), adminToken: 'admintok', publicUrl: 'http://localhost', groupName: 'PICKS HQ',
    headlines: new Headlines({ feeds: [] }), snapshots });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = { authorization: 'Bearer admintok' };
  try {
    addSlip(db, 'KEEP1');
    assert.equal((await fetch(base + '/api/admin/export')).status, 401);
    const ex = await fetch(base + '/api/admin/export', { headers: h });
    assert.equal(ex.status, 200);
    assert.equal(ex.headers.get('content-type'), 'application/octet-stream');
    const bytes = Buffer.from(await ex.arrayBuffer());
    assert.ok(isSqlite(bytes));

    addSlip(db, 'GONE2'); // will be replaced by the import
    assert.equal((await fetch(base + '/api/admin/import', { method: 'POST', body: bytes })).status, 401);
    const bad = await fetch(base + '/api/admin/import', { method: 'POST', headers: h, body: Buffer.from('not a database') });
    assert.equal(bad.status, 400);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM slips').get() as any).n, 2); // rejected import changed nothing
    const ok = await fetch(base + '/api/admin/import', { method: 'POST', headers: { ...h, 'content-type': 'application/octet-stream' }, body: bytes });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.tables.slips, 1); assert.equal(j.snapshotSaved, true); assert.equal(s.saves, 1);
    assert.deepEqual((db.prepare('SELECT id FROM slips').all() as any[]).map((r) => r.id), ['KEEP1']);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM legs').get() as any).n, 1);
    addSlip(db, 'AFTER3'); // DB still writable, autoincrement intact
  } finally { server.close(); ctx.engine.stop(); }
});

test('importInto rejects a non-PICKS sqlite file with broken references', () => {
  const src = openDb(path.join(dir, 'broken.db'));
  src.exec('PRAGMA foreign_keys = OFF');
  src.prepare(`INSERT INTO legs (slip_id, idx, league, type, raw) VALUES ('NOPE', 0, 'nba', 'ml', 'x')`).run();
  const bytes = snapshotBytes(src); src.close();
  const live = openDb(':memory:'); addSlip(live, 'L1');
  assert.throws(() => importInto(live, bytes, openDb), /foreign key/);
  assert.equal((live.prepare('SELECT COUNT(*) n FROM slips').get() as any).n, 1);
});
