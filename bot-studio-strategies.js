/**
 * bot-studio-strategies.js — Strategy catalog for Bot Studio cook.
 * Load BEFORE bot-studio.js.
 * User facing copy avoids ASCII hyphen characters.
 */
(function (root) {
  'use strict';

  const STRATEGIES = [
    {
      id: 'mean-revert',
      name: 'Mean reversion',
      family: 'Reversal',
      blurb: 'Price ran too far. Bet it snaps back.',
      explain: 'Classic fade of an overstretched move. You wait for price to leave its average, then enter the other way when RSI and a wick agree. Best when the market is choppy, not trending hard.',
      useWhen: 'Sideways or fading days. Avoid strong one way runs.',
      defaults: { zScore: 1.5, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: true, volRankMin: 25 }
    },
    {
      id: 'fade',
      name: 'Spike fade',
      family: 'Reversal',
      blurb: 'A sudden spike looks wrong. Fade it. Stricter — fewer live signals.',
      explain: 'Same idea as mean reversion, but tuned for sharp spikes. You want a stretch, an extreme RSI, and a rejection wick before you take the opposite side.',
      useWhen: 'News spikes and fake pumps that reverse fast.',
      defaults: { zScore: 1.8, rsiLeave: true, rsiLo: 30, rsiHi: 70, rejectionWick: true, volRankMin: 35 }
    },
    {
      id: 'bollinger',
      name: 'Bollinger bounce',
      family: 'Reversal',
      blurb: 'Touch the outer band, then bounce back in.',
      explain: 'Uses Bollinger Bands as the stretch meter. A close outside the band with RSI extreme is your setup. You enter for a move back toward the middle.',
      useWhen: 'Quiet ranges where bands are respected.',
      defaults: { zScore: 0, rsiLeave: true, rsiLo: 30, rsiHi: 70, rejectionWick: false, volRankMin: 0, useBb: true, bbPeriod: 20, bbDev: 2 }
    },
    {
      id: 'rsi-extreme',
      name: 'RSI extreme',
      family: 'Reversal',
      blurb: 'RSI is cooked. Wait for it to leave the zone.',
      explain: 'RSI only. You enter when RSI is leaving oversold or overbought, not when it first hits the wall. Clean and simple if you like one tool.',
      useWhen: 'You want a light filter set and clear RSI rules.',
      defaults: { zScore: 0, rsiLeave: true, rsiLo: 30, rsiHi: 70, rejectionWick: false, volRankMin: 0 }
    },
    {
      id: 'rsi-div',
      name: 'RSI divergence',
      family: 'Reversal',
      blurb: 'Price makes a new extreme. RSI does not.',
      explain: 'Price prints a lower low while RSI holds higher, or a higher high while RSI fails. That disagreement often marks a turn. Pair with a wick for timing.',
      useWhen: 'Exhausted swings after a long run.',
      defaults: { zScore: 1.2, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: true, volRankMin: 25, useRsiDiv: true }
    },
    {
      id: 'cci-revert',
      name: 'CCI extreme',
      family: 'Reversal',
      blurb: 'Commodity Channel Index leaves an extreme.',
      explain: 'CCI above +100 or below minus 100 marks stretch. You fade when it turns back toward zero with RSI agreeing. Popular on short charts.',
      useWhen: 'You already like oscillator fades.',
      defaults: { zScore: 0, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: true, volRankMin: 20, useCci: true, cciLo: -100, cciHi: 100 }
    },
    {
      id: 'williams',
      name: 'Williams %R',
      family: 'Reversal',
      blurb: 'Williams %R flips out of oversold or overbought.',
      explain: 'Williams %R sits near 0 when overbought and near minus 100 when oversold. A turn away from those walls with optional wick is the entry.',
      useWhen: 'Range sessions and soft trends.',
      defaults: { zScore: 0, rsiLeave: false, rejectionWick: true, volRankMin: 15, useWilliams: true, willLo: -80, willHi: -20 }
    },
    {
      id: 'pinbar',
      name: 'Pin bar',
      family: 'Candle',
      blurb: 'Long wick rejects a level. Follow that rejection.',
      explain: 'Price poked a level and got slapped back. The long wick is the story. Pair it with RSI so you are not fighting a monster trend.',
      useWhen: 'Clear highs and lows with obvious rejection wicks.',
      defaults: { zScore: 1.2, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: true, volRankMin: 25, usePinbar: true }
    },
    {
      id: 'engulfing',
      name: 'Engulfing reverse',
      family: 'Candle',
      blurb: 'A full candle eats the last one. Reversal hint.',
      explain: 'A bullish engulfing after a drop, or a bearish engulfing after a rise. Strong candle language. RSI keeps you from buying into a waterfall.',
      useWhen: 'You like candle patterns as the main trigger.',
      defaults: { zScore: 1, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: false, volRankMin: 20, useEngulfing: true }
    },
    {
      id: 'hammer',
      name: 'Hammer / shooting star',
      family: 'Candle',
      blurb: 'Classic hammer or shooting star at the edge.',
      explain: 'Hammer after a drop (long lower wick) or shooting star after a rise (long upper wick). Same rejection idea as a pin bar, with a familiar name.',
      useWhen: 'Obvious wick candles at swing turns.',
      defaults: { zScore: 1, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: true, volRankMin: 20, usePinbar: true }
    },
    {
      id: 'doji',
      name: 'Doji reverse',
      family: 'Candle',
      blurb: 'Tiny body shows indecision, then you fade.',
      explain: 'A doji after a stretch often marks hesitation. You wait for stretch plus doji, then take the reverse side with RSI confirm.',
      useWhen: 'Quiet turns after a one sided push.',
      defaults: { zScore: 1.5, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: false, volRankMin: 15, useDoji: true }
    },
    {
      id: 'morning-star',
      name: 'Morning / evening star',
      family: 'Candle',
      blurb: 'Three candle turn pattern at extremes.',
      explain: 'A drop, a small middle candle, then a strong reverse candle (morning star). Flip that for evening star. RSI keeps the filter honest.',
      useWhen: 'You want multi candle confirmation.',
      defaults: { zScore: 1, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: false, volRankMin: 20, useStar: true }
    },
    {
      id: 'stoch',
      name: 'Stochastic cross',
      family: 'Momentum',
      blurb: 'Stochastic flips in the extreme zone.',
      explain: 'Stochastic %K crosses in oversold or overbought. Classic oscillator timing. Works best when price is ranging, not when a trend is one way all day.',
      useWhen: 'Range days and soft trends.',
      defaults: { zScore: 0, rsiLeave: false, rejectionWick: false, volRankMin: 0, useStoch: true, stochLo: 20, stochHi: 80 }
    },
    {
      id: 'macd',
      name: 'MACD cross',
      family: 'Momentum',
      blurb: 'MACD line crosses the signal line.',
      explain: 'When MACD crosses above signal you look long. Cross below looks short. Optional RSI keeps you out of dead chops.',
      useWhen: 'You want a classic momentum switch.',
      defaults: { zScore: 0, rsiLeave: true, rsiLo: 40, rsiHi: 60, rejectionWick: false, volRankMin: 20, useMacd: true }
    },
    {
      id: 'fakeout',
      name: 'Fakeout reverse',
      family: 'Reversal',
      blurb: 'Break looks real, then snaps back inside.',
      explain: 'Price breaks a recent high or low, then closes back through it with a rejection wick. You fade the trapped move. Volume helps confirm the fake.',
      useWhen: 'Choppy levels that keep trapping breakout hunters.',
      defaults: { zScore: 1.5, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: true, volRankMin: 50 }
    },
    {
      id: 'breakout',
      name: 'Breakout',
      family: 'Trend',
      blurb: 'Close through a level with strength. Ride it.',
      explain: 'You want expansion, not a fade. Price stretches in one direction with volume. RSI stays with the move. This is for directional bursts, not mean snaps.',
      useWhen: 'Session opens and strong directional legs.',
      defaults: { zScore: 1.8, rsiLeave: true, rsiLo: 45, rsiHi: 55, rejectionWick: false, volRankMin: 55 }
    },
    {
      id: 'impulse',
      name: 'Impulse ride',
      family: 'Trend',
      blurb: 'A strong candle just printed. Stay with it.',
      explain: 'After a big directional candle, you look for continuation while RSI sits in a healthy momentum band. No fading. Go with the flow.',
      useWhen: 'Fresh momentum after a quiet stretch.',
      defaults: { zScore: 1.4, rsiLeave: true, rsiLo: 48, rsiHi: 52, rejectionWick: false, volRankMin: 50, useEma: true, emaFast: 10, emaSlow: 20 }
    },
    {
      id: 'pullback',
      name: 'Trend pullback',
      family: 'Trend',
      blurb: 'Trend is clear. Enter on the dip into it.',
      explain: 'EMAs stacked for direction. Wait for a pullback toward the fast EMA, then enter with the trend when RSI turns back with you.',
      useWhen: 'Clean trends with soft pullbacks.',
      defaults: { zScore: 0, rsiLeave: true, rsiLo: 40, rsiHi: 60, rejectionWick: false, volRankMin: 25, useEma: true, emaFast: 20, emaSlow: 100 }
    },
    {
      id: 'ema-cross',
      name: 'EMA cross',
      family: 'Trend',
      blurb: 'Fast EMA crosses the slow one.',
      explain: 'Simple trend switch. When the fast average crosses above the slow one you look long. Cross below looks short. Best as a filter plus a small RSI confirm.',
      useWhen: 'You want a classic moving average style.',
      defaults: { zScore: 0, rsiLeave: true, rsiLo: 45, rsiHi: 55, rejectionWick: false, volRankMin: 0, useEma: true, emaFast: 9, emaSlow: 21 }
    },
    {
      id: 'trend-follow',
      name: 'Trend follow',
      family: 'Trend',
      blurb: 'Stay with the slope. Skip the counter trade.',
      explain: 'Price and EMAs agree on direction. You only take entries that match the slope. Designed to stop you from fading a strong day.',
      useWhen: 'Trending sessions where fades keep failing.',
      defaults: { zScore: 1, rsiLeave: true, rsiLo: 42, rsiHi: 58, rejectionWick: false, volRankMin: 35, useEma: true, emaFast: 12, emaSlow: 26 }
    },
    {
      id: 'atr-break',
      name: 'ATR expansion',
      family: 'Trend',
      blurb: 'Volatility wakes up. Ride the expansion.',
      explain: 'Average True Range jumps while price stretches. You follow the move instead of fading it. Volume and RSI keep noise down.',
      useWhen: 'Quiet markets that suddenly expand.',
      defaults: { zScore: 1.5, rsiLeave: true, rsiLo: 45, rsiHi: 55, rejectionWick: false, volRankMin: 45, useAtr: true }
    },
    {
      id: 'range',
      name: 'Range bounce',
      family: 'Range',
      blurb: 'Buy support, sell resistance inside a box.',
      explain: 'Sideways market. Stretch to the edge of the recent range, RSI flips, wick rejects. You trade the bounce back into the middle.',
      useWhen: 'Dead hours and clean horizontal boxes.',
      defaults: { zScore: 1.6, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: true, volRankMin: 20 }
    },
    {
      id: 'range-flip',
      name: 'Range flip',
      family: 'Range',
      blurb: 'Range breaks, then retests the flipped level.',
      explain: 'First the box breaks. Then price comes back to kiss the old edge from the other side. You enter on that retest with a confirmation candle.',
      useWhen: 'A quiet range that finally expands.',
      defaults: { zScore: 1.2, rsiLeave: false, rejectionWick: true, volRankMin: 40 }
    },
    {
      id: 'support-resist',
      name: 'Level bounce',
      family: 'Range',
      blurb: 'Respect a clear high or low from recent bars.',
      explain: 'Uses recent swing highs and lows as levels. A touch plus rejection and RSI turn is the entry. Simple structure trading for short expiries.',
      useWhen: 'Obvious swing levels on your chart.',
      defaults: { zScore: 1, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: true, volRankMin: 20 }
    },
    {
      id: 'double-top',
      name: 'Double top / bottom',
      family: 'Range',
      blurb: 'Second touch fails. Fade the fake break.',
      explain: 'Price revisits a recent high or low and fails with a rejection wick. Classic double top or double bottom timing with RSI support.',
      useWhen: 'Clear twin peaks or twin lows.',
      defaults: { zScore: 1.2, rsiLeave: true, rsiLo: 35, rsiHi: 65, rejectionWick: true, volRankMin: 25, useDouble: true }
    },
    {
      id: 'squeeze',
      name: 'Squeeze breakout',
      family: 'Momentum',
      blurb: 'Bands got tight. Wait for the pop.',
      explain: 'Volatility contracted. When price closes outside a tight Bollinger with volume waking up, you ride the expansion. RSI should agree with the direction.',
      useWhen: 'Long quiet stretches before a burst.',
      defaults: { zScore: 0, rsiLeave: true, rsiLo: 45, rsiHi: 55, rejectionWick: false, volRankMin: 40, useBb: true, bbPeriod: 20, bbDev: 2 }
    },
    {
      id: 'vwap',
      name: 'VWAP revert',
      family: 'Reversal',
      blurb: 'Price stretches away from session VWAP.',
      explain: 'A rolling volume weighted mid acts like a magnet. When price is far from it and RSI is extreme, you fade back toward the mid.',
      useWhen: 'Intraday mean snaps around a fair price.',
      defaults: { zScore: 1.8, rsiLeave: true, rsiLo: 32, rsiHi: 68, rejectionWick: true, volRankMin: 30, useVwap: true }
    },
    {
      id: 'heikin',
      name: 'Heikin trend',
      family: 'Trend',
      blurb: 'Heikin Ashi color flips with the trend.',
      explain: 'Smoothed Heikin style candles. You enter with the color change and keep EMA and RSI on your side so you are not fighting noise.',
      useWhen: 'You want smoother trend following.',
      defaults: { zScore: 0, rsiLeave: true, rsiLo: 42, rsiHi: 58, rejectionWick: false, volRankMin: 20, useEma: true, emaFast: 8, emaSlow: 21, useHeikin: true }
    },
    {
      id: 'scalp',
      name: 'Scalp snap',
      family: 'Momentum',
      blurb: 'Tiny stretch, quick decision, 1 minute out.',
      explain: 'Faster filters and a lighter stretch need. Built for 5 second and 15 second charts where you want more tries, still with RSI and wick discipline.',
      useWhen: 'You want more frequency on fast charts.',
      defaults: { zScore: 1.4, rsiLeave: true, rsiLo: 34, rsiHi: 66, rejectionWick: true, volRankMin: 35 }
    },
    {
      id: 'custom',
      name: 'Custom mix',
      family: 'Custom',
      blurb: 'Blank slate. Toggle only what you want.',
      explain: 'No opinion baked in. Turn on stretch, RSI, Bollinger, EMA, Stochastic, wicks, or volume yourself and set the numbers. Best if you already know your recipe.',
      useWhen: 'You want full control from zero.',
      defaults: { zScore: 0, rsiLeave: false, rsiLo: 30, rsiHi: 70, rejectionWick: false, volRankMin: 0 }
    }
  ];

  const FAMILIES = ['All', 'Reversal', 'Trend', 'Range', 'Momentum', 'Candle', 'Custom'];

  const FAMILY_TIPS = {
    All: {
      title: 'All ideas',
      body: 'Every strategy in the kitchen. Start here if you are still feeling it out.',
      useWhen: 'You want to browse without a filter.'
    },
    Reversal: {
      title: 'Reversal',
      body: 'Price ran too far. These ideas wait for stretch, then bet it snaps back.',
      useWhen: 'Choppy or fading days, not strong one way runs.'
    },
    Trend: {
      title: 'Trend',
      body: 'Ride the move. Averages and momentum have to agree before you join.',
      useWhen: 'Clear direction, not a tight range.'
    },
    Range: {
      title: 'Range',
      body: 'Buy the floor, sell the ceiling. These like a market that stays in a box.',
      useWhen: 'Quiet sessions that bounce the same levels.'
    },
    Momentum: {
      title: 'Momentum',
      body: 'Something just woke up. You want follow through, not a fade.',
      useWhen: 'Breaks, squeezes, and fast charts.'
    },
    Candle: {
      title: 'Candle',
      body: 'The last candle is the story. Wicks, engulfing, hammers, doji.',
      useWhen: 'You like reading a single bar more than a pile of numbers.'
    },
    Custom: {
      title: 'Custom',
      body: 'Blank slate. You turn on only what you want.',
      useWhen: 'You already know the recipe.'
    }
  };

  function byId(id) {
    const key = String(id || '');
    for (let i = 0; i < STRATEGIES.length; i++) {
      if (STRATEGIES[i].id === key) return STRATEGIES[i];
    }
    return STRATEGIES[0];
  }

  function labelOf(id) {
    return byId(id).name;
  }

  function familyTip(name) {
    return FAMILY_TIPS[name] || FAMILY_TIPS.All;
  }

  function famSlug(name) {
    const s = String(name || 'custom').toLowerCase().replace(/[^a-z]/g, '');
    return s || 'custom';
  }

  const api = {
    list: STRATEGIES,
    families: FAMILIES,
    byId: byId,
    labelOf: labelOf,
    familyTip: familyTip,
    famSlug: famSlug
  };

  try { root.__utkStudioStrategies = api; } catch (e) {}
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
