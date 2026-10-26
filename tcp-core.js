/* Three Card Poker — the dealer. Rules, hand ranking, payouts and the table's flow.
   The same file runs on the website's server (friends' tables, up to 5 players) and inside the
   browser for solo play, so both play by exactly the same rules. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GSThree = factory();
})(typeof self !== 'undefined' ? self : this, function () {

const ROOM = { name: 'The Parlor', min: 5, max: 500, sideMax: 100, jackpotBet: 5, seats: 5 };
// the progressive: a $5 light that wins the whole meter on a 5-card royal flush (your three cards with the dealer's three)
const JACK = [['5-card royal flush', '100%']];
const JP_START = 150000, JP_HINT_MAX = 5000000;
// Pair Plus: your three cards, win or lose against the dealer
const PAIRPLUS = [['Straight flush', 40], ['Three of a kind', 30], ['Straight', 6], ['Flush', 3], ['Pair', 1]];
// Ante Bonus: paid when you play a straight or better, whatever the dealer has
const ANTEB = [['Straight flush', 5], ['Three of a kind', 4], ['Straight', 1]];
// 6-Card Bonus: the best five-card hand from your three cards and the dealer's three
const SIX = [['Royal flush', 1000], ['Straight flush', 200], ['Four of a kind', 100], ['Full house', 20], ['Flush', 15], ['Straight', 10], ['Three of a kind', 7]];
const BET_WINDOW_MS = 60000, DECIDE_MS = 30000;   // friends' tables: a minute to bet, 30 seconds to play or fold
const env = typeof process !== 'undefined' && process.env ? process.env : {};

/* ---------------- three-card hands ---------------- */
// in three-card poker a straight beats a flush, and three of a kind beats a straight
const NAMES3 = ['High card', 'Pair', 'Flush', 'Straight', 'Three of a kind', 'Straight flush'];
const PL = { 14: 'Aces', 13: 'Kings', 12: 'Queens', 11: 'Jacks', 10: 'Tens', 9: 'Nines', 8: 'Eights', 7: 'Sevens', 6: 'Sixes', 5: 'Fives', 4: 'Fours', 3: 'Threes', 2: 'Twos' };
const SG = { 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten', 9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two' };
function eval3(cs) {
  const rs = cs.map(c => c.r).sort((a, b) => b - a);
  if (cs.length < 3) { if (rs.length === 2 && rs[0] === rs[1]) return [1, rs[0]]; return [0, ...rs]; }
  const flush = cs.every(c => c.s === cs[0].s);
  let st = 0; if (new Set(rs).size === 3) { if (rs[0] - rs[2] === 2) st = rs[0]; else if (rs.join() === '14,3,2') st = 3; }   // A-2-3 is the lowest straight
  if (st && flush) return [5, st];
  if (rs[0] === rs[2]) return [4, rs[0]];
  if (st) return [3, st];
  if (flush) return [2, ...rs];
  if (rs[0] === rs[1]) return [1, rs[0], rs[2]];
  if (rs[1] === rs[2]) return [1, rs[1], rs[0]];
  return [0, ...rs];
}
const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
function name3(s) {
  switch (s[0]) {
    case 5: return s[1] === 14 ? 'Mini royal (A-K-Q suited)' : `Straight flush, ${SG[s[1]]} high`;
    case 4: return `Three ${PL[s[1]]}`;
    case 3: return `Straight, ${SG[s[1]]} high`;
    case 2: return `Flush, ${SG[s[1]]} high`;
    case 1: return `Pair of ${PL[s[1]]}`;
    default: return `${SG[s[1]]} high`;
  }
}
const cat3 = s => NAMES3[s[0]];
const qualifies = s => s[0] >= 1 || s[1] >= 12;   // the dealer needs Queen high or better

/* ---------------- five-card hands, for the 6-Card Bonus ---------------- */
const NAMES5 = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
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
function best5(cards) {
  let top = null, pick = null;
  const go = (start, chosen) => {
    if (chosen.length === 5) { const s = eval5(chosen); if (!top || cmp(s, top) > 0) { top = s; pick = chosen.slice(); } return; }
    for (let i = start; i <= cards.length - (5 - chosen.length); i++) { chosen.push(cards[i]); go(i + 1, chosen); chosen.pop(); }
  };
  go(0, []); return { score: top, cards: pick };
}
const cat5 = s => s[0] === 8 && s[1] === 14 ? 'Royal flush' : NAMES5[s[0]];
const money = n => '$' + (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/* ---------------- the jackpot: one meter for every table, and it only ever grows ---------------- */
let jackpot = JP_START;
const jp = { get: () => jackpot, set: v => { jackpot = Math.max(JP_START, +v || JP_START); },
  hint: v => { v = +v; if (Number.isFinite(v) && v > jackpot) jackpot = Math.min(v, Math.max(jackpot, JP_HINT_MAX)); } };

/* ---------------- tables ---------------- */
const rooms = new Map();
let nextId = 1;
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const broadcast = (room, m) => { for (const p of room.players.values()) send(p.ws, m); };
const NOBETS = () => ({ ante: 0, pair: 0, six: 0, jack: 0, play: 0 });
const stake = p => Object.values(p.bets).reduce((a, b) => a + b, 0);
const code4 = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms.has(c)); return c; };
const clear = room => { for (const k of ['clock', 'step', 'decide']) { clearTimeout(room[k]); room[k] = null; } };

function publicState(room) {
  return {
    t: 'state', now: Date.now(), jackpot, code: room.code, phase: room.phase, stage: room.stage, solo: room.solo,
    countdownEnds: room.countdownEnds || null, decideEnds: room.decideEnds || null,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, seat: p.seat, balance: p.balance, bets: p.bets, ready: p.ready,
      inHand: !!p.inHand, acted: !!p.acted, folded: !!p.folded, away: !!p.away })),
  };
}
const pushState = room => broadcast(room, publicState(room));

function startBetting(room) {
  clear(room); room.phase = 'betting'; room.stage = null; room.hand = null;
  // anyone who tapped "Deal me in" while the last result was showing stays ready
  for (const p of room.players.values()) { p.inHand = false; p.acted = false; p.folded = false; }
  if (!room.solo) { room.countdownEnds = Date.now() + (+env.TCP_BET_MS || BET_WINDOW_MS); room.clock = setTimeout(() => timeUp(room), room.countdownEnds - Date.now()); }
  pushState(room);
  if (room.solo) { const p = [...room.players.values()][0]; if (p && p.ready && p.bets.ante >= ROOM.min && p.balance >= p.bets.ante) deal(room); else if (p) p.ready = false; }
  else maybeDeal(room);
}
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
  // one card at a time, starting on the dealer's left (first base, seat 5) and going around, three times; the dealer's card comes last each round
  const order = [...room.players.values()].sort((a, b) => b.seat - a.seat), seats = [], dealer = [];
  for (const p of order) {
    p.inHand = p.bets.ante > 0 && p.ready; p.acted = false; p.folded = false; p.cards = p.inHand ? [] : null;
    if (p.inHand) seats.push(p.seat); else if (stake(p) > 0) { p.balance += stake(p); p.bets = NOBETS(); }
    p.jpIn = false;
  }
  for (let k = 0; k < 3; k++) { for (const p of order) if (p.inHand) p.cards.push(deck.pop()); dealer.push(deck.pop()); }
  room.hand = { dealer };
  room.phase = 'hand'; room.stage = 'decide';
  for (const p of room.players.values()) send(p.ws, { t: 'deal', seats, mine: p.inHand ? p.cards : null });
  room.step = setTimeout(() => openDecisions(room), 600);
  pushState(room);
}
function openDecisions(room) {
  if (!room.hand) return;
  clearTimeout(room.decide);
  if (!room.solo) {
    room.decideEnds = Date.now() + (+env.TCP_DECIDE_MS || DECIDE_MS);
    room.decide = setTimeout(() => { for (const p of room.players.values()) if (p.inHand && !p.acted) act(room, p, 'fold', true); }, room.decideEnds - Date.now());
  }
  pushState(room);
}
function act(room, p, a, auto) {
  if (room.phase !== 'hand' || room.stage !== 'decide' || !p.inHand || p.acted) return;
  if (a === 'play') {
    if (p.balance < p.bets.ante) return send(p.ws, { t: 'error', msg: `You need ${money(p.bets.ante)} to play.` });
    p.balance -= p.bets.ante; p.bets.play = p.bets.ante;
  } else if (a === 'fold') p.folded = true;
  else return;
  p.acted = true;
  if (auto) send(p.ws, { t: 'error', msg: 'Out of time: you folded.' });
  pushState(room);
  if ([...room.players.values()].every(q => !q.inHand || q.acted)) {
    clearTimeout(room.decide); room.decideEnds = null; room.stage = 'showdown'; pushState(room);
    room.step = setTimeout(() => showdown(room), 500);
  }
}

function settle(p, h, D, qual) {
  const b = p.bets, P = eval3(p.cards), staked = stake(p), res = p.folded ? -1 : Math.sign(cmp(P, D));
  let back = 0; const lines = [], wins = [], hits = {};
  // 6-Card Bonus: your three and the dealer's three, played or folded
  if (b.six) { const six = best5([...p.cards, ...h.dealer]), row = SIX.find(([n]) => n === cat5(six.score));
    if (row) { back += b.six * (1 + row[1]); lines.push(`6-Card ${row[0]} +${money(b.six * row[1])}`); wins.push('six'); hits.six = row[0]; } else lines.push(`6-Card −${money(b.six)}`); }
  // the progressive light: a royal flush in the best five of your three and the dealer's three wins the whole meter (folded or not)
  if (b.jack) { const six = best5([...p.cards, ...h.dealer]);
    if (cat5(six.score) === 'Royal flush') { back += b.jack + jackpot; lines.push(`JACKPOT! 5-card royal +${money(jackpot)}`); wins.push('jack'); hits.jack = 'royal'; }
    else lines.push(`Jackpot −${money(b.jack)}`); }
  if (p.folded) { lines.push(`Folded −${money(b.ante)}`); if (b.pair) lines.push(`Pair Plus −${money(b.pair)}`); }
  else {
    if (b.pair) { const row = PAIRPLUS.find(([n]) => n === cat3(P));
      if (row) { back += b.pair * (1 + row[1]); lines.push(`Pair Plus ${row[0]} +${money(b.pair * row[1])}`); wins.push('pair'); hits.pair = row[0]; } else lines.push(`Pair Plus −${money(b.pair)}`); }
    const ab = ANTEB.find(([n]) => n === cat3(P));
    if (ab) { back += b.ante * ab[1]; lines.push(`Ante Bonus ${ab[0]} +${money(b.ante * ab[1])}`); hits.anteb = ab[0]; }
    if (!qual) { back += b.ante * 2 + b.play; lines.push(`Ante +${money(b.ante)} (dealer doesn't qualify)`, 'Play pushes'); wins.push('ante'); }
    else if (res > 0) { back += b.ante * 2 + b.play * 2; lines.push(`Ante +${money(b.ante)}`, `Play +${money(b.play)}`); wins.push('ante', 'play'); }
    else if (res === 0) { back += b.ante + b.play; lines.push('Tie: Ante and Play push'); }
    else lines.push(`Ante −${money(b.ante)}`, `Play −${money(b.play)}`);
  }
  return { back, staked, net: back - staked, lines, wins, hits, res: !p.folded && !qual ? 1 : res, folded: !!p.folded, hand: name3(P) };
}
function showdown(room) {
  const h = room.hand; if (!h) return;
  const D = eval3(h.dealer), qual = qualifies(D), results = {}, hands = {};
  for (const p of room.players.values()) {
    p.ready = false;
    if (!p.inHand) continue;
    const r = settle(p, h, D, qual); p.balance += r.back; results[p.id] = r; hands[p.id] = p.cards;
    p.bets = NOBETS();
  }
  room.phase = 'result'; room.stage = 'done';
  broadcast(room, { t: 'showdown', dealer: h.dealer, dealerHand: name3(D), qual, hands, results, jackpot });
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
  pushState(room);
}
function handle(ws, msg) {
  if (!msg || typeof msg !== 'object') return;
  const me = ws.player, room = ws.room;
  if (msg.jpSeen) jp.hint(msg.jpSeen);
  switch (msg.t) {
    case 'create': {
      if (me) return;
      const code = msg.solo ? 'SOLO' + (nextId++) : code4();
      const r = { code, solo: !!msg.solo, players: new Map(), phase: 'betting', stage: null, hand: null };
      rooms.set(code, r); addPlayer(r, ws, msg); if (!r.solo) startBetting(r); return;
    }
    case 'join': {
      if (me) return;
      const r = rooms.get(String(msg.code || '').toUpperCase());
      if (!r || r.solo) return send(ws, { t: 'error', msg: 'No table with that code.' });
      const back = msg.id && r.players.get(String(msg.id).slice(0, 40));
      if (back) { clearTimeout(back.awayTimer); back.away = false; back.ws = ws; ws.player = back; ws.room = r;
        send(ws, { t: 'welcome', you: back.id, code: r.code, seat: back.seat, back: true });
        if (r.hand && back.inHand) send(ws, { t: 'deal', seats: [...r.players.values()].filter(p => p.inHand).map(p => p.seat), mine: back.cards, late: true });
        pushState(r); return; }
      return addPlayer(r, ws, msg);
    }
  }
  if (!me || !room) return;
  switch (msg.t) {
    case 'bet': {   // the whole set of your bets for this hand
      if (room.phase === 'hand' || me.ready) return pushState(room);
      const b = msg.bets || {}, ante = Math.floor(+b.ante || 0), pair = Math.floor(+b.pair || 0), six = Math.floor(+b.six || 0), jack = b.jack ? ROOM.jackpotBet : 0;
      if (ante < 0 || pair < 0 || six < 0) return;
      if (ante > ROOM.max) { send(ws, { t: 'error', msg: `The Ante maximum is ${money(ROOM.max)}.` }); return pushState(room); }
      if (pair > ROOM.sideMax || six > ROOM.sideMax) { send(ws, { t: 'error', msg: `Pair Plus and the 6-Card Bonus go up to ${money(ROOM.sideMax)}.` }); return pushState(room); }
      const want = ante + pair + six + jack, have = me.balance + stake(me);
      if (want > have) { send(ws, { t: 'error', msg: 'Not enough chips for that.' }); return pushState(room); }
      if (jack && !me.jpIn) { jackpot += jack; me.jpIn = true; }   // the $5 goes onto the meter the moment the light goes on, and stays there
      me.balance = have - want; me.bets = { ante, pair, six, jack, play: 0 };
      return pushState(room);
    }
    case 'ready': {
      if (room.phase === 'hand') return;
      if (me.bets.ante && me.bets.ante < ROOM.min) { send(ws, { t: 'error', msg: `The Ante minimum is ${money(ROOM.min)}.` }); return pushState(room); }
      if (!me.bets.ante && stake(me)) { send(ws, { t: 'error', msg: 'Put a bet on ANTE to play the hand (the bonus bets go with it).' }); return pushState(room); }
      if (me.bets.ante && me.balance < me.bets.ante) { send(ws, { t: 'error', msg: `Keep at least ${money(me.bets.ante)} back so you can make the Play bet.` }); return pushState(room); }
      me.ready = true; pushState(room);
      if (room.phase === 'betting') { if (room.solo) { if (me.bets.ante) deal(room); else me.ready = false; } else maybeDeal(room); }
      return;
    }
    case 'unready': if (room.phase !== 'hand') { me.ready = false; pushState(room); } return;
    case 'act': return act(room, me, String(msg.a));
    case 'rebuy': {
      if (room.phase === 'hand' || stake(me)) return send(ws, { t: 'error', msg: 'Clear your bets first.' });
      const a = Math.floor(+msg.amount); if (a >= 100 && a <= 1e15) me.balance = a; return pushState(room);
    }
    case 'leave': return leave(ws);
  }
}
function leave(ws) {
  const me = ws.player, room = ws.room; if (!me || !room) return;
  ws.player = null; ws.room = null;
  if (room.phase === 'hand' && me.inHand) { me.away = true; me.ws = null;   // their hand folds if they haven't decided
    if (!me.acted) act(room, me, 'fold', true);
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

return { handle, leave, rooms, settle, jp, JP_START, JACK, ROOM, PAIRPLUS, ANTEB, SIX, eval3, name3, cat3, qualifies, best5, cat5, cmp };
});
