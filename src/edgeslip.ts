// /edge pipeline shared by the bot and the local dry-run: resolve each leg once, then rate it three ways
// (Edge Engine board, ESPN game log, market consensus). Nothing is saved.
import type { ConsensusFeed, ConsensusLeg } from './consensus.ts';
import { formatEdgeAsOf, queryFromLeg, rateEdgeLegs, type EdgeQuery } from './edgerate.ts';
import type { EdgeSnapshot } from './edgeengine.ts';
import { gameFromSummary, type Espn } from './espn.ts';
import { parseLeg } from './parse.ts';
import { ratePasted } from './rate.ts';
import type { ResolvedLeg } from './resolve.ts';
import type { XaiOpts } from './slipvision.ts';
import { STATS, sportOf } from './stats.ts';
import { buildTriple, formatTripleReport, type TripleLeg } from './tripleview.ts';

export interface EdgeSlipDeps {
  espn: Espn;
  resolve: (text: string) => Promise<ResolvedLeg>;
  /** null = EDGE_EMAIL / EDGE_PASSWORD unset. */
  edge: { get(): Promise<EdgeSnapshot> } | null;
  consensus: ConsensusFeed | null;
  tz: string;
  vision?: XaiOpts | null;
}

export interface EdgeSlipResult { title: string; description: string; footer: string; legs: TripleLeg[] }

/** "Kyle Kuzma o3.5 AST". Falls back to what the user typed. */
export function tripleLabel(leg: ResolvedLeg | null, raw: string): string {
  if (!leg || leg.type !== 'prop' || !leg.player) return raw.trim().slice(0, 80);
  const def = leg.stat ? STATS[sportOf(leg.league)].find((d) => d.key === leg.stat) : null;
  const stat = def ? def.aliases[0]!.toUpperCase() : (leg.stat ?? '').toUpperCase();
  const side = leg.side === 'over' ? 'o' : leg.side === 'under' ? 'u' : '';
  return `${leg.player} ${side}${leg.line ?? '?'} ${stat}`.replace(/\s+/g, ' ').trim();
}

function blankQuery(raw: string): EdgeQuery {
  return { raw, kind: 'other', player: null, names: [], team: null, league: null, statText: null, side: null, line: null };
}

export async function rateEdgeSlip(d: EdgeSlipDeps, lines: string[]): Promise<EdgeSlipResult> {
  const memo = new Map<string, Promise<ResolvedLeg>>();
  const resolve = (text: string) => {
    const k = text.trim();
    let p = memo.get(k);
    if (!p) { p = d.resolve(k); memo.set(k, p); p.catch(() => {}); }
    return p;
  };
  const resolved: (ResolvedLeg | null)[] = [];
  for (const line of lines) resolved.push(line.trim() ? await resolve(line).catch(() => null) : null);

  const [espn, consensus, snap] = await Promise.all([
    ratePasted(d.espn, resolve, lines, d.vision),
    Promise.all(resolved.map((leg) => consensusFor(d, leg))),
    d.edge ? d.edge.get() : Promise.resolve(null),
  ]);

  const queries = lines.map((line, i) => {
    let parsed;
    try { parsed = parseLeg(line); } catch { return blankQuery(line); }
    const r = resolved[i];
    return queryFromLeg(parsed, r && parsed.type === 'prop' ? r : null);
  });
  let asOf: string | null = null;
  let edgeOff: string | null = null;
  let edgeRated = null;
  if (!d.edge) edgeOff = 'Edge is off (EDGE_EMAIL / EDGE_PASSWORD not set).';
  else {
    asOf = snap?.board ? formatEdgeAsOf(snap.board.fetchedAt, d.tz) : null;
    if (snap?.board && snap.stale && snap.error) asOf = `${asOf} · refresh failed, showing the last board`;
    if (!snap?.board) asOf = `Edge board isn't available${snap?.error ? ` (${snap.error})` : ''}`;
    edgeRated = rateEdgeLegs(queries, snap?.board?.props ?? [], { asOf });
  }
  const labels = lines.map((l, i) => tripleLabel(resolved[i] ?? null, l));
  const legs = buildTriple(labels, edgeRated?.legs ?? [], espn.legs, consensus);
  const description = formatTripleReport(legs, { edge: edgeRated, edgeOff, asOf }) || '—';
  return {
    title: 'Edge · ESPN · Consensus ratings',
    description,
    footer: 'Nothing saved · each rating is 1–10 · combined chances assume independent legs',
    legs,
  };
}

async function consensusFor(d: EdgeSlipDeps, leg: ResolvedLeg | null): Promise<ConsensusLeg | null> {
  if (!d.consensus) return null;
  if (!leg) return { score: null, p: null, sources: [], note: 'could not match this leg' };
  if (leg.type !== 'prop') return { score: null, p: null, sources: [], note: 'player props only' };
  let teamNames: { home: string; away: string } | null = null;
  if (d.consensus.oddsApiKey && leg.event_id) {
    try {
      const s = await d.espn.summary(leg.league, leg.event_id);
      const g = gameFromSummary(leg.league, s.data);
      if (g) teamNames = { home: g.home.name, away: g.away.name };
    } catch { teamNames = null; }
  }
  return d.consensus.rate({
    league: leg.league, eventId: leg.event_id, eventName: leg.event_name, athleteId: leg.athlete_id,
    player: leg.player, team: leg.team, stat: leg.stat, side: leg.side, line: leg.line,
  }, teamNames);
}
