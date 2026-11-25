// Entry point: a thin wrapper. The strategy lives in strategy.ts; this file
// only hands it to the harness shim, which owns the stdin/stdout wire.
import { runBot } from './vendor/makefun-bot.ts';
import { createMomentumBot } from './strategy.ts';

await runBot(createMomentumBot());
