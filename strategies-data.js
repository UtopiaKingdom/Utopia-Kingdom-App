/*
  strategies-data.js
  Content + chart metadata for Trading Strategies section.
*/
(function () {
  'use strict';

  const STRATEGIES = [
    {
      id: 'strategy1',
      name: 'Mean Reversion Strategy',
      tagline: 'Trade price pullbacks using Bollinger Bands and RSI',
      timeframe: '1m',
      expiry: '3 min',
      chartType: 'meanReversion',
      chartCaption: 'Best entry: price closes outside the band while RSI is extreme, then snaps back toward the mean.',
      objective: 'Take advantage of price pullbacks by trading when the price moves far from its average and shows signs of snapping back.',
      indicators: [
        'Bollinger Bands · Period 20, Deviation 2',
        'RSI · Period 14'
      ],
      buy: [
        'Price closes below the lower Bollinger Band',
        'RSI is below 30'
      ],
      sell: [
        'Price closes above the upper Bollinger Band',
        'RSI is above 70'
      ],
      notes: ''
    },
    {
      id: 'strategy2',
      name: 'Breakout Strategy',
      tagline: 'Capitalize on strong moves through key levels',
      timeframe: '5m',
      expiry: '10 min',
      chartType: 'breakout',
      chartCaption: 'Best entry: candle closes through resistance with EMAs stacked and volume above average.',
      objective: 'Capitalize on strong price movements that occur when the price breaks through significant support or resistance levels, indicating the start of a new trend.',
      indicators: [
        'EMA 20',
        'EMA 50'
      ],
      buy: [
        'Price breaks above a key resistance level',
        'Candle closes above both EMA 20 and EMA 50',
        'Volume is higher than the average of the last 20 candles'
      ],
      sell: [
        'Price breaks below a key support level',
        'Candle closes below both EMA 20 and EMA 50',
        'Volume is higher than the average of the last 20 candles'
      ],
      notes: ''
    },
    {
      id: 'strategy3',
      name: 'Momentum Pullback Strategy',
      tagline: 'Enter on pullbacks within strong trends',
      timeframe: '15m',
      expiry: '20 to 30 min',
      chartType: 'pullback',
      chartCaption: 'Best entry: in an uptrend, wait for a pullback to EMA 20, then enter when RSI turns back up.',
      objective: 'Take advantage of temporary pullbacks within a strong trend, entering trades when the price resumes in the direction of the prevailing momentum.',
      indicators: [
        'EMA 20 and EMA 100',
        'RSI (14)'
      ],
      buy: [
        'EMA 20 is above EMA 100 (uptrend confirmed)',
        'Price pulls back near or slightly below EMA 20 but stays above EMA 100',
        'RSI drops below 50 during pullback and turns upward',
        'Bullish candle closes above EMA 20'
      ],
      sell: [
        'EMA 20 is below EMA 100 (downtrend confirmed)',
        'Price pulls back near or slightly above EMA 20 but stays below EMA 100',
        'RSI rises above 50 during pullback and turns downward',
        'Bearish candle closes below EMA 20'
      ],
      notes: ''
    },
    {
      id: 'strategy4',
      name: 'Fakeout Reversal Strategy',
      tagline: 'Catch reversals after false breakouts',
      timeframe: '3m',
      expiry: '6 to 9 min',
      chartType: 'fakeout',
      chartCaption: 'Best entry: after a false break beyond a key level, enter when price closes back inside with a rejection wick.',
      objective: 'Take advantage of moments when price fakes a breakout beyond a key level and then sharply reverses. Ideal for catching moves against trapped retail traders.',
      indicators: [
        'Support / Resistance levels',
        'Volume',
        'Stochastic (14, 3, 3)',
        'EMA 100 · trend filter'
      ],
      buy: [
        'Price breaks below support but closes back above it (false breakdown)',
        'Candle shows a long lower wick (rejection)',
        'Stochastic turns upward below 20',
        'Volume spike during the false breakout',
        'EMA 100 is below price or flat'
      ],
      sell: [
        'Price breaks above resistance but closes back below it (false breakout)',
        'Candle shows a long upper wick (rejection)',
        'Stochastic turns downward above 80',
        'Volume spike during the breakout',
        'EMA 100 is above price or flat'
      ],
      notes: ''
    },
    {
      id: 'strategy5',
      name: 'Impulse Continuation Strategy',
      tagline: 'Ride momentum after strong breakout candles',
      timeframe: '1 to 3m',
      expiry: '5 to 7 min',
      chartType: 'impulse',
      chartCaption: 'Best entry: right after a strong impulse candle through a swing high, while RSI stays in the 50 to 70 zone.',
      objective: 'Ride the momentum right after a strong breakout candle, aiming to catch fast, directional moves. No mean reversion. Go with the flow.',
      indicators: [
        'EMA 10 · short term trend',
        'EMA 20 · secondary trend',
        'RSI (14) · momentum strength'
      ],
      buy: [
        'Price breaks above a recent swing high with a strong bullish candle',
        'RSI is between 50 and 70',
        'EMA 10 is above EMA 20',
        'Enter on breakout close (aggressive) or retest (conservative)'
      ],
      sell: [
        'Price breaks below a recent swing low with a strong bearish candle',
        'RSI is between 30 and 50',
        'EMA 10 is below EMA 20',
        'Enter on candle close or retest of breakdown level'
      ],
      notes: 'Works better in directional markets. Ideal for the first or second impulse wave of a new trend.'
    },
    {
      id: 'strategy6',
      name: 'Range Rebound Strategy',
      tagline: 'Trade bounces in sideways markets',
      timeframe: '5m',
      expiry: '8 to 10 min',
      chartType: 'range',
      chartCaption: 'Best entry: at the edge of a clean range when RSI flips from oversold or overbought and a rejection candle prints.',
      objective: 'Exploit sideways price action by trading near well defined support and resistance levels, anticipating bounces within the range.',
      indicators: [
        'Support and Resistance zones',
        'RSI (14)',
        'ATR (14) · confirm range stability'
      ],
      buy: [
        'Price touches or dips slightly below established support',
        'RSI is below 35 and starting to turn up',
        'ATR is low or declining (range condition)',
        'Bullish candle pattern near support (hammer / engulfing)'
      ],
      sell: [
        'Price touches or slightly breaks above established resistance',
        'RSI is above 65 and starting to turn down',
        'ATR remains low or declining',
        'Bearish candle pattern near resistance (shooting star / engulfing)'
      ],
      notes: 'Avoid news and high volatility sessions. Refresh range zones every 1 to 2 hours.'
    },
    {
      id: 'strategy7',
      name: 'Range Flip Retest Strategy',
      tagline: 'Trade retests after range breakouts',
      timeframe: '5 to 15m',
      expiry: '10 to 20 min',
      chartType: 'rangeFlip',
      chartCaption: 'Best entry: after the range breaks, wait for the retest of the flipped level and a confirmation candle.',
      objective: 'Trade the moment when a range breaks, then price comes back to retest the broken range from the other side. Sideways markets turning into trends.',
      indicators: [
        'Candlestick confirmation only'
      ],
      buy: [
        'Identify a clean range (3 to 5 touches on both sides)',
        'Price breaks above resistance with a strong bullish candle',
        'Price retests old resistance (now support)',
        'Bullish confirmation candle at the retest',
        'Enter on close of confirmation candle'
      ],
      sell: [
        'Identify a range with clean horizontal support',
        'Price breaks below support with a strong bearish candle',
        'Price retests underside of old support (now resistance)',
        'Bearish candle rejects the retest',
        'Enter on the close'
      ],
      notes: 'Works best when an asset transitions from consolidation to trend.'
    },
    {
      id: 'strategy8',
      name: 'Spike Reversal Strategy',
      tagline: 'Catch reversals from volume spikes',
      timeframe: '5 to 15m',
      expiry: '15 to 20 min',
      chartType: 'spike',
      chartCaption: 'Best entry: at key support or resistance when MACD momentum fades and price rejects EMA 50.',
      objective: 'Catch sharp reversals triggered by sudden volume spikes near key support or resistance, confirmed by EMA trend filters and momentum signals.',
      indicators: [
        'MACD (12, 26, 9)',
        'EMA 50 · trend filter',
        'Support and Resistance levels'
      ],
      buy: [
        'Price approaches strong support',
        'MACD histogram shows decreasing bearish momentum',
        'EMA 50 is flat or sloping upward',
        'Price closes above EMA 50 or bounces off it',
        'Enter on close of the reversal candle'
      ],
      sell: [
        'Price approaches strong resistance',
        'MACD histogram shows decreasing bullish momentum',
        'EMA 50 is flat or sloping downward',
        'Price closes below EMA 50 or is rejected by it',
        'Enter on close of the reversal candle'
      ],
      notes: 'EMA 50 helps avoid fighting strong trends. Volume spikes often mark exhaustion.'
    },
    {
      id: 'strategy9',
      name: 'Volatility Contraction Breakout',
      tagline: 'Trade explosive moves after low volatility',
      timeframe: '5 to 15m',
      expiry: '10 to 15 min',
      chartType: 'squeeze',
      chartCaption: 'Best entry: after a Bollinger squeeze, when price closes outside the band with ATR expanding.',
      objective: 'Identify periods of low volatility where price tightens before an explosive breakout, catching strong momentum as volatility expands.',
      indicators: [
        'Bollinger Bands · Period 20, Deviation 2',
        'ATR (14)',
        'RSI (14) · optional momentum filter'
      ],
      buy: [
        'Bollinger Bands narrow significantly (squeeze)',
        'ATR drops below its recent average',
        'Price breaks and closes above the upper band with a strong bullish candle',
        'RSI is rising but below 70'
      ],
      sell: [
        'Bollinger Bands narrow significantly (squeeze)',
        'ATR drops below its recent average',
        'Price breaks and closes below the lower band with a strong bearish candle',
        'RSI is falling but above 30'
      ],
      notes: ''
    }
  ];

  try { if (typeof window !== 'undefined') window.UTK_STRATEGIES = STRATEGIES; } catch (e) {}
  try {
    module.exports = STRATEGIES;
  } catch (e) {}
})();

