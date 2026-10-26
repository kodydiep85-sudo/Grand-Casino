/* Blackjack — the dealer. Shoe, rules, side bets and the table's flow.
   The same file runs on the website's server (friends' tables, up to 5 players) and inside the
   browser for solo play, so both play by exactly the same rules.
   Rules: blackjack pays 3 to 2, dealer stands on all 17s, dealer peeks for blackjack with an Ace or ten up,
   double on any two cards (also after a split), split up to four hands, split Aces get one card each,
   insurance pays 2 to 1. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GSBlackjack = factory();
})(typeof self !== 'undefined' ? self : this, function () {

const ROOM = { name: 'The Lounge', min: 5, max: 500, sideMax: 100, seats: 5 };
// Pair Bonus: your first two cards are a pair (same rank). Suited pairs pay more.
const PAIR = [['Suited pair', 10], ['Pair', 5]];
// Bust Bonus: placed after the deal, once the dealer's card is showing. Pays when the dealer busts, whatever the number of cards;
// a suited bust (every card in the dealer's busted hand the same suit) pays the extra bonus
const BUST = [['Suited bust', 8], ['Dealer busts', 1]];
const SHOES = { 6: { decks: 6, cut: 0.75, label: '6 decks' }, 2: { decks: 2, cut: 0.65, label: 'Double deck' } };
const BET_WINDOW_MS = 60000, PRE_MS = 15000, TURN_MS = 30000;   // friends' tables: a minute to bet, 15 s for Bust Bonus / insurance, 30 s a turn
const env = typeof process !== 'undefined' && process.env ? process.env : {};

/* ---------------- cards ---------------- */
const val = c => c.r >= 10 && c.r <= 13 ? 10 : c.r === 14 ? 11 : c.r;
function total(cards) {
  let t = 0, aces = 0; for (const c of cards) { t += val(c); if (c.r === 14) aces++; }
  while (t > 21 && aces) { t -= 10; aces--; }
  return { t, soft: aces > 0 };
}
const isBJ = h => h.cards.length === 2 && !h.split && total(h.cards).t === 21;
const RN = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J' };
const money = n => '$' + (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function freshShoe(decks) {
  const s = []; for (let d = 0; d < decks; d++) for (const su of ['♠', '♥', '♦', '♣']) for (let r = 2; r <= 14; r++) s.push({ r, s: su });
  for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
  return s;
}
function pairBonus(cards) {
  const [a, b] = cards; if (!a || !b || a.r !== b.r) return null;
  return a.s === b.s ? PAIR[0] : PAIR[1];
}
function bustBonus(dealer) {
  if (total(dealer).t <= 21) return null;
  return dealer.every(c => c.s === dealer[0].s) ? BUST[0] : BUST[1];
}

/* ---------------- tables ---------------- */
const rooms = new Map();
let nextId = 1;
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const broadcast = (room, m) => { for (const p of room.players.values()) send(p.ws, m); };
const NOBETS = () => ({ main: 0, pair: 0, bust: 0, ins: 0 });
// everything you have riding: the bets, plus any doubles and splits while the hand is live
const stake = p => Object.values(p.bets).reduce((a, b) => a + b, 0) + (p.inHand ? (p.hands || []).reduce((a, h, i) => a + (i ? h.bet : h.bet - p.bets.main), 0) : 0);
const code4 = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms.has(c)); return c; };
const clear = room => { for (const k of ['clock', 'step', 'timer']) { clearTimeout(room[k]); room[k] = null; } };
// one dealer action pending at a time: a new step replaces any older one
const later = (room, fn, ms) => { clearTimeout(room.step); room.step = setTimeout(fn, ms); };
const order = room => [...room.players.values()].filter(p => p.inHand).sort((a, b) => b.seat - a.seat);   // first base (the dealer's left) first
const draw = room => { if (!room.shoe.length) room.shoe = freshShoe(room.decks); return room.shoe.pop(); };

function publicState(room) {
  const d = room.dealer || [];
  return {
    t: 'state', now: Date.now(), code: room.code, phase: room.phase, stage: room.stage, solo: room.solo, decks: room.decks,
    shoeLeft: room.shoe.length, shoeSize: room.decks * 52, countdownEnds: room.countdownEnds || null, timerEnds: room.timerEnds || null,
    turn: room.turn || null, dealer: d.map((c, i) => i === 1 && !room.holeShown ? null : c), peeked: !!room.peeked,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, seat: p.seat, balance: p.balance, bets: p.bets, ready: p.ready,
      inHand: !!p.inHand, preDone: !!p.preDone, insured: p.insured === undefined ? null : p.insured, away: !!p.away,
      hands: (p.hands || []).map(h => ({ cards: h.cards, bet: h.bet, done: !!h.done, doubled: !!h.doubled, split: !!h.split })) })),
  };
}
const pushState = room => broadcast(room, publicState(room));

function startBetting(room) {
  clear(room); room.phase = 'betting'; room.stage = null; room.dealer = []; room.holeShown = false; room.peeked = false; room.turn = null; room.timerEnds = null;
  for (const p of room.players.values()) { p.inHand = false; p.hands = []; p.preDone = false; p.insured = undefined; }
  if (!room.solo) { room.countdownEnds = Date.now() + (+env.BJ_BET_MS || BET_WINDOW_MS); room.clock = setTimeout(() => timeUp(room), room.countdownEnds - Date.now()); }
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
  // the cut card: a fresh shoe when it comes out
  if (room.shoe.length < room.decks * 52 * (1 - SHOES[room.decks].cut)) { room.shoe = freshShoe(room.decks); broadcast(room, { t: 'chat', text: `The cut card came out: a fresh ${SHOES[room.decks].label.toLowerCase()} shoe is shuffled.` }); }
  for (const p of room.players.values()) {
    p.inHand = p.bets.main > 0 && p.ready; p.hands = []; p.preDone = false; p.insured = undefined;
    if (!p.inHand && stake(p) > 0) { p.balance += stake(p); p.bets = NOBETS(); }
  }
  const seats = order(room); room.dealer = [];
  // one card each, first base first, then the dealer's up card; again, then the dealer's hole card face down
  for (const p of seats) p.hands = [{ cards: [draw(room)], bet: p.bets.main }];
  room.dealer.push(draw(room));
  for (const p of seats) { p.hands[0].cards.push(draw(room)); p.first = p.hands[0].cards.slice(); }   // the first two cards, for the Pair Bonus
  room.dealer.push(draw(room));
  room.holeShown = false; room.peeked = false;
  room.phase = 'hand'; room.stage = 'pre'; room.turn = null;
  // Bust Bonus (and insurance when the dealer shows an Ace) are open now that the dealer's card is out
  if (!room.solo) { room.timerEnds = Date.now() + (+env.BJ_PRE_MS || PRE_MS); room.timer = setTimeout(() => endPre(room), room.timerEnds - Date.now()); }
  pushState(room);
}
const upAce = room => room.dealer[0] && room.dealer[0].r === 14;
function endPre(room) {
  if (room.phase !== 'hand' || room.stage !== 'pre') return;
  clearTimeout(room.timer); room.timerEnds = null;
  for (const p of order(room)) { p.preDone = true; if (upAce(room) && p.insured === undefined) p.insured = false; }
  // the dealer peeks with an Ace or a ten showing
  if (val(room.dealer[0]) >= 10) {
    room.peeked = true;
    if (total(room.dealer).t === 21) { room.holeShown = true; room.stage = 'dealer'; pushState(room); later(room, () => settle(room), 1600); return; }
  }
  room.stage = 'play'; nextTurn(room);
}
// the next hand that still needs a decision, first base first
function nextTurn(room) {
  if (room.phase !== 'hand' || room.stage !== 'play') return;
  clearTimeout(room.timer); room.timerEnds = null;
  for (const p of order(room)) for (let i = 0; i < p.hands.length; i++) {
    const h = p.hands[i];
    if (h.done) continue;
    if (isBJ(h) || total(h.cards).t >= 21) { h.done = true; continue; }
    room.turn = { seat: p.seat, hand: i, id: p.id };
    if (!room.solo) { room.timerEnds = Date.now() + (+env.BJ_TURN_MS || TURN_MS); room.timer = setTimeout(() => act(room, p, 'stand', true), room.timerEnds - Date.now()); }
    pushState(room); return;
  }
  room.turn = null; dealerPlay(room);
}
function act(room, p, a, auto) {
  if (room.phase !== 'hand') return;
  if (room.stage === 'pre') {   // solo: playing your hand closes the Bust Bonus / insurance window
    if (!room.solo || !['hit', 'stand', 'double', 'split'].includes(a)) return;
    if (upAce(room) && p.insured === undefined) return send(p.ws, { t: 'error', msg: 'The dealer shows an Ace: take insurance or say no first.' });
    endPre(room); if (room.stage !== 'play') return;
  }
  if (room.stage !== 'play' || !room.turn || room.turn.id !== p.id) return;
  const h = p.hands[room.turn.hand]; if (!h || h.done) return;
  if (a === 'hit') { h.cards.push(draw(room)); if (total(h.cards).t >= 21) h.done = true; }
  else if (a === 'stand') h.done = true;
  else if (a === 'double') {
    if (h.cards.length !== 2 || h.splitAces) return send(p.ws, { t: 'error', msg: 'You can double on your first two cards only.' });
    if (p.balance < h.bet) return send(p.ws, { t: 'error', msg: `You need ${money(h.bet)} to double.` });
    p.balance -= h.bet; h.bet *= 2; h.doubled = true; h.cards.push(draw(room)); h.done = true;
  } else if (a === 'split') {
    if (h.cards.length !== 2 || val(h.cards[0]) !== val(h.cards[1])) return send(p.ws, { t: 'error', msg: 'You can split two cards of the same value.' });
    if (p.hands.length >= 4) return send(p.ws, { t: 'error', msg: 'Four hands is the most you can split to.' });
    if (h.splitAces) return send(p.ws, { t: 'error', msg: "Split Aces can't be split again." });
    if (p.balance < h.bet) return send(p.ws, { t: 'error', msg: `You need ${money(h.bet)} to split.` });
    p.balance -= h.bet;
    const aces = h.cards[0].r === 14, nh = { cards: [h.cards.pop()], bet: h.bet, split: true, splitAces: aces };
    h.split = true; h.splitAces = aces;
    h.cards.push(draw(room)); nh.cards.push(draw(room));
    p.hands.splice(room.turn.hand + 1, 0, nh);
    if (aces) { h.done = true; nh.done = true; }   // one card on each split Ace
    else if (total(h.cards).t === 21) h.done = true;
  } else return;
  if (auto) send(p.ws, { t: 'error', msg: 'Out of time: you stand.' });
  if (h.done) { later(room, () => nextTurn(room), 450); pushState(room); }
  else { pushState(room); if (!room.solo) { clearTimeout(room.timer); room.timerEnds = Date.now() + (+env.BJ_TURN_MS || TURN_MS); room.timer = setTimeout(() => act(room, p, 'stand', true), room.timerEnds - Date.now()); pushState(room); } }
}
// the dealer turns over the hole card and draws to 17 (standing on all 17s); with a Bust Bonus out, the dealer always finishes the hand
function dealerPlay(room) {
  if (room.phase !== 'hand' || room.stage === 'dealer') return;
  room.stage = 'dealer'; room.holeShown = true; pushState(room);
  const live = order(room).some(p => p.hands.some(h => total(h.cards).t <= 21 && !isBJ(h))) || order(room).some(p => p.bets.bust > 0);
  const step = () => {
    if (live && total(room.dealer).t < 17) { room.dealer.push(draw(room)); pushState(room); later(room, step, 950); }
    else later(room, () => settle(room), 900);
  };
  later(room, step, 1100);
}
function settleOne(p, dealer) {
  const D = total(dealer).t, dBJ = dealer.length === 2 && D === 21, b = p.bets;
  let back = 0, staked = stake(p); const lines = [], wins = [], hands = [];
  // side bets first
  if (b.pair) { const pb = pairBonus(p.first || []);
    if (pb) { back += b.pair * (1 + pb[1]); lines.push(`Pair Bonus ${pb[0]} +${money(b.pair * pb[1])}`); wins.push('pair'); } else lines.push(`Pair Bonus −${money(b.pair)}`); }
  if (b.bust) { const bb = bustBonus(dealer);
    if (bb) { back += b.bust * (1 + bb[1]); lines.push(`Bust Bonus ${bb[0]} +${money(b.bust * bb[1])}`); wins.push('bust'); } else lines.push(`Bust Bonus −${money(b.bust)}`); }
  if (b.ins) { if (dBJ) { back += b.ins * 3; lines.push(`Insurance +${money(b.ins * 2)}`); } else lines.push(`Insurance −${money(b.ins)}`); }
  p.hands.forEach((h, i) => {
    const t = total(h.cards).t, tag = p.hands.length > 1 ? `Hand ${i + 1}` : 'Bet';
    let r;
    if (isBJ(h)) { if (dBJ) { back += h.bet; r = 'push'; lines.push(`${tag}: blackjack pushes`); } else { back += h.bet * 2.5; r = 'bj'; lines.push(`${tag}: BLACKJACK +${money(h.bet * 1.5)}`); } }
    else if (t > 21) { r = 'bust'; lines.push(`${tag}: bust −${money(h.bet)}`); }
    else if (dBJ) { r = 'lose'; lines.push(`${tag}: dealer blackjack −${money(h.bet)}`); }
    else if (D > 21 || t > D) { back += h.bet * 2; r = 'win'; lines.push(`${tag}: ${t} wins +${money(h.bet)}`); }
    else if (t === D) { back += h.bet; r = 'push'; lines.push(`${tag}: ${t} pushes`); }
    else { r = 'lose'; lines.push(`${tag}: ${t} loses −${money(h.bet)}`); }
    hands.push(r);
  });
  if (hands.some(r => r === 'win' || r === 'bj')) wins.push('main');
  const best = hands.includes('bj') ? 'bj' : hands.includes('win') ? 'win' : hands.every(r => r === 'push') ? 'push' : hands.includes('push') && !hands.some(r => r === 'lose' || r === 'bust') ? 'push' : hands.every(r => r === 'bust') ? 'bust' : 'lose';
  return { back, staked, net: back - staked, lines, wins, hands, res: best };
}
function settle(room) {
  if (room.phase !== 'hand') return;
  room.holeShown = true;
  const results = {};
  for (const p of room.players.values()) {
    p.ready = false;
    if (!p.inHand) continue;
    const r = settleOne(p, room.dealer); p.balance += r.back; results[p.id] = r;
  }
  const D = total(room.dealer);
  room.phase = 'result'; room.stage = 'done'; room.turn = null; room.timerEnds = null;
  pushState(room);
  broadcast(room, { t: 'showdown', dealer: room.dealer, dealerTotal: D.t, dealerBJ: room.dealer.length === 2 && D.t === 21, results });
  for (const p of room.players.values()) { p.bets = NOBETS(); p.inHand = false; }   // the cards stay on the felt until the next deal
  pushState(room);
  later(room, () => startBetting(room), room.solo ? 1500 : 8000);
}

/* ---------------- messages from players ---------------- */
function seatFor(room) { const used = new Set([...room.players.values()].map(p => p.seat)); for (const s of [2, 1, 3, 0, 4]) if (!used.has(s)) return s; return -1; }
function addPlayer(room, ws, msg) {
  const seat = seatFor(room); if (seat < 0) return send(ws, { t: 'error', msg: 'That table is full (5 players).' });
  const bank = Math.floor(Number(msg.bankroll));
  const p = { id: 'p' + (nextId++) + Math.random().toString(36).slice(2, 10), name: String(msg.name || 'Player').slice(0, 14) || 'Player', seat,
    balance: Number.isFinite(bank) && bank >= 0 ? Math.min(1e15, bank) : 1000, bets: NOBETS(), hands: [], ready: false, ws };
  room.players.set(p.id, p); ws.player = p; ws.room = room;
  send(ws, { t: 'welcome', you: p.id, code: room.code, seat, solo: room.solo });
  if (!room.solo) broadcast(room, { t: 'chat', text: `${p.name} sat down in seat ${seat + 1}.` });
  pushState(room);
}
function handle(ws, msg) {
  if (!msg || typeof msg !== 'object') return;
  const me = ws.player, room = ws.room;
  switch (msg.t) {
    case 'create': {
      if (me) return;
      const decks = +msg.decks === 2 ? 2 : 6;
      const code = msg.solo ? 'SOLO' + (nextId++) : code4();
      const r = { code, solo: !!msg.solo, decks, shoe: freshShoe(decks), players: new Map(), phase: 'betting', stage: null, dealer: [] };
      rooms.set(code, r); addPlayer(r, ws, msg); if (!r.solo) startBetting(r); return;
    }
    case 'join': {
      if (me) return;
      const r = rooms.get(String(msg.code || '').toUpperCase());
      if (!r || r.solo) return send(ws, { t: 'error', msg: 'No table with that code.' });
      const back = msg.id && r.players.get(String(msg.id).slice(0, 40));
      if (back) { clearTimeout(back.awayTimer); back.away = false; back.ws = ws; ws.player = back; ws.room = r;
        send(ws, { t: 'welcome', you: back.id, code: r.code, seat: back.seat, back: true }); pushState(r); return; }
      return addPlayer(r, ws, msg);
    }
  }
  if (!me || !room) return;
  switch (msg.t) {
    case 'bet': {   // your bets for the next hand: the main bet and the Pair Bonus
      if (room.phase === 'hand' || me.ready) return pushState(room);
      const b = msg.bets || {}, main = Math.floor(+b.main || 0), pair = Math.floor(+b.pair || 0);
      if (main < 0 || pair < 0) return;
      if (main > ROOM.max) { send(ws, { t: 'error', msg: `The table maximum is ${money(ROOM.max)}.` }); return pushState(room); }
      if (pair > ROOM.sideMax) { send(ws, { t: 'error', msg: `The Pair Bonus goes up to ${money(ROOM.sideMax)}.` }); return pushState(room); }
      const have = me.balance + me.bets.main + me.bets.pair;
      if (main + pair > have) { send(ws, { t: 'error', msg: 'Not enough chips for that.' }); return pushState(room); }
      me.balance = have - main - pair; me.bets = { main, pair, bust: 0, ins: 0 };
      return pushState(room);
    }
    case 'bust': {   // the Bust Bonus: once the dealer's card is out, before play starts
      if (room.phase !== 'hand' || room.stage !== 'pre' || !me.inHand || me.preDone) return pushState(room);
      const a = Math.floor(+msg.amount || 0);
      if (a < 0) return;
      if (a > ROOM.sideMax) { send(ws, { t: 'error', msg: `The Bust Bonus goes up to ${money(ROOM.sideMax)}.` }); return pushState(room); }
      if (a - me.bets.bust > me.balance) { send(ws, { t: 'error', msg: 'Not enough chips for that.' }); return pushState(room); }
      me.balance -= a - me.bets.bust; me.bets.bust = a; return pushState(room);
    }
    case 'insure': {
      if (room.phase !== 'hand' || room.stage !== 'pre' || !me.inHand || !upAce(room) || me.insured !== undefined) return;
      if (msg.yes) { const cost = Math.floor(me.bets.main / 2); if (me.balance < cost) { send(ws, { t: 'error', msg: `You need ${money(cost)} for insurance.` }); return pushState(room); }
        me.balance -= cost; me.bets.ins = cost; me.insured = true; } else me.insured = false;
      pushState(room);
      return;
    }
    case 'go': {   // done with Bust Bonus / insurance
      if (room.phase !== 'hand' || room.stage !== 'pre' || !me.inHand) return;
      if (upAce(room) && me.insured === undefined) me.insured = false;
      me.preDone = true; pushState(room);
      if (order(room).every(p => p.preDone || p.away)) endPre(room);
      return;
    }
    case 'ready': {
      if (room.phase === 'hand') return;
      if (me.bets.main && me.bets.main < ROOM.min) { send(ws, { t: 'error', msg: `The table minimum is ${money(ROOM.min)}.` }); return pushState(room); }
      if (!me.bets.main && stake(me)) { send(ws, { t: 'error', msg: 'Put a bet on BET to play the hand (the Pair Bonus goes with it).' }); return pushState(room); }
      me.ready = true; pushState(room);
      if (room.phase === 'betting') { if (room.solo) { if (me.bets.main) deal(room); else me.ready = false; } else maybeDeal(room); }
      return;
    }
    case 'unready': if (room.phase !== 'hand') { me.ready = false; pushState(room); } return;
    case 'decks': {   // solo: switch between a 6-deck shoe and double deck between hands
      if (!room.solo || room.phase === 'hand') return;
      const d = +msg.decks === 2 ? 2 : 6; if (d !== room.decks) { room.decks = d; room.shoe = freshShoe(d); } return pushState(room);
    }
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
  if (room.phase === 'hand' && me.inHand) { me.away = true; me.ws = null;   // their hands stand where they are
    if (room.stage === 'pre') { me.preDone = true; if (order(room).every(p => p.preDone || p.away)) endPre(room); }
    else if (room.turn && room.turn.id === me.id) { for (const h of me.hands) h.done = true; nextTurn(room); }
    else for (const h of me.hands) h.done = true;
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

return { handle, leave, rooms, ROOM, PAIR, BUST, SHOES, total, isBJ, val, pairBonus, bustBonus, settleOne, freshShoe };
});
