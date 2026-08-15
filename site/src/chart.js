/**
 * TradingView Lightweight Charts, bundled and served from our own origin.
 *
 * Three TradingView products get confused with each other:
 *
 *   - The **widget** only renders symbols already listed on exchanges TradingView carries, so
 *     it cannot plot a coin that exists on one bonding curve. Not usable here at all.
 *   - The **Advanced Charting Library** is what pump.fun and GMGN run — it carries the "Chart
 *     by TradingView" badge, the indicator and drawing toolbars, the interval dropdown and the
 *     settings dialog. Free, but access is granted on application and it expects a UDF datafeed
 *     server rather than a plain array of candles.
 *   - **Lightweight Charts** is this one: Apache-2.0, no key, no application, candles straight
 *     from the indexer. It draws and interacts, but it ships no toolbars — anything resembling
 *     one has to be built above it, which is what coin.html does for interval, series type and
 *     the price/mcap switch.
 *
 * Self-hosted rather than loaded from a CDN, so the page keeps working with no third-party
 * request and runs against a local indexer with no internet.
 */
import {
  createChart, CandlestickSeries, BarSeries, LineSeries, AreaSeries, HistogramSeries,
  CrosshairMode, LineType,
} from 'lightweight-charts';

const UP = '#5fe3a1', DOWN = '#ff6b81';
const OHLC = new Set(['candles', 'hollow', 'bars', 'hlc']);

/**
 * The series types this library can express.
 *
 * Two of the nine on pump.fun's menu are missing and cannot be faked: **HLC area**, which needs
 * a band between high and low, and per-candle fill control beyond what hollow candles give.
 * Everything else here is a real option on CandlestickSeries / BarSeries / LineSeries.
 */
const SERIES = {
  candles: { type: CandlestickSeries, options: {
    upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN } },
  // Hollow = an unfilled body with a coloured border, which is a transparent fill here.
  hollow: { type: CandlestickSeries, options: {
    upColor: 'rgba(0,0,0,0)', downColor: 'rgba(0,0,0,0)', borderVisible: true,
    borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN } },
  bars: { type: BarSeries, options: { upColor: UP, downColor: DOWN, thinBars: false } },
  hlc: { type: BarSeries, options: { upColor: UP, downColor: DOWN, thinBars: false, openVisible: false } },
  line: { type: LineSeries, options: { color: '#e879f9', lineWidth: 2 } },
  markers: { type: LineSeries, options: { color: '#e879f9', lineWidth: 2, pointMarkersVisible: true } },
  step: { type: LineSeries, options: { color: '#e879f9', lineWidth: 2, lineType: LineType.WithSteps } },
  area: { type: AreaSeries, options: {
    lineColor: '#e879f9', lineWidth: 2,
    topColor: 'rgba(232,121,249,.34)', bottomColor: 'rgba(232,121,249,0)' } },
};

export function mountChart(el, { priceFormatter }) {
  const chart = createChart(el, {
    layout: {
      background: { color: 'transparent' },
      textColor: '#8a93a3',
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,.04)' },
      horzLines: { color: 'rgba(255,255,255,.04)' },
    },
    rightPriceScale: { borderColor: 'rgba(255,255,255,.08)', scaleMargins: { top: 0.08, bottom: 0.26 } },
    timeScale: { borderColor: 'rgba(255,255,255,.08)', timeVisible: true, secondsVisible: false },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: 'rgba(232,121,249,.45)', labelBackgroundColor: '#a855f7' },
      horzLine: { color: 'rgba(232,121,249,.45)', labelBackgroundColor: '#a855f7' },
    },
    // Off by default in the library: without these the wheel does nothing and dragging the
    // right-hand axis does not stretch the price scale.
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: {
      mouseWheel: true, pinch: true,
      axisPressedMouseMove: { time: true, price: true },
      axisDoubleClickReset: { time: true, price: true },
    },
    localization: { priceFormatter },
    autoSize: true,
  });

  // Meme-coin prices sit far below a cent, where the library's default 2-decimal format prints
  // every value as 0.00 and the whole series collapses onto one line.
  const priceFormat = { type: 'custom', formatter: priceFormatter, minMove: 1e-12 };

  const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  // Declared before the series so it can be handed in at creation; the wheel handler below
  // only ever changes `zoom` and asks for a recalculation.
  let zoom = 1;
  const autoscaleInfoProvider = (original) => {
    const res = original();
    if (!res?.priceRange || zoom === 1) return res;
    const { minValue, maxValue } = res.priceRange;
    const mid = (minValue + maxValue) / 2;
    const half = ((maxValue - minValue) / 2) * zoom;
    return { ...res, priceRange: { minValue: mid - half, maxValue: mid + half } };
  };
  const seriesOpts = () => ({ ...SERIES[kind].options, priceFormat, autoscaleInfoProvider });

  let kind = 'candles';
  let series = chart.addSeries(SERIES[kind].type, seriesOpts());
  let rows = [];

  /** Whole seconds, strictly ascending, no duplicates — a repeated second throws. */
  const normalise = (data, scale) => {
    const seen = new Set();
    return data.map((k) => {
      let t = Math.floor(k.t / 1000);
      while (seen.has(t)) t++;
      seen.add(t);
      return { time: t, o: k.o * scale, h: k.h * scale, l: k.l * scale, c: k.c * scale, v: k.v };
    });
  };

  const paint = (clean) => {
    const ohlc = (k) => ({ time: k.time, open: k.o, high: k.h, low: k.l, close: k.c });
    const flat = (k) => ({ time: k.time, value: k.c });
    series.setData(clean.map(OHLC.has(kind) ? ohlc : flat));
    volume.setData(clean.map((k) => ({
      time: k.time, value: k.v,
      color: k.c >= k.o ? 'rgba(95,227,161,.35)' : 'rgba(255,107,129,.35)',
    })));
  };

  let scale = 1;

  /**
   * Wheel over the price axis widens or narrows the visible price range, leaving the time axis
   * — and so the candle widths — untouched.
   *
   * `autoscaleInfoProvider` is the supported hook for this: the library asks the series what
   * range to show, and this returns the fitted range stretched by a factor around its own
   * centre. Zoomed far enough out the bounds run past the data and into negative prices, which
   * is exactly what other terminals show and is the sign that a range is set rather than fitted.
   *
   * Two earlier attempts were wrong and are recorded so they are not retried: nudging
   * `scaleMargins` only ever rescales *around* the data, so a coin whose whole history spans a
   * dollar never left $2,000; and replaying the wheel as a synthetic drag moved the scale
   * inconsistently, sometimes backwards, because it leans on internals the library does not
   * promise.
   */
  const AXIS_HIT = 70;                 // px from the right edge that count as "on the axis"
  const ZOOM_STEP = 1.35, ZOOM_MIN = 1, ZOOM_MAX = 400;

  el.addEventListener('wheel', (e) => {
    const r = el.getBoundingClientRect();
    if (e.clientX < r.right - AXIS_HIT) return;      // over the plot: leave time zoom alone
    e.preventDefault();
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * (e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
    // Re-applying the option is what makes the library ask for the range again.
    series.applyOptions({ autoscaleInfoProvider });
  }, { passive: false });

  return {
    /**
     * @param {{t:number,o:number,h:number,l:number,c:number,v:number}[]} data
     * @param {{scale?:number, fit?:boolean}} opts  scale turns price into market cap
     */
    setData(data, { scale: s = 1, fit = true } = {}) {
      rows = data; scale = s;
      paint(normalise(rows, scale));
      if (fit) chart.timeScale().fitContent();
    },
    setType(next) {
      if (!SERIES[next] || next === kind) return;
      chart.removeSeries(series);
      kind = next;
      series = chart.addSeries(SERIES[kind].type, seriesOpts());
      paint(normalise(rows, scale));
    },
    setVolumeVisible(on) { volume.applyOptions({ visible: on }); },
    /** Both axes back to fitting the data. */
    resetZoom() {
      zoom = 1;
      series.applyOptions({ autoscaleInfoProvider });
      chart.priceScale('right').applyOptions({ autoScale: true });
      chart.timeScale().fitContent();
    },
    /** Current price-axis zoom factor, 1 = fit. Exposed so a test can observe it. */
    priceZoom: () => zoom,
    /** Synchronous render to a detached canvas. Used to verify drawing without a visible tab. */
    screenshot: () => chart.takeScreenshot(),
    remove: () => chart.remove(),
  };
}
