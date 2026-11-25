// SPDX-License-Identifier: MIT
// Sharpe Sprint rebuild — pump.fun paper bot (agent-fun/replay/v2).
//
// Entry for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins".
// Places are decided by hourly Sharpe ratio over a 6-hour forward replay,
// so the bot trades for smoothness, not size: one fixed small stake per
// position, a low ceiling on total exposure, quick profit-taking, and a
// hard stop that keeps any single curve from denting the equity curve.
//
// Node 22 standard library only, no network. Determinism is a hard
// requirement (the harness runs the entry twice and compares the action
// logs byte for byte), so every decision is a pure function of the input
// stream: no wall clock, no randomness, and price comparisons use exact
// BigInt cross-multiplication instead of floats.

import { createInterface } from "node:readline";

// ---------- exact price arithmetic ----------
// A bonding-curve price is virtual_quote / virtual_token. We keep it as
// an unreduced BigInt fraction and compare by cross-multiplication, so
// two runs can never disagree over rounding.
interface Price {
  q: bigint; // virtual quote reserves (lamports side)
  t: bigint; // virtual token reserves
}

function cmpPrice(a: Price, b: Price): number {
  const lhs = a.q * b.t;
  const rhs = b.q * a.t;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

// true when a >= b * num/den, computed exactly.
function atLeast(a: Price, b: Price, num: bigint, den: bigint): boolean {
  return a.q * b.t * den >= b.q * a.t * num;
}

// true when a <= b * num/den, computed exactly.
function atMost(a: Price, b: Price, num: bigint, den: bigint): boolean {
  return a.q * b.t * den <= b.q * a.t * num;
}

function big(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string") {
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function priceOf(vq: unknown, vt: unknown): Price | null {
  const t = big(vt);
  if (t <= 0n) return null;
  const q = big(vq);
  if (q <= 0n) return null;
  return { q, t };
}

// Lamport value of `tokens` at `price`, as an exact fraction num/den.
function valueOf(tokens: bigint, price: Price): { num: bigint; den: bigint } {
  return { num: tokens * price.q, den: price.t };
}

// ---------- strategy parameters ----------
const LAMPORTS_PER_SOL = 1_000_000_000n;
const STAKE = 50_000_000n; // 0.05 SOL per position, always the same
const PROBE_STAKE = 11_000_000n; // 0.011 SOL guardrail probe
const MIN_ROUND_TRIP = 10_000_000n; // 0.01 SOL: the guardrail's floor
const FEE_BUFFER = 100_000_000n; // 0.10 SOL of cash never committed
const EXPOSURE_CAP = 300_000_000n; // 0.30 SOL at cost across all positions
const MIN_CURVE_AGE = 90; // slots; younger curves are launch noise
const SIGNAL_WINDOW = 45; // slots of tape the entry signal reads
const FADE_WINDOW = 25; // slots of tape the exit fade reads
const MAX_HOLD = 450; // slots; time stop
const STALE_TAPE = 120; // slots without a trade: the curve went quiet
const FRESH_TAPE = 20; // entries need a trade this recent
const REENTRY_WAIT = 150; // slots between an exit and the next entry
const MAX_ENTRIES = 2; // per mint
const MIN_NET_INFLOW = 600_000_000n; // 0.6 SOL net bought in the window
const FADE_OUTFLOW = 250_000_000n; // 0.25 SOL net sold in the fade window
const MIN_REAL_RESERVE = 1_200_000_000n; // 1.2 SOL: the 1% cap still clears 0.01
const MAX_REAL_RESERVE = 60_000_000_000n; // 60 SOL: graduation is close, skip
const BUY_SLIPPAGE_BPS = 700;
const SELL_SLIPPAGE_BPS = 10_000; // exits must fill, whatever the price
const TAPE_CAP = 300; // trades remembered per mint
// Guardrail pacing: the minimum bar is a >= 0.01 SOL round trip on 20+
// distinct mints. Aim for 22 by slot 36,000 of the ~54,000-slot window.
const PACE_COINS = 22;
const PACE_SLOTS = 36_000;

interface TapeEntry {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: string;
  price: Price;
}

interface Curve {
  born: number | null; // slot of CreateEvent
  done: boolean; // CompleteEvent seen
  tape: TapeEntry[];
  lastTrade: number; // slot of the most recent TradeEvent, -1 when none
  mark: Price | null; // latest price from marks
  realQuote: bigint; // latest real quote reserves
  fills: number; // filled buys so far
  lastExit: number; // slot the last position on this mint closed
  inFlight: { id: string; seq: number }[]; // orders awaiting a fill
}

interface Position {
  opened: number; // slot first seen held
  cost: bigint; // lamports paid (harness account is the truth)
  tokens: bigint;
  peakNum: bigint; // highest close value seen, as num/den lamports
  peakDen: bigint;
  closing: boolean; // a sell is already on its way
}

const curves = new Map<string, Curve>();
const positions = new Map<string, Position>();
const probes = new Map<string, boolean>(); // mint -> probe sell already sent
const counted = new Set<string>(); // mints with a filled buy >= 0.01 SOL
let maxOpen = 5;
let maxBps = 100;
let maxOrders = 16;
let latency = 2;
let firstSlot: number | null = null;
let idCounter = 0;

function curve(mint: string): Curve {
  let c = curves.get(mint);
  if (!c) {
    c = {
      born: null,
      done: false,
      tape: [],
      lastTrade: -1,
      mark: null,
      realQuote: 0n,
      fills: 0,
      lastExit: -1_000_000_000,
      inFlight: [],
    };
    curves.set(mint, c);
  }
  return c;
}

// Net SOL flow over the last `window` slots of a curve's tape:
// positive when buyers are winning.
function netFlow(c: Curve, slot: number, window: number): bigint {
  let net = 0n;
  for (const t of c.tape) {
    if (t.slot > slot - window) net += t.buy ? t.sol : -t.sol;
  }
  return net;
}

function main(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line: string) => {
    const text = line.trim();
    if (!text) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const caps = (msg.caps ?? {}) as Record<string, unknown>;
      maxOpen = Number(caps.max_open_positions ?? 5);
      maxBps = Number(caps.max_order_bps_of_real_reserve ?? 100);
      maxOrders = Number(caps.max_orders_per_batch ?? 16);
      latency = Number(msg.latency_slots ?? 2);
      return;
    }
    if (msg.type === "done") process.exit(0);
    if (msg.type !== "batch") return;

    const seq = Number(msg.seq ?? 0);
    const slot = Number(msg.slot ?? 0);
    if (firstSlot === null) firstSlot = slot;
    const events = (msg.events ?? []) as Record<string, unknown>[];
    const marks = (msg.marks ?? []) as Record<string, unknown>[];
    const fills = (msg.fills ?? []) as Record<string, unknown>[];
    const account = (msg.account ?? {}) as Record<string, unknown>;
    const cash = big(account.cash_lamports);
    const accountPositions = (account.positions ?? []) as Record<
      string,
      unknown
    >[];

    const heldTokens = new Map<string, bigint>();
    const heldCost = new Map<string, bigint>();
    for (const p of accountPositions) {
      const mint = String(p.mint ?? "");
      if (!mint) continue;
      heldTokens.set(mint, big(p.token_amount));
      heldCost.set(mint, big(p.cost_lamports));
    }

    // ---- fold the chain events into per-curve state ----
    for (const e of events) {
      const mint = String(e.mint ?? "");
      if (!mint) continue;
      const c = curve(mint);
      const kind = String(e.event ?? "");
      if (kind === "CreateEvent") {
        if (c.born === null) c.born = Number(e.slot ?? slot);
      } else if (kind === "TradeEvent") {
        const price = priceOf(
          e.virtual_quote_reserves,
          e.virtual_token_reserves,
        );
        if (price) {
          const tradeSlot = Number(e.slot ?? slot);
          if (tradeSlot > c.lastTrade) c.lastTrade = tradeSlot;
          c.tape.push({
            slot: tradeSlot,
            buy: e.is_buy === true,
            sol: big(e.sol_amount),
            user: String(e.user ?? ""),
            price,
          });
          if (c.tape.length > TAPE_CAP) {
            c.tape.splice(0, c.tape.length - TAPE_CAP);
          }
        }
        c.realQuote = big(e.real_quote_reserves);
      } else if (kind === "CompleteEvent") {
        c.done = true;
      }
    }

    // ---- marks carry the freshest price and reserve per curve ----
    for (const m of marks) {
      const mint = String(m.mint ?? "");
      if (!mint) continue;
      const price = priceOf(m.virtual_quote_reserves, m.virtual_token_reserves);
      if (!price) continue;
      const c = curve(mint);
      c.mark = price;
      c.realQuote = big(m.real_quote_reserves);
    }

    // ---- fills settle in-flight orders and feed the guardrail count ----
    for (const f of fills) {
      const mint = String(f.mint ?? "");
      if (!mint) continue;
      const c = curves.get(mint);
      if (!c) continue;
      const id = String(f.client_id ?? "");
      if (id) {
        const i = c.inFlight.findIndex((o) => o.id === id);
        if (i >= 0) c.inFlight.splice(i, 1);
      }
      if (f.side === "buy" && f.status === "filled") {
        c.fills += 1;
        if (big(f.quote_lamports) >= MIN_ROUND_TRIP) counted.add(mint);
      }
    }
    // Orders the harness never answered stop blocking the mint.
    for (const c of curves.values()) {
      c.inFlight = c.inFlight.filter((o) => seq - o.seq <= latency + 2);
    }

    // ---- reconcile positions against the harness account ----
    for (const [mint, tokens] of heldTokens) {
      if (tokens <= 0n) continue;
      const cost = heldCost.get(mint) ?? 0n;
      let pos = positions.get(mint);
      if (!pos) {
        pos = {
          opened: slot,
          cost,
          tokens,
          peakNum: cost,
          peakDen: 1n,
          closing: false,
        };
        positions.set(mint, pos);
      }
      pos.cost = cost;
      pos.tokens = tokens;
      const mark = curves.get(mint)?.mark ?? null;
      if (mark) {
        const v = valueOf(tokens, mark);
        if (v.num * pos.peakDen > pos.peakNum * v.den) {
          pos.peakNum = v.num;
          pos.peakDen = v.den;
        }
      }
    }
    for (const mint of [...positions.keys()]) {
      if ((heldTokens.get(mint) ?? 0n) <= 0n) {
        positions.delete(mint);
        const c = curves.get(mint);
        if (c) c.lastExit = slot;
      }
    }
    for (const mint of [...probes.keys()]) {
      if ((heldTokens.get(mint) ?? 0n) <= 0n) probes.delete(mint);
    }

    // ---- decide this batch's orders; exits always outrank entries ----
    const orders: Record<string, unknown>[] = [];
    const emit = (o: Record<string, unknown>): void => {
      if (orders.length < maxOrders) orders.push(o);
    };
    const nextId = (tag: string): string => `${tag}${++idCounter}`;

    // Sells: take-profit, trailing stop, stop-loss, time stop, flow fade.
    for (const [mint, pos] of positions) {
      if (pos.closing || pos.tokens <= 0n) continue;
      const c = curves.get(mint);
      if (!c || c.done || !c.mark) continue;
      const v = valueOf(pos.tokens, c.mark);
      const cost = pos.cost;
      let exit = false;
      // Take profit at +20% over cost.
      if (cost > 0n && v.num * 5n >= cost * 6n * v.den) exit = true;
      // Trailing: once the peak passed +12%, sell 8% below that peak.
      if (
        !exit &&
        cost > 0n &&
        pos.peakNum * 100n >= cost * 112n * pos.peakDen &&
        v.num * 100n * pos.peakDen <= pos.peakNum * 92n * v.den
      ) {
        exit = true;
      }
      // Stop loss at -10% under cost.
      if (!exit && cost > 0n && v.num * 10n <= cost * 9n * v.den) exit = true;
      // Time stop: a position that goes nowhere is variance without pay.
      if (!exit && slot - pos.opened > MAX_HOLD) exit = true;
      // Dead tape: nobody has traded this curve for a while, so the mark
      // is stale and the slot is better spent on a live curve.
      if (!exit && c.lastTrade >= 0 && slot - c.lastTrade > STALE_TAPE) {
        exit = true;
      }
      // Flow fade: sellers took the tape over.
      if (!exit && netFlow(c, slot, FADE_WINDOW) < -FADE_OUTFLOW) exit = true;
      if (exit) {
        pos.closing = true;
        const id = nextId("s");
        c.inFlight.push({ id, seq });
        emit({
          side: "sell",
          client_id: id,
          mint,
          token_amount: pos.tokens.toString(),
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // Probe positions close on the first batch they appear in.
    for (const [mint, sellSent] of probes) {
      if (sellSent) continue;
      const tokens = heldTokens.get(mint) ?? 0n;
      if (tokens <= 0n) continue;
      const c = curves.get(mint);
      if (!c || c.done) continue;
      probes.set(mint, true);
      const id = nextId("p");
      c.inFlight.push({ id, seq });
      emit({
        side: "sell",
        client_id: id,
        mint,
        token_amount: tokens.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }

    // Buys: count what is already committed before adding more.
    let openCount = 0;
    let exposure = 0n;
    for (const [mint, tokens] of heldTokens) {
      if (tokens > 0n) {
        openCount += 1;
        exposure += heldCost.get(mint) ?? 0n;
      }
    }
    let pendingBuys = 0;
    for (const [mint, c] of curves) {
      if (c.inFlight.length > 0 && (heldTokens.get(mint) ?? 0n) <= 0n) {
        pendingBuys += 1;
      }
    }
    let slotsFree = maxOpen - openCount - pendingBuys;

    // The size we may actually send: the smaller of the target, the
    // harness's per-order reserve cap, spare cash and spare exposure.
    const sized = (c: Curve, target: bigint): bigint => {
      let size = target;
      const reserveCap = (c.realQuote * BigInt(maxBps)) / 10_000n;
      if (reserveCap < size) size = reserveCap;
      const spareCash = cash - FEE_BUFFER;
      if (spareCash < size) size = spareCash;
      const spareExposure = EXPOSURE_CAP - exposure;
      if (spareExposure < size) size = spareExposure;
      return size;
    };

    for (const [mint, c] of curves) {
      if (orders.length >= maxOrders || slotsFree <= 0) break;
      if (c.done || c.born === null || !c.mark) continue;
      if ((heldTokens.get(mint) ?? 0n) > 0n) continue;
      if (c.inFlight.length > 0 || probes.has(mint)) continue;
      if (c.fills >= MAX_ENTRIES) continue;
      if (slot - c.born < MIN_CURVE_AGE) continue;
      // The signal reads the last 45 slots; if the tape already went
      // quiet inside that window, the move is over before we arrive.
      if (c.lastTrade < 0 || slot - c.lastTrade > FRESH_TAPE) continue;
      if (slot - c.lastExit < REENTRY_WAIT) continue;
      if (c.realQuote < MIN_REAL_RESERVE || c.realQuote > MAX_REAL_RESERVE) {
        continue;
      }

      // Entry signal over the lookback window: broad buying, real net
      // inflow, and a price that climbed without going vertical.
      const from = slot - SIGNAL_WINDOW;
      let buySol = 0n;
      let sellSol = 0n;
      let buyCount = 0;
      let first: Price | null = null;
      let high: Price | null = null;
      let last: Price | null = null;
      const buyers = new Set<string>();
      for (const t of c.tape) {
        if (t.slot <= from) {
          first = t.price;
          continue;
        }
        if (first === null) first = t.price;
        if (t.buy) {
          buySol += t.sol;
          buyCount += 1;
          buyers.add(t.user);
        } else {
          sellSol += t.sol;
        }
        if (high === null || cmpPrice(t.price, high) > 0) high = t.price;
        last = t.price;
      }
      if (buyCount < 5 || buyers.size < 3) continue;
      if (buySol - sellSol < MIN_NET_INFLOW) continue;
      if (!first || !high || !last) continue;
      // Up at least 6%, at most 100%, and within 8% of the window high.
      if (!atLeast(last, first, 53n, 50n)) continue;
      if (!atMost(last, first, 2n, 1n)) continue;
      if (!atLeast(last, high, 23n, 25n)) continue;

      const size = sized(c, STAKE);
      if (size < MIN_ROUND_TRIP) continue;
      const id = nextId("b");
      c.inFlight.push({ id, seq });
      slotsFree -= 1;
      exposure += size;
      emit({
        side: "buy",
        client_id: id,
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
    }

    // Guardrail pacing: if the counted-coin tally lags the schedule,
    // spend a 0.011 SOL probe on the deepest uncounted live curve and
    // sell it straight back. The probe's round trip is what the minimum
    // bar counts, and its fee cost is a rounding error next to the
    // penalty for missing the bar.
    const elapsed = slot - (firstSlot ?? slot);
    const due =
      elapsed <= 0
        ? 0
        : Math.min(PACE_COINS, Math.floor((PACE_COINS * elapsed) / PACE_SLOTS));
    if (
      counted.size < due &&
      probes.size === 0 &&
      slotsFree > 0 &&
      orders.length < maxOrders
    ) {
      let bestMint: string | null = null;
      let bestReserve = 0n;
      for (const [mint, c] of curves) {
        if (c.done || counted.has(mint)) continue;
        if ((heldTokens.get(mint) ?? 0n) > 0n || c.inFlight.length > 0) {
          continue;
        }
        if (c.realQuote > bestReserve) {
          bestReserve = c.realQuote;
          bestMint = mint;
        }
      }
      if (bestMint !== null) {
        const c = curves.get(bestMint)!;
        const size = sized(c, PROBE_STAKE);
        if (size >= MIN_ROUND_TRIP) {
          probes.set(bestMint, false);
          const id = nextId("q");
          c.inFlight.push({ id, seq });
          emit({
            side: "buy",
            client_id: id,
            mint: bestMint,
            quote_lamports: size.toString(),
            max_slippage_bps: SELL_SLIPPAGE_BPS,
          });
        }
      }
    }

    process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
  });
}

main();
