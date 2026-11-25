// Momentum paper-trading bot for pump.fun (agent-fun/replay/v2).
//
// Idea, in one sentence: buy a new coin once its price has already started
// running up, then get out quickly on a profit target, a stop-loss, or age.
//
// Why this shape: pump.fun bonding curves mostly dump after their first
// spike, so holding is a losing game. The edge, if any, is riding the first
// minutes of a move and leaving before the crowd does. Every decision here
// is deterministic — no clock, no environment, no Math.random — so the two
// grading runs produce byte-identical action logs.
//
// Price is always the ratio virtual_quote_reserves / virtual_token_reserves.
// All comparisons are BigInt cross-multiplications, never floats, so the
// same inputs always give the same decision.

import {
  LAMPORTS_PER_SOL,
  type Bot,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

export type BotMode = 'momentum' | 'dip' | 'hold';

// ---- tuned parameters (defaults; see backtest notes in README) ----
export interface MomentumParams {
  mode: BotMode;
  stakeLamports: bigint;
  minTrades: number;
  entryRiseBps: number; // momentum: price must be up >= this from first-seen
  dipBps: number; // dip: price must be down >= this from first-seen
  takeProfitBps: number; // sell when up >= this from entry
  bounceBps: number; // dip: sell when up >= this from entry
  stopLossBps: number; // sell when down >= this from entry
  maxHoldSlots: number; // sell when held longer than this
  maxEntryAgeSlots: number; // only buy coins created within this many slots
  buySlippageBps: number;
  sellSlippageBps: number;
  flowWindow: number; // last N trades considered for buy-pressure
  minBuyShareBps: number; // buys must be >= this share of recent flow (bps)
}

export const DEFAULT_PARAMS: MomentumParams = {
  mode: 'momentum',
  stakeLamports: LAMPORTS_PER_SOL / 20n, // 0.05 SOL per buy
  minTrades: 5, // trades seen before a coin can be bought
  entryRiseBps: 500, // 5%
  dipBps: 1000, // 10% (dip mode only)
  takeProfitBps: 800, // 8%
  bounceBps: 1500, // 15% (dip mode only)
  stopLossBps: 300, // 3%
  maxHoldSlots: 300,
  maxEntryAgeSlots: 1200,
  buySlippageBps: 200,
  sellSlippageBps: 100,
  flowWindow: 10,
  minBuyShareBps: 10000, // 100% of recent traded SOL must be buys
};

interface FlowTrade {
  isBuy: boolean;
  sol: bigint;
}

interface CoinNote {
  firstVq: bigint;
  firstVt: bigint;
  createdSlot: number;
  trades: number;
  bought: boolean;
  entryVq: bigint | null;
  entryVt: bigint | null;
  entrySlot: number;
  flow: FlowTrade[];
}

/** priceA >= priceB by the given basis points: aVq/aVt >= bVq/bVt * (10000+bps)/10000 */
function upByAtLeast(aVq: bigint, aVt: bigint, bVq: bigint, bVt: bigint, bps: number): boolean {
  return aVq * bVt * 10_000n >= bVq * aVt * BigInt(10_000 + bps);
}

/** priceA <= priceB by the given basis points: aVq/aVt <= bVq/bVt * (10000-bps)/10000 */
function downByAtLeast(aVq: bigint, aVt: bigint, bVq: bigint, bVt: bigint, bps: number): boolean {
  return aVq * bVt * 10_000n <= bVq * aVt * BigInt(10_000 - bps);
}

export function createMomentumBot(overrides: Partial<MomentumParams> = {}): Bot {
  const p: MomentumParams = { ...DEFAULT_PARAMS, ...overrides };
  const notes = new Map<string, CoinNote>();

  return {
    onBatch(state: BotState, batch): OrderInput[] {
      const { caps } = state.hello;
      const tx = state.txFeeLamports();
      const orders: OrderInput[] = [];

      // Learn what this batch shows us: new coins and their trade counts.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!notes.has(e.mint)) {
            notes.set(e.mint, {
              firstVq: BigInt(e.virtual_quote_reserves),
              firstVt: BigInt(e.virtual_token_reserves),
              createdSlot: e.slot,
              trades: 0,
              bought: false,
              entryVq: null,
              entryVt: null,
              entrySlot: 0,
              flow: [],
            });
          }
        } else if (e.event === 'TradeEvent') {
          const note = notes.get(e.mint);
          if (note === undefined) {
            // First met through a trade: current reserves are the baseline.
            const curve = state.curves.get(e.mint);
            if (curve !== undefined) {
              notes.set(e.mint, {
                firstVq: curve.virtual_quote_reserves,
                firstVt: curve.virtual_token_reserves,
                createdSlot: curve.created_slot ?? state.slot,
                trades: 1,
                bought: false,
                entryVq: null,
                entryVt: null,
                entrySlot: 0,
                flow: [{ isBuy: e.is_buy, sol: BigInt(e.sol_amount) }],
              });
            }
          } else {
            note.trades += 1;
            note.flow.push({ isBuy: e.is_buy, sol: BigInt(e.sol_amount) });
            if (note.flow.length > p.flowWindow) note.flow.shift();
          }
        }
      }

      // Exits first: every held position is checked against profit, loss, age.
      // 'hold' mode never sells voluntarily; the harness closes on complete/flatten.
      for (const [mint, holding] of state.positions) {
        if (p.mode === 'hold') break;
        const note = notes.get(mint);
        const curve = state.curves.get(mint);
        if (note === undefined || curve === undefined || curve.complete) continue;
        if (note.entryVq === null || note.entryVt === null) continue;
        const curVq = curve.virtual_quote_reserves;
        const curVt = curve.virtual_token_reserves;
        // Once the ride has paid for itself, bank it — the curve rarely gives a second gift.
        const exitTargetBps = p.mode === 'dip' ? p.bounceBps : p.takeProfitBps;
        const tookProfit = upByAtLeast(curVq, curVt, note.entryVq, note.entryVt, exitTargetBps);
        const stoppedOut = downByAtLeast(curVq, curVt, note.entryVq, note.entryVt, p.stopLossBps);
        const tooOld = state.slot - note.entrySlot > p.maxHoldSlots;
        if (tookProfit || stoppedOut || tooOld) {
          const sell: SellInput = {
            side: 'sell',
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: p.sellSlippageBps,
          };
          orders.push(sell);
        }
      }

// A buy bets the crowd is still arriving, not that the coin is worth anything.
      // Entries: one buy per coin, only while a position slot and cash are free.
      let free = state.freeCashLamports();
      let slots = caps.max_open_positions - state.committedPositionCount();
      for (const e of batch.events) {
        if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
        if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
        const note = notes.get(e.mint);
        if (note === undefined || note.bought) continue;
        if (state.positions.has(e.mint)) continue;
        const curve = state.curves.get(e.mint);
        if (curve === undefined || curve.complete) continue;
        if (note.trades < p.minTrades) continue;
        if (state.slot - note.createdSlot > p.maxEntryAgeSlots) continue;
        const cap = state.maxBuyLamports(e.mint);
        if (cap < p.stakeLamports) continue;
        const curVq = curve.virtual_quote_reserves;
        const curVt = curve.virtual_token_reserves;
        const signal =
          p.mode === 'dip'
            ? downByAtLeast(curVq, curVt, note.firstVq, note.firstVt, p.dipBps)
            : p.mode === 'hold'
              ? true
              : upByAtLeast(curVq, curVt, note.firstVq, note.firstVt, p.entryRiseBps);
        if (!signal) continue;
        // Buy pressure: most of the recent traded SOL must be buys, so the
        // rise is live flow, not a stale print.
        if (p.mode !== 'hold' && note.flow.length >= 5) {
          let buySol = 0n;
          let allSol = 0n;
          for (const t of note.flow) {
            allSol += t.sol;
            if (t.isBuy) buySol += t.sol;
          }
          if (allSol === 0n || buySol * 10_000n < allSol * BigInt(p.minBuyShareBps)) continue;
        }
        if (free < p.stakeLamports + tx) continue;
        const buy: BuyInput = {
          side: 'buy',
          mint: e.mint,
          quote_lamports: p.stakeLamports,
          max_slippage_bps: p.buySlippageBps,
        };
        orders.push(buy);
        note.bought = true;
        note.entryVq = curVq;
        note.entryVt = curVt;
        note.entrySlot = state.slot;
        free -= p.stakeLamports + tx;
        slots -= 1;
      }

      return orders;
    },
  };
}
