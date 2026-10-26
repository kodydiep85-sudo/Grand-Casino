/* Face Up Pai Gow Poker — the dealer. A 53-card deck with the Joker, hand ranking, the House Way, payouts and the table's flow.
   The dealer's seven cards are dealt face up and set the House Way; there's no commission, and when the dealer's hand
   is an Ace-high pai gow (no pair), every main bet pushes. The same file runs on the website's server (friends' tables,
   up to 5 players) and inside the browser for solo play. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GSPaiGow = factory();
})(typeof self !== 'undefined' ? self : this, function () {

const ROOM = { name: 'The Pavilion', min: 5, max: 500, sideMax: 100, jackpotBet: 5, seats: 5 };
// Bonus: your seven cards, win or lose (the standard Fortune pay table)
const BONUS = [['7-card straight flush', 8000], ['7-card straight flush with the Joker', 1000], ['Five aces', 400], ['Royal flush', 150],
  ['Straight flush', 50], ['Four of a kind', 25], ['Full house', 5], ['Flush', 4], ['Three of a kind', 3], ['Straight', 2]];
// Ace High: the dealer's hand is an Ace-high pai gow; more when yours is too
const ACEHIGH = [['Dealer and you both Ace-high pai gow', 40], ['Dealer Ace-high pai gow', 6]];
// the progressive light: $5, paid on your seven cards
const JACK = [['7-card straight flush', '100%'], ['7-card straight flush with the Joker', '10%'], ['Five aces', 500], ['Royal flush', 150], ['Straight flush', 50], ['Four of a kind', 20]];
const JP_START = 100000, JP_HINT_MAX = 5000000;
const BET_WINDOW_MS = 60000, SET_MS = 45000;   // friends' tables: a minute to bet, 45 seconds to set your hand (then the House Way sets it)
const env = typeof process !== 'undefined' && process.env ? process.env : {};

/* ---------------- cards and hand ranking ---------------- */
const JOKER = { r: 15, s: '★', j: true };
const SUITS = ['♠', '♥', '♦', '♣'];
const NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush', 'Five aces'];
const PL = { 14: 'Aces', 13: 'Kings', 12: 'Queens', 11: 'Jacks', 10: 'Tens', 9: 'Nines', 8: 'Eights', 7: 'Sevens', 6: 'Sixes', 5: 'Fives', 4: 'Fours', 3: 'Threes', 2: 'Twos' };
const SG = { 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten', 9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two' };
const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
// five natural cards. In pai gow A-2-3-4-5 is the second-best straight (just under A-K-Q-J-10)
function eval5n(cs) {
  const rs = cs.map(c => c.r).sort((a, b) => b - a), flush = cs.every(c => c.s === cs[0].s);
  let st = 0; if (new Set(rs).size === 5) { if (rs[0] - rs[4] === 4) st = rs[0]; else if (rs.join() === '14,5,4,3,2') st = 13.5; }
  const cnt = {}; rs.forEach(r => cnt[r] = (cnt[r] || 0) + 1);
  const g = Object.entries(cnt).map(([r, n]) => [n, +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  if (st && flush) return [8, st];
  if (g[0][0] === 4) return [7, g[0][1], g[1][1]];
  if (g[0][0] === 3 && g[1][0] === 2) return [6, g[0][1], g[1][1]];
  if (flush) return [5, ...rs];
  if (st) return [4, st];
  if (g[0][0] === 3) return [3, g[0][1], ...g.slice(1).map(x => x[1])];
  if (g[0][0] === 2 && g[1][0] === 2) return [2, g[0][1], g[1][1], g[2][1]];
  if (g[0][0] === 2) return [1, g[0][1], ...g.slice(1).map(x => x[1])];
  return [0, ...rs];
}
// with the Joker: it counts as an Ace, or completes a straight, a flush or a straight flush
const SUBS = []; for (const s of SUITS) for (let r = 2; r <= 14; r++) SUBS.push({ r, s });
function eval5(cs) {
  const j = cs.findIndex(c => c.j); if (j < 0) return eval5n(cs);
  const rest = cs.filter((c, i) => i !== j);
  if (rest.filter(c => c.r === 14).length === 4) return [9];   // five aces: the best hand there is
  let top = null;
  for (const sub of SUBS) {
    const sc = eval5n([...rest, sub]);
    if (sub.r !== 14 && ![4, 5, 8].includes(sc[0])) continue;
    if (!top || cmp(sc, top) > 0) top = sc;
  }
  return top;
}
// the two-card hand: a pair, or two high cards (the Joker is an Ace here)
function eval2(cs) { const rs = cs.map(c => c.j ? 14 : c.r).sort((a, b) => b - a); return rs[0] === rs[1] ? [1, rs[0]] : [0, rs[0], rs[1]]; }
function best5(cards) {
  let top = null, pick = null;
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {   // leave out two of the seven
    const five = cards.filter((c, i) => i !== a && i !== b), s = eval5(five);
    if (!top || cmp(s, top) > 0) { top = s; pick = five; }
  }
  return { score: top, cards: pick };
}
function name5(s) {
  switch (s[0]) {
    case 9: return 'Five aces';
    case 8: return s[1] === 14 ? 'Royal flush' : `Straight flush, ${s[1] === 13.5 ? 'A-2-3-4-5' : SG[s[1]] + ' high'}`;
    case 7: return `Four ${PL[s[1]]}`;
    case 6: return `Full house, ${PL[s[1]]} over ${PL[s[2]]}`;
    case 5: return `Flush, ${SG[s[1]]} high`;
    case 4: return `Straight, ${s[1] === 13.5 ? 'A-2-3-4-5' : SG[s[1]] + ' high'}`;
    case 3: return `Three ${PL[s[1]]}`;
    case 2: return `Two pair, ${PL[s[1]]} and ${PL[s[2]]}`;
    case 1: return `Pair of ${PL[s[1]]}`;
    default: return `${SG[s[1]]} high`;
  }
}
const name2 = s => s[0] === 1 ? `Pair of ${PL[s[1]]}` : `${SG[s[1]]}-${SG[s[2]]}`;
const cat5 = s => s[0] === 8 && s[1] === 14 ? 'Royal flush' : NAMES[s[0]];
// a seven-card straight flush: all seven cards in one suit and in a row (the Joker can fill one gap)
function sevenSF(cards) {
  const jk = cards.some(c => c.j), nat = cards.filter(c => !c.j);
  if (!nat.every(c => c.s === nat[0].s)) return null;
  const rs = [...new Set(nat.map(c => c.r))]; if (rs.length !== nat.length) return null;
  const fits = arr => { arr = [...arr].sort((a, b) => a - b); const span = arr[arr.length - 1] - arr[0] + 1; return jk ? span <= 7 : span === 7; };
  if (fits(rs) || (rs.includes(14) && fits(rs.map(r => r === 14 ? 1 : r)))) return jk ? 'joker' : 'natural';
  return null;
}
// what the seven cards make, for the Bonus and the progressive
function sevenHand(cards) {
  const s7 = sevenSF(cards); if (s7) return s7 === 'natural' ? '7-card straight flush' : '7-card straight flush with the Joker';
  const b = best5(cards).score; return b[0] === 9 ? 'Five aces' : cat5(b);
}
// an Ace-high pai gow: nothing better than Ace high in all seven cards
const aceHighPaiGow = cards => { const b = best5(cards).score; return b[0] === 0 && b[1] === 14; };
function legal(high, low) {   // the five-card hand has to beat the two-card hand
  const H = eval5(high), L = eval2(low);
  if (H[0] !== L[0]) return H[0] > L[0];
  if (L[0] === 1) return H[1] > L[1] || (H[1] === L[1]);
  for (let i = 1; i < 3; i++) { if (H[i] !== L[i]) return H[i] > L[i]; }
  return true;
}

/* ---------------- the House Way ---------------- */
// the dealer sets every hand this way; it's also what the House Way button does for you
function houseWay(cards) {
  const idx = [0, 1, 2, 3, 4, 5, 6];
  const rv = i => cards[i].j ? 14 : cards[i].r;
  const jk = cards.findIndex(c => c.j);
  const groups = {}; idx.forEach(i => { const r = rv(i); (groups[r] = groups[r] || []).push(i); });
  const byCount = n => Object.entries(groups).filter(([r, g]) => g.length === n).map(([r]) => +r).sort((a, b) => b - a);
  const quads = byCount(4).concat(byCount(5)), trips = byCount(3), pairs = byCount(2);
  const singlesDesc = used => idx.filter(i => !used.includes(i)).sort((a, b) => rv(b) - rv(a) || (cards[a].j ? -1 : 0));
  const done = low => { const high = idx.filter(i => !low.includes(i)); return { low, high }; };
  const frontBest = used => singlesDesc(used).slice(0, 2);
  // straights and flushes that could be played behind, with whatever's left in front
  const sfOptions = () => {
    const out = [];
    for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) {
      const high = idx.filter(i => i !== a && i !== b), sc = eval5(high.map(i => cards[i]));
      if (sc[0] >= 4 && sc[0] !== 6 && sc[0] !== 7 && sc[0] !== 9) out.push({ low: [a, b], sc, front: eval2([cards[a], cards[b]]) });
    }
    return out.sort((x, y) => cmp(y.front, x.front) || cmp(y.sc, x.sc));
  };
  let pick = null;
  if (byCount(5).length) {   // five aces: a pair of Aces in front
    const g = groups[14]; pick = done([g[0], g[1]]);
  } else if (quads.length) {
    const q = quads[0], g = groups[q];
    if (pairs.length || trips.length) { const r = trips.length ? trips[0] : pairs[0]; pick = done(groups[r].slice(0, 2)); }   // quads and a pair: the pair goes in front
    else if (q <= 6) pick = done(frontBest(g));                                                                          // small quads stay together
    else if (q <= 10 && singlesDesc(g).some(i => rv(i) === 14)) pick = done(frontBest(g));                              // middle quads with an Ace to play in front
    else pick = done([g[0], g[1]]);                                                                                      // split them: a pair in each hand
  } else if (trips.length >= 2) {
    pick = done(groups[trips[0]].slice(0, 2));   // two sets of three: the higher pair goes in front
  } else if (trips.length && pairs.length) {
    pick = done(groups[pairs[0]].slice(0, 2));   // full house: the pair in front, unless there's a choice of pairs (the higher one)
  } else {
    const sf = sfOptions();
    if (pairs.length >= 3) pick = done(groups[pairs[0]].slice(0, 2));   // three pair: the highest pair in front
    else if (sf.length && (pairs.length === 0 || sf[0].front[0] === 1 || pairs.length === 1)) {
      // a straight or flush behind, keeping the best two cards for the front (a pair in front if one's left)
      pick = done(sf[0].low);
    } else if (trips.length) {
      const t = trips[0], g = groups[t];
      if (t === 14) pick = done([g[0], singlesDesc(g)[0]]);   // three Aces: one Ace in front
      else pick = done(frontBest(g));
    } else if (pairs.length === 2) {
      const [H, L] = pairs, keep = [...groups[H], ...groups[L]], aceSingle = singlesDesc(keep).some(i => rv(i) === 14);
      const together = H !== 14 && aceSingle && (H <= 10 || L <= 5);
      pick = together ? done(frontBest(keep)) : done(groups[L].slice(0, 2));
    } else if (pairs.length === 1) {
      pick = done(frontBest(groups[pairs[0]]));
    } else {
      const s = singlesDesc([]); pick = done([s[1], s[2]]);   // pai gow: the highest card behind, the next two in front
    }
  }
  if (!pick || !legal(pick.high.map(i => cards[i]), pick.low.map(i => cards[i]))) {   // safety net: the best legal split
    let best = null;
    for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) {
      const low = [a, b], high = idx.filter(i => i !== a && i !== b);
      if (!legal(high.map(i => cards[i]), low.map(i => cards[i]))) continue;
      const f = eval2(low.map(i => cards[i])), h = eval5(high.map(i => cards[i]));
      if (!best || cmp(f, best.f) > 0 || (cmp(f, best.f) === 0 && cmp(h, best.h) > 0)) best = { low, high, f, h };
    }
    pick = { low: best.low, high: best.high };
  }
  return pick;
}

// the help button: with the dealer's hand face up, the best way to set yours against it
// (win both if you can, a push if not; the House Way when it's just as good)
function bestVsDealer(cards, dealer, ds) {
  const dH = eval5(ds.high.map(i => dealer[i])), dL = eval2(ds.low.map(i => dealer[i])), idx = [0, 1, 2, 3, 4, 5, 6];
  const score = s => { const h = cmp(eval5(s.high.map(i => cards[i])), dH) > 0, l = cmp(eval2(s.low.map(i => cards[i])), dL) > 0; return h && l ? 2 : h || l ? 1 : 0; };
  const hw = houseWay(cards); let best = hw, top = score(hw);
  if (top === 2) return hw;
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) {
    const s = { low: [a, b], high: idx.filter(i => i !== a && i !== b) };
    if (!legal(s.high.map(i => cards[i]), s.low.map(i => cards[i]))) continue;
    const v = score(s); if (v > top) { top = v; best = s; if (v === 2) return best; }
  }
  return best;
}

/* ---------------- the jackpot: one meter for every table, and it only ever grows ---------------- */
let jackpot = JP_START;
const jp = { get: () => jackpot, set: v => { jackpot = Math.max(JP_START, +v || JP_START); },
  hint: v => { v = +v; if (Number.isFinite(v) && v > jackpot) jackpot = Math.min(v, Math.max(jackpot, JP_HINT_MAX)); } };

/* ---------------- tables ---------------- */
const rooms = new Map();
let nextId = 1;
const money = n => '$' + (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const broadcast = (room, m) => { for (const p of room.players.values()) send(p.ws, m); };
const NOBETS = () => ({ main: 0, bonus: 0, ace: 0, jack: 0 });
const stake = p => Object.values(p.bets).reduce((a, b) => a + b, 0);
const code4 = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms.has(c)); return c; };
const clear = room => { for (const k of ['clock', 'step', 'timer']) { clearTimeout(room[k]); room[k] = null; } };
const later = (room, fn, ms) => { clearTimeout(room.step); room.step = setTimeout(fn, ms); };

function publicState(room) {
  return {
    t: 'state', now: Date.now(), jackpot, code: room.code, phase: room.phase, stage: room.stage, solo: room.solo,
    countdownEnds: room.countdownEnds || null, timerEnds: room.timerEnds || null,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, seat: p.seat, balance: p.balance, bets: p.bets, ready: p.ready,
      inHand: !!p.inHand, set: !!p.setDone, away: !!p.away })),
  };
}
const pushState = room => broadcast(room, publicState(room));

function startBetting(room) {
  clear(room); room.phase = 'betting'; room.stage = null; room.hand = null; room.timerEnds = null;
  for (const p of room.players.values()) { p.inHand = false; p.setDone = false; p.cards = null; p.split = null; }
  if (!room.solo) { room.countdownEnds = Date.now() + (+env.PG_BET_MS || BET_WINDOW_MS); room.clock = setTimeout(() => timeUp(room), room.countdownEnds - Date.now()); }
  pushState(room);
  if (room.solo) { const p = [...room.players.values()][0]; if (p && p.ready && p.bets.main >= ROOM.min) deal(room); else if (p) p.ready = false; }
  else maybeDeal(room);
}
function timeUp(room) {
  if (room.phase !== 'betting') return;
  for (const p of room.players.values()) if (!p.ready && stake(p) > 0) {
    p.balance += stake(p); p.bets = NOBETS();
    send(p.ws, { t: 'error', msg: "Time's up: you weren't ready, so you sit this hand out. Your chips are back." });
  }
  if ([...room.players.values()].some(p => p.ready && p.bets.main > 0)) deal(room); else startBetting(room);
}
function maybeDeal(room) {
  if (room.phase !== 'betting') return;
  const here = [...room.players.values()].filter(p => !p.away);
  if (here.some(p => p.bets.main > 0) && here.every(p => p.ready)) deal(room);
}
function deal(room) {
  clear(room); room.countdownEnds = null;
  const deck = [JOKER]; for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  const order = [...room.players.values()].sort((a, b) => b.seat - a.seat), seats = [], dealer = [];
  for (const p of order) {
    p.inHand = p.bets.main > 0 && p.ready; p.setDone = false; p.split = null; p.cards = p.inHand ? [] : null; p.jpIn = false;
    if (p.inHand) seats.push(p.seat); else if (stake(p) > 0) { p.balance += stake(p); p.bets = NOBETS(); }
  }
  // seven cards each, one at a time from first base around the table, the dealer's last each time round
  for (let k = 0; k < 7; k++) { for (const p of order) if (p.inHand) p.cards.push(deck.pop()); dealer.push(deck.pop()); }
  const hw = houseWay(dealer);
  room.hand = { dealer, dealerSplit: hw };
  room.phase = 'hand'; room.stage = 'set';
  for (const p of room.players.values()) send(p.ws, { t: 'deal', seats, mine: p.inHand ? p.cards : null, dealer, dealerSplit: hw });
  if (!room.solo) { room.timerEnds = Date.now() + (+env.PG_SET_MS || SET_MS); room.timer = setTimeout(() => {
    for (const p of room.players.values()) if (p.inHand && !p.setDone) { p.split = bestVsDealer(p.cards, room.hand.dealer, room.hand.dealerSplit); p.setDone = true; send(p.ws, { t: 'error', msg: 'Out of time: your hand was set for you.' }); }
    showdown(room); }, room.timerEnds - Date.now()); }
  pushState(room);
}
function settleOne(p, h) {
  const b = p.bets, mine = p.cards, D = h.dealer, ds = h.dealerSplit, ps = p.split;
  const pH = eval5(ps.high.map(i => mine[i])), pL = eval2(ps.low.map(i => mine[i]));
  const dH = eval5(ds.high.map(i => D[i])), dL = eval2(ds.low.map(i => D[i]));
  const back = cmp(pH, dH) > 0, front = cmp(pL, dL) > 0, dealerAce = aceHighPaiGow(D), mineAce = aceHighPaiGow(mine), seven = sevenHand(mine);
  let paid = 0; const lines = [], wins = [];
  // the main bet: win both hands to win, lose both to lose, otherwise a push (copies go to the dealer)
  let res;
  if (dealerAce) { res = 'push'; paid += b.main; lines.push("Dealer has Ace-high pai gow: your bet pushes"); }
  else if (back && front) { res = 'win'; paid += b.main * 2; lines.push(`Both hands win +${money(b.main)}`); wins.push('main'); }
  else if (!back && !front) { res = 'lose'; lines.push(`Both hands lose −${money(b.main)}`); }
  else { res = 'push'; paid += b.main; lines.push('One hand each: push'); }
  if (b.bonus) { const row = BONUS.find(([n]) => n === seven);
    if (row) { paid += b.bonus * (1 + row[1]); lines.push(`Bonus ${row[0]} +${money(b.bonus * row[1])}`); wins.push('bonus'); } else lines.push(`Bonus −${money(b.bonus)}`); }
  if (b.ace) { const row = dealerAce ? (mineAce ? ACEHIGH[0] : ACEHIGH[1]) : null;
    if (row) { paid += b.ace * (1 + row[1]); lines.push(`Ace High ${row[0]} +${money(b.ace * row[1])}`); wins.push('ace'); } else lines.push(`Ace High −${money(b.ace)}`); }
  if (b.jack) { const row = JACK.find(([n]) => n === seven); let pay = 0;
    if (row) { pay = typeof row[1] === 'string' ? Math.round(jackpot * parseFloat(row[1])) / 100 : b.jack * row[1]; paid += b.jack + pay; lines.push(`Jackpot ${row[0]} +${money(pay)}`); wins.push('jack'); }
    else lines.push(`Jackpot −${money(b.jack)}`); }
  return { back: paid, staked: stake(p), net: paid - stake(p), lines, wins, res, highWin: back, lowWin: front, high: name5(pH), low: name2(pL), seven, split: ps, dealerAce };
}
function showdown(room) {
  const h = room.hand; if (!h || room.phase !== 'hand') return;
  clearTimeout(room.timer); room.timerEnds = null;
  const results = {}, hands = {};
  for (const p of room.players.values()) {
    p.ready = false; if (!p.inHand) continue;
    const r = settleOne(p, h); p.balance += r.back; results[p.id] = r; hands[p.id] = { cards: p.cards, split: p.split };
    p.bets = NOBETS();
  }
  const D = h.dealer, ds = h.dealerSplit;
  room.phase = 'result'; room.stage = 'done';
  broadcast(room, { t: 'showdown', dealer: D, dealerSplit: ds, dealerHigh: name5(eval5(ds.high.map(i => D[i]))), dealerLow: name2(eval2(ds.low.map(i => D[i]))), dealerAce: aceHighPaiGow(D), hands, results, jackpot });
  pushState(room);
  later(room, () => startBetting(room), room.solo ? 1500 : 8000);
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
        if (r.hand && back.inHand) send(ws, { t: 'deal', seats: [...r.players.values()].filter(p => p.inHand).map(p => p.seat), mine: back.cards, dealer: r.hand.dealer, dealerSplit: r.hand.dealerSplit, late: true });
        pushState(r); return; }
      return addPlayer(r, ws, msg);
    }
  }
  if (!me || !room) return;
  switch (msg.t) {
    case 'bet': {
      if (room.phase === 'hand' || me.ready) return pushState(room);
      const b = msg.bets || {}, main = Math.floor(+b.main || 0), bonus = Math.floor(+b.bonus || 0), ace = Math.floor(+b.ace || 0), jack = b.jack ? ROOM.jackpotBet : 0;
      if (main < 0 || bonus < 0 || ace < 0) return;
      if (main > ROOM.max) { send(ws, { t: 'error', msg: `The table maximum is ${money(ROOM.max)}.` }); return pushState(room); }
      if (bonus > ROOM.sideMax || ace > ROOM.sideMax) { send(ws, { t: 'error', msg: `The Bonus and Ace High go up to ${money(ROOM.sideMax)}.` }); return pushState(room); }
      const want = main + bonus + ace + jack, have = me.balance + stake(me);
      if (want > have) { send(ws, { t: 'error', msg: 'Not enough chips for that.' }); return pushState(room); }
      if (jack && !me.jpIn) { jackpot += jack; me.jpIn = true; }   // the $5 goes onto the meter the moment the light goes on, and stays there
      me.balance = have - want; me.bets = { main, bonus, ace, jack };
      return pushState(room);
    }
    case 'ready': {
      if (room.phase === 'hand') return;
      if (me.bets.main && me.bets.main < ROOM.min) { send(ws, { t: 'error', msg: `The table minimum is ${money(ROOM.min)}.` }); return pushState(room); }
      if (!me.bets.main && stake(me)) { send(ws, { t: 'error', msg: 'Put a bet on BET to play the hand (the side bets go with it).' }); return pushState(room); }
      me.ready = true; pushState(room);
      if (room.phase === 'betting') { if (room.solo) { if (me.bets.main) deal(room); else me.ready = false; } else maybeDeal(room); }
      return;
    }
    case 'unready': if (room.phase !== 'hand') { me.ready = false; pushState(room); } return;
    case 'set': {   // your hand: the two cards for the low hand (or the House Way)
      if (room.phase !== 'hand' || room.stage !== 'set' || !me.inHand || me.setDone) return;
      let split;
      if (msg.house) split = bestVsDealer(me.cards, room.hand.dealer, room.hand.dealerSplit);
      else {
        const low = (msg.low || []).map(Number).filter(i => i >= 0 && i < 7);
        if (new Set(low).size !== 2) return send(ws, { t: 'error', msg: 'Pick two cards for your low hand.' });
        const high = [0, 1, 2, 3, 4, 5, 6].filter(i => !low.includes(i));
        if (!legal(high.map(i => me.cards[i]), low.map(i => me.cards[i]))) return send(ws, { t: 'error', msg: 'Your five-card hand has to beat your two-card hand. Try different cards, or tap House Way.' });
        split = { low, high };
      }
      me.split = split; me.setDone = true; send(ws, { t: 'yourset', split }); pushState(room);
      if ([...room.players.values()].every(p => !p.inHand || p.setDone || p.away)) later(room, () => showdown(room), 600);
      return;
    }
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
  if (room.phase === 'hand' && me.inHand) { me.away = true; me.ws = null;   // the House Way sets their hand
    if (!me.setDone) { me.split = bestVsDealer(me.cards, room.hand.dealer, room.hand.dealerSplit); me.setDone = true; }
    if ([...room.players.values()].every(p => !p.inHand || p.setDone)) later(room, () => showdown(room), 600);
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

return { handle, leave, rooms, ROOM, BONUS, ACEHIGH, JACK, JP_START, jp, JOKER, eval5, eval2, best5, name5, name2, cat5, sevenHand, aceHighPaiGow, houseWay, bestVsDealer, legal, settleOne, cmp };
});
