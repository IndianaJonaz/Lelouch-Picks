import { readFileSync } from 'node:fs';
import { openDb, type Leg } from '../src/db.ts';
import { Espn } from '../src/espn.ts';
import { Engine } from '../src/engine.ts';
import type { Ctx } from '../src/views.ts';

export const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

/** ESPN client backed by fixtures; `routes` maps URL substrings to payloads (or Errors to simulate a down feed). */
export function fakeEspn(routes: Record<string, unknown>) {
  return new Espn(async (url: string) => {
    for (const [k, v] of Object.entries(routes)) if (url.includes(k)) { if (v instanceof Error) throw v; return structuredClone(v); }
    throw new Error(`HTTP 404 (no fixture for ${url})`);
  });
}

export function makeCtx(routes: Record<string, unknown> = {}) {
  const db = openDb(':memory:');
  const espn = fakeEspn(routes);
  const engine = new Engine(db, espn, { liveMs: 1000, idleMs: 1000 });
  const ctx: Ctx = { db, espn, engine, tz: 'America/Chicago', leagues: ['nba', 'nfl', 'nhl'], demo: false, bot: () => ({ status: 'idle', detail: null, tag: null }) };
  return { db, espn, engine, ctx };
}

export function leg(p: Partial<Leg>): Leg {
  return { id: 1, slip_id: 'X', idx: 0, league: 'nba', event_id: 'E', event_name: 'A @ B', start_time: null, type: 'prop', team: null, player: null, athlete_id: null,
    stat: null, side: null, line: null, odds: null, status: 'pending', actual: null, detail: null, raw: '', graded_at: null, ...p };
}
