/* Ultimate Texas Hold'em — the dealer. Rules, hand ranking, payouts and the table's flow.
   The same file runs on the website's server (friends' tables, up to 5 players) and inside the
   browser for solo play, so both play by exactly the same rules. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GSHoldem = factory();
})(typeof self !== 'undefined' ? self : this, function () {

const ROOM = { name: 'The Salon', min: 5, max: 400, sideMax: 100, jackpotBet: 5, seats: 5 };
const BLIND = [['Royal flush', 500], ['Straight flush', 50], ['Four of a kind', 10], ['Full house', 3], ['Flush', 1.5], ['Straight', 1]];
const TRIPS = [['Royal flush', 50], ['Straight flush', 40], ['Four of a kind', 30], ['Full house', 8], ['Flush', 7], ['Straight', 4], ['Three of a kind', 3]];
const PAIRB = [['Red aces (A♥ A♦)', 50], ['Black aces (A♠ A♣)', 25], ['Ace + face card, suited', 20], ['Ace + face card', 10], ['Any other pair', 5]];
const JACK = [['Royal flush on the flop', '100%'], ['Royal flush (turn or river)', '10%'], ['Straight flush', 250], ['Four of a kind', 100], ['Full house', 10]];
const JP_START = 100000, JP_HINT_MAX = 5000000;   // the meter never goes down; a player's device may remind a restarted server how high it got
const BET_WINDOW_MS = 60000, DECIDE_MS = 30000;   // friends' tables: a minute to bet, 30 seconds per decision
const env = typeof process !== 'undefined' && process.env ? process.env : {};

/* ---------------- hand ranking: best five of seven ---------------- */
const NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
const PL = { 14: 'Aces', 13: 'Kings', 12: 'Queens', 11: 'Jacks', 10: 'Tens', 9: 'Nines', 8: 'Eights', 7: 'Sevens', 6: 'Sixes', 5: 'Fives', 4: 'Fours', 3: 'Threes', 2: 'Twos' };
const SG = { 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten', 9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two' };
function eval5(cs) {
  const rs = cs.map(c => c.r).sort((a, b) => b - a), flush = cs.every(c => c.s === cs[0].s);
  let sh = 0; if (new Set(rs).size === 5) { if (rs[0] - rs[4] === 4) sh = rs[0]; else if (rs.join() === '14,5,4,3,2') sh = 5; }
  const cnt = {}; rs.forEach(r => cnt[r] = (cnt[r] || 0) + 1);
  const g = Object.entries(cnt).map(([r, n]) => [n, +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  if (sh && flush) return [8, sh];
  if (g[0][0] === 4) return [7, g[0][1], g[1][1]];
  if (g[0][0] === 3 && g[1][0] === 2) return [6, g[0][1], g[1][1]];
  if (flush) return [5, ...rs];
  if (sh) return [4, sh];
  if (g[0][0] === 3) return [3, g[0][1], ...g.slice(1).map(x => x[1])];
  if (g[0][0] === 2 && g[1][0] === 2) return [2, g[0][1], g[1][1], g[2][1]];
  if (g[0][0] === 2) return [1, g[0][1], ...g.slice(1).map(x => x[1])];
  return [0, ...rs];
}
const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
function best(cards) {
  if (cards.length < 5) { const rs = cards.map(c => c.r).sort((a, b) => b - a); const pair = rs.length === 2 && rs[0] === rs[1]; return { score: pair ? [1, rs[0]] : [0, ...rs], cards }; }
  let top = null, pick = null;
  const go = (start, chosen) => {
    if (chosen.length === 5) { const s = eval5(chosen); if (!top || cmp(s, top) > 0) { top = s; pick = chosen.slice(); } return; }
    for (let i = start; i <= cards.length - (5 - chosen.length); i++) { chosen.push(cards[i]); go(i + 1, chosen); chosen.pop(); }
  };
  go(0, []); return { score: top, cards: pick };
}
const isRoyal = s => s[0] === 8 && s[1] === 14;
function handName(s) {
  if (isRoyal(s)) return 'Royal flush';
  switch (s[0]) {
    case 8: return `Straight flush, ${SG[s[1]]} high`;
    case 7: return `Four ${PL[s[1]]}`;
    case 6: return `Full house, ${PL[s[1]]} full of ${PL[s[2]]}`;
    case 5: return `Flush, ${SG[s[1]]} high`;
    case 4: return `Straight, ${SG[s[1]]} high`;
    case 3: return `Three ${PL[s[1]]}`;
    case 2: return `Two pair, ${PL[s[1]]} and ${PL[s[2]]}`;
    case 1: return `Pair of ${PL[s[1]]}`;
    default: return `${SG[s[1]]} high`;
  }
}
const category = s => isRoyal(s) ? 'Royal flush' : NAMES[s[0]];
function pairBonus(p) {
  const [a, b] = p, red = c => c.s === '♥' || c.s === '♦';
  if (a.r === 14 && b.r === 14) return red(a) && red(b) ? PAIRB[0] : !red(a) && !red(b) ? PAIRB[1] : PAIRB[4];
  if (a.r === b.r) return PAIRB[4];
  const other = a.r === 14 ? b : b.r === 14 ? a : null;
  if (other && other.r >= 11) return a.s === b.s ? PAIRB[2] : PAIRB[3];
  return null;
}
const money = n => '$' + (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/* ---------------- the jackpot: one meter for every table on this server ---------------- */
// it only ever grows: every $5 light adds to it, and a winner is paid without the meter dropping
let jackpot = JP_START;
const jp = { get: () => jackpot, set: v => { jackpot = Math.max(JP_START, +v || JP_START); },
  hint: v => { v = +v; if (Number.isFinite(v) && v > jackpot) jackpot = Math.min(v, Math.max(jackpot, JP_HINT_MAX)); } };

/* ---------------- tables ---------------- */
const rooms = new Map();
let nextId = 1;
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const broadcast = (room, m) => { for (const p of room.players.values()) send(p.ws, m); };
const NOBETS = () => ({ ante: 0, blind: 0, trips: 0, pair: 0, jack: 0, play: 0 });
const stake = p => Object.values(p.bets).reduce((a, b) => a + b, 0);
const code4 = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms.has(c)); return c; };
const clear = room => { for (const k of ['clock', 'step', 'decide']) { clearTimeout(room[k]); room[k] = null; } };

function publicState(room) {
  return {
    t: 'state', now: Date.now(), code: room.code, phase: room.phase, stage: room.stage, solo: room.solo, jackpot: jackpot,
    countdownEnds: room.countdownEnds || null, decideEnds: room.decideEnds || null,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, seat: p.seat, balance: p.balance, bets: p.bets, ready: p.ready,
      inHand: !!p.inHand, acted: !!p.acted, folded: !!p.folded, away: !!p.away })),
  };
}
const pushState = room => broadcast(room, publicState(room));

function startBetting(room) {
  clear(room); room.phase = 'betting'; room.stage = null; room.hand = null;
  // anyone who tapped "Deal me in" while the last result was showing stays ready (that's why it sometimes needed two taps)
  for (const p of room.players.values()) { p.inHand = false; p.acted = false; p.folded = false; }
  if (!room.solo) { room.countdownEnds = Date.now() + (+env.UTH_BET_MS || BET_WINDOW_MS); room.clock = setTimeout(() => timeUp(room), room.countdownEnds - Date.now()); }
  pushState(room);
  if (room.solo) { const p = [...room.players.values()][0]; if (p && p.ready && p.bets.ante >= ROOM.min && p.balance >= p.bets.ante) deal(room); else if (p) p.ready = false; }
  else maybeDeal(room);
}
// the betting clock ran out: deal for everyone who is ready with an Ante; anyone else sits out
function timeUp(room) {
  if (room.phase !== 'betting') return;
  for (const p of room.players.values()) if (!p.ready && stake(p) > 0) {
    p.balance += stake(p); p.bets = NOBETS();
    send(p.ws, { t: 'error', msg: "Time's up: you weren't ready, so you sit this hand out. Your chips are back." });
  }
  if ([...room.players.values()].some(p => p.ready && p.bets.ante > 0)) deal(room); else startBetting(room);
}
function maybeDeal(room) {
  if (room.phase !== 'betting') return;
  const here = [...room.players.values()].filter(p => !p.away);
  if (here.some(p => p.bets.ante > 0) && here.every(p => p.ready)) deal(room);
}

function deal(room) {
  clear(room); room.countdownEnds = null;
  const deck = []; for (const s of ['♠', '♥', '♦', '♣']) for (let r = 2; r <= 14; r++) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  // like the casino: the five board cards first, then each player's two, then the dealer's two
  const board = deck.splice(0, 5), seats = [];
  for (const p of [...room.players.values()].sort((a, b) => b.seat - a.seat)) {   // first base (the dealer's left, seat 5) gets the first card, then around the table
    p.inHand = p.bets.ante > 0 && p.ready; p.acted = false; p.folded = false; p.cards = null;
    if (p.inHand) { p.cards = deck.splice(0, 2); seats.push(p.seat); }
    else if (stake(p) > 0) { p.balance += stake(p); p.bets = NOBETS(); }
    p.jpIn = false;
  }
  room.hand = { board, dealer: deck.splice(0, 2), shown: 0 };
  room.phase = 'hand'; room.stage = 'pre';
  for (const p of room.players.values()) send(p.ws, { t: 'deal', seats, mine: p.inHand ? p.cards : null });
  room.step = setTimeout(() => openDecisions(room), 600);
  pushState(room);
}

// everyone still deciding gets a while to choose; when they're all done, the dealer moves on
function openDecisions(room) {
  const h = room.hand; if (!h) return;
  const waiting = [...room.players.values()].filter(p => p.inHand && !p.folded && !p.bets.play);
  for (const p of room.players.values()) p.acted = !waiting.includes(p);
  if (!waiting.length) return advance(room);
  clearTimeout(room.decide);
  if (!room.solo) {
    room.decideEnds = Date.now() + (+env.UTH_DECIDE_MS || DECIDE_MS);
    room.decide = setTimeout(() => {   // out of time: check (or fold on the river)
      for (const p of room.players.values()) if (p.inHand && !p.acted) act(room, p, room.stage === 'river' ? 'fold' : 'check', true);
    }, room.decideEnds - Date.now());
  }
  pushState(room);
}
const RAISES = { pre: { b4: 4, b3: 3 }, flop: { b2: 2 }, river: { b1: 1 } };
function act(room, p, a, auto) {
  if (room.phase !== 'hand' || !p.inHand || p.acted || p.folded) return;
  const x = (RAISES[room.stage] || {})[a];
  if (x) {
    const amt = p.bets.ante * x;
    if (p.balance < amt) return send(p.ws, { t: 'error', msg: `You need ${money(amt)} for that.` });
    p.balance -= amt; p.bets.play = amt;
  } else if (a === 'fold') { if (room.stage !== 'river') return; p.folded = true; }
  else if (a !== 'check' || room.stage === 'river') return;
  p.acted = true;
  if (auto) send(p.ws, { t: 'error', msg: a === 'fold' ? 'Out of time: you folded.' : 'Out of time: you checked.' });
  pushState(room);
  if ([...room.players.values()].every(q => !q.inHand || q.acted)) { clearTimeout(room.decide); room.decideEnds = null; room.step = setTimeout(() => advance(room), 500); }
}
// turn the next board cards over, ask the next question, or go to the showdown
function advance(room) {
  const h = room.hand; if (!h) return;
  const deciding = [...room.players.values()].some(p => p.inHand && !p.folded && !p.bets.play);
  if (room.stage === 'pre' && deciding) { h.shown = 3; room.stage = 'flop'; broadcast(room, { t: 'board', n: 3, cards: h.board.slice(0, 3) }); room.step = setTimeout(() => openDecisions(room), 2400); }
  else if (room.stage !== 'river' && deciding) { h.shown = 5; room.stage = 'river'; broadcast(room, { t: 'board', n: 5, cards: h.board }); room.step = setTimeout(() => openDecisions(room), 2200); }
  else {
    const wait = h.shown < 5 ? 2600 : 600;
    if (h.shown < 5) { h.shown = 5; broadcast(room, { t: 'board', n: 5, cards: h.board }); }
    room.stage = 'showdown'; pushState(room);
    room.step = setTimeout(() => showdown(room), wait);
  }
}

function settle(p, h, D, qual) {
  const b = p.bets, P = best([...p.cards, ...h.board]), staked = stake(p);
  const res = p.folded ? -1 : Math.sign(cmp(P.score, D.score));
  let back = 0; const lines = [], wins = [], hits = {};
  if (b.trips) { const row = TRIPS.find(([n]) => n === category(P.score));
    if (row) { back += b.trips * (1 + row[1]); lines.push(`Trips ${row[0]} +${money(b.trips * row[1])}`); wins.push('trips'); hits.trips = row[0]; } else lines.push(`Trips −${money(b.trips)}`); }
  if (b.pair) { const pb = pairBonus(p.cards);
    if (pb) { back += b.pair * (1 + pb[1]); lines.push(`Pair Bonus ${pb[0]} +${money(b.pair * pb[1])}`); wins.push('pair'); hits.pair = pb[0]; } else lines.push(`Pair Bonus −${money(b.pair)}`); }
  if (b.jack) {
    const flopRoyal = isRoyal(eval5([...p.cards, ...h.board.slice(0, 3)])), cat = category(P.score); let pay = 0, row = null;
    if (flopRoyal) { row = JACK[0]; pay = jackpot; }                                   // the whole meter is paid, and the meter keeps going
    else if (cat === 'Royal flush') { row = JACK[1]; pay = Math.round(jackpot * 10) / 100; }
    else { row = JACK.find(([n]) => n === cat) || null; if (row) pay = b.jack * row[1]; }
    if (row) { back += b.jack + pay; lines.push(`Jackpot ${row[0]} +${money(pay)}`); wins.push('jack'); hits.jack = row[0]; } else lines.push(`Jackpot −${money(b.jack)}`);
  }
  if (p.folded) lines.push(`Folded −${money(b.ante + b.blind)}`);
  else if (res > 0) {
    if (qual) { back += b.ante * 2; lines.push(`Ante +${money(b.ante)}`); wins.push('ante'); } else { back += b.ante; lines.push("Ante pushes (dealer didn't qualify)"); }
    back += b.play * 2; lines.push(`Play +${money(b.play)}`); wins.push('play');
    const row = BLIND.find(([n]) => n === category(P.score));
    if (row) { back += b.blind * (1 + row[1]); lines.push(`Blind ${row[0]} +${money(b.blind * row[1])}`); wins.push('blind'); hits.blind = row[0]; } else { back += b.blind; lines.push('Blind pushes'); }
  } else if (res === 0) { back += b.ante + b.blind + b.play; lines.push('Tie: Ante, Blind and Play push'); }
  else { if (!qual) { back += b.ante; lines.push("Ante pushes (dealer didn't qualify)"); } else lines.push(`Ante −${money(b.ante)}`);
    lines.push(`Blind −${money(b.blind)}`); if (b.play) lines.push(`Play −${money(b.play)}`); }
  return { back, staked, net: back - staked, lines, wins, hits, res, folded: !!p.folded, hand: handName(P.score), best: P.cards, cat: category(P.score) };
}
function showdown(room) {
  const h = room.hand; if (!h) return;
  const D = best([...h.dealer, ...h.board]), qual = D.score[0] >= 1, results = {}, hands = {};
  for (const p of room.players.values()) {
    p.ready = false;
    if (!p.inHand) continue;
    const r = settle(p, h, D, qual); p.balance += r.back; results[p.id] = r; hands[p.id] = p.cards;
    p.bets = NOBETS();
  }
  room.phase = 'result'; room.stage = 'done';
  broadcast(room, { t: 'showdown', dealer: h.dealer, board: h.board, dealerHand: handName(D.score), dealerBest: D.cards, qual, hands, results, jackpot });
  pushState(room);
  room.step = setTimeout(() => startBetting(room), room.solo ? 1500 : 8000);
}

/* ---------------- messages from players ---------------- */
function seatFor(room) { const used = new Set([...room.players.values()].map(p => p.seat)); for (const s of [2, 1, 3, 0, 4]) if (!used.has(s)) return s; return -1; }
function addPlayer(room, ws, msg) {
  const seat = seatFor(room); if (seat < 0) return send(ws, { t: 'error', msg: 'That table is full (5 players).' });
  const bank = Math.floor(Number(msg.bankroll));
  const p = { id: 'p' + (nextId++) + Math.random().toString(36).slice(2, 10), name: String(msg.name || 'Player').slice(0, 14) || 'Player', seat,
    balance: Number.isFinite(bank) && bank >= 0 ? Math.min(1e15, bank) : 1000, bets: NOBETS(), ready: false, ws };
  room.players.set(p.id, p); ws.player = p; ws.room = room;
  send(ws, { t: 'welcome', you: p.id, code: room.code, seat, solo: room.solo });
  if (!room.solo) broadcast(room, { t: 'chat', text: `${p.name} sat down in seat ${seat + 1}.` });
  if (room.phase === 'betting' && !room.solo && !room.clock) startBetting(room); else pushState(room);
}
function handle(ws, msg) {
  if (!msg || typeof msg !== 'object') return;
  const me = ws.player, room = ws.room;
  if (msg.jpSeen) jp.hint(msg.jpSeen);
  switch (msg.t) {
    case 'create': {
      if (me) return;
      const code = msg.solo ? 'SOLO' + (nextId++) : code4();
      const r = { code, solo: !!msg.solo, open: msg.open === true /* private by default: friends join with the code */, players: new Map(), phase: 'betting', stage: null, hand: null };
      rooms.set(code, r); addPlayer(r, ws, msg); if (!r.solo) startBetting(r); else pushState(r); return;
    }
    case 'join': {
      if (me) return;
      const r = rooms.get(String(msg.code || '').toUpperCase());
      if (!r || r.solo) return send(ws, { t: 'error', msg: 'No table with that code.' });
      const back = msg.id && r.players.get(String(msg.id).slice(0, 40));
      if (back) { clearTimeout(back.awayTimer); back.away = false; back.ws = ws; ws.player = back; ws.room = r;
        send(ws, { t: 'welcome', you: back.id, code: r.code, seat: back.seat, back: true });
        if (r.hand && back.inHand) send(ws, { t: 'deal', seats: [...r.players.values()].filter(p => p.inHand).map(p => p.seat), mine: back.cards, late: true, board: r.hand.board.slice(0, r.hand.shown) });
        pushState(r); return; }
      return addPlayer(r, ws, msg);
    }
    case 'list': return send(ws, { t: 'tables', tables: [...rooms.values()].filter(r => !r.solo && r.open && r.players.size < ROOM.seats)
      .map(r => ({ code: r.code, players: r.players.size, max: ROOM.seats, host: ([...r.players.values()][0] || {}).name || 'Someone', playing: r.phase !== 'betting' })) });
  }
  if (!me || !room) return;
  switch (msg.t) {
    case 'bet': {   // the whole set of your bets for this hand
      if (room.phase === 'hand' || me.ready) return pushState(room);
      const b = msg.bets || {}, ante = Math.floor(+b.ante || 0), trips = Math.floor(+b.trips || 0), pair = Math.floor(+b.pair || 0), jack = b.jack ? ROOM.jackpotBet : 0;
      if (ante < 0 || trips < 0 || pair < 0) return;
      if (ante > ROOM.max) { send(ws, { t: 'error', msg: `The Ante and Blind maximum is ${money(ROOM.max)} each.` }); return pushState(room); }
      if (trips > ROOM.sideMax || pair > ROOM.sideMax) { send(ws, { t: 'error', msg: `Trips and Pair Bonus go up to ${money(ROOM.sideMax)}.` }); return pushState(room); }
      const want = ante * 2 + trips + pair + jack, have = me.balance + stake(me);
      if (want > have) { send(ws, { t: 'error', msg: 'Not enough chips for that.' }); return pushState(room); }
      if (jack && !me.jpIn) { jackpot += jack; me.jpIn = true; }   // the $5 goes onto the meter the moment the light goes on, and stays there
      me.balance = have - want; me.bets = { ante, blind: ante, trips, pair, jack, play: 0 };
      if (room.phase === 'result') { /* bets for the next hand */ }
      return pushState(room);
    }
    case 'ready': {
      if (room.phase === 'hand') return;
      if (me.bets.ante && me.bets.ante < ROOM.min) { send(ws, { t: 'error', msg: `The Ante minimum is ${money(ROOM.min)}.` }); return pushState(room); }
      if (me.bets.ante && me.balance < me.bets.ante) { send(ws, { t: 'error', msg: `Keep at least ${money(me.bets.ante)} back so you can make a Play bet at the end.` }); return pushState(room); }
      me.ready = true; pushState(room);
      if (room.phase === 'betting') { if (room.solo) { if (me.bets.ante) deal(room); else me.ready = false; } else maybeDeal(room); }
      return;
    }
    case 'unready': if (room.phase !== 'hand') { me.ready = false; pushState(room); } return;
    case 'act': return act(room, me, String(msg.a));
    case 'rebuy': {   // the buy-in: set your chips (between hands)
      if (room.phase === 'hand' || stake(me)) return send(ws, { t: 'error', msg: 'Clear your bets first.' });
      const a = Math.floor(+msg.amount); if (a >= 100 && a <= 1e15) me.balance = a; return pushState(room);
    }
    case 'leave': return leave(ws);
  }
}
function leave(ws) {
  const me = ws.player, room = ws.room; if (!me || !room) return;
  ws.player = null; ws.room = null;
  if (room.phase === 'hand' && me.inHand) { me.away = true; me.ws = null;   // their hand plays out: checks, then folds on the river
    if (!me.acted) act(room, me, room.stage === 'river' ? 'fold' : 'check', true);
    me.awayTimer = setTimeout(() => remove(room, me), 60000); return; }
  remove(room, me);
}
function remove(room, me) {
  if (room.players.get(me.id) !== me) return;
  room.players.delete(me.id);
  if (!room.players.size) { clear(room); rooms.delete(room.code); return; }
  broadcast(room, { t: 'chat', text: `${me.name} left the table.` });
  pushState(room); if (room.phase === 'betting') maybeDeal(room);
}

return { handle, leave, rooms, ROOM, BLIND, TRIPS, PAIRB, JACK, JP_START, jp, eval5, best, cmp, handName, category, isRoyal, pairBonus };
});
