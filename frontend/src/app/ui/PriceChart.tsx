"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  createChart,
  ColorType,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

export type SeriesPoint = { t: number; p: number | null };

function toLineData(points?: SeriesPoint[]): LineData[] {
  if (!points) return [];
  const mapped: LineData[] = points
    .filter((d) => d && d.p != null)
    .map((d) => ({ time: Math.floor(d.t / 1000) as UTCTimestamp, value: Number(d.p) }));
  mapped.sort((a, b) => (a.time as number) - (b.time as number));
  const out: LineData[] = [];
  for (const it of mapped) {
    if (out.length === 0) {
      out.push(it);
      continue;
    }
    const prev = out[out.length - 1];
    const pt = it.time as number;
    const prevT = prev.time as number;
    if (pt > prevT) {
      out.push(it);
    } else {
      out[out.length - 1] = it;
    }
  }
  return out;
}

export default function PriceChart({
  data,
  bid,
  ask,
  height = 220,
}: {
  data: SeriesPoint[];
  bid?: SeriesPoint[];
  ask?: SeriesPoint[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lastSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bidSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const askSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  const last = useMemo(() => toLineData(data), [data]);
  const bidL = useMemo(() => toLineData(bid), [bid]);
  const askL = useMemo(() => toLineData(ask), [ask]);

  const makeTickFormatter = (compact: boolean, spanHours?: number) =>
    (t: Time, tm: TickMarkType, locale: string) => {
      const toDate = (tt: Time): Date => {
        if (typeof tt === "number") return new Date((tt as UTCTimestamp) * 1000);
        const anyT: any = tt as any;
        return new Date(anyT.year, (anyT.month ?? 1) - 1, anyT.day ?? 1);
      };
      const d = toDate(t);
      const mon = d.toLocaleString(locale || undefined, { month: "short" });
      const day = d.getDate();
      const yr = d.getFullYear();
      const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
      const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const showTimeWithDate = (spanHours ?? 0) <= 72;

      switch (tm) {
        case TickMarkType.Year:
          return String(yr);
        case TickMarkType.Month:
          return mon;
        case TickMarkType.DayOfMonth:
          return showTimeWithDate ? `${mon} ${day} ${hhmm}` : `${mon} ${day}`;
        case TickMarkType.Time:
        case TickMarkType.TimeWithSeconds:
          return compact ? hhmm : `${mon} ${day} ${hhmm}`;
        default:
          return `${mon} ${day}`;
      }
    };

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#111827" },
      grid: { vertLines: { color: "#f3f4f6" }, horzLines: { color: "#f3f4f6" } },
      rightPriceScale: {
        mode: 0,
        borderVisible: false,
        scaleMargins: { top: 0.2, bottom: 0.2 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        // Will be updated after data load for compact/non-compact and span-aware formatting
        tickMarkFormatter: makeTickFormatter(false, undefined),
      },
      crosshair: { horzLine: { visible: false }, mode: 1 },
      localization: {
        priceFormatter: (p: number) => `${(p * 100).toFixed(1)}¢`,
        timeFormatter: (ts: UTCTimestamp) => {
          const d = new Date(ts * 1000);
          return d.toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
        },
      },
    });
    chartRef.current = chart;
    const rect = containerRef.current.getBoundingClientRect();
    chart.applyOptions({ width: Math.max(200, Math.floor(rect.width)) });
    const lastSeries = chart.addLineSeries({ color: "#111827", lineWidth: 2 });
    const bidSeries = chart.addLineSeries({ color: "#0ea5e9", lineWidth: 1, lineStyle: 0, priceLineVisible: false });
    const askSeries = chart.addLineSeries({ color: "#ef4444", lineWidth: 1, lineStyle: 0, priceLineVisible: false });
    lastSeriesRef.current = lastSeries;
    bidSeriesRef.current = bidSeries;
    askSeriesRef.current = askSeries;

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      chartRef.current.applyOptions({ width: Math.max(200, Math.floor(rect.width)) });
    });
    ro.observe(containerRef.current);
    roRef.current = ro;

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      lastSeriesRef.current = null;
      bidSeriesRef.current = null;
      askSeriesRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    if (!lastSeriesRef.current || !chartRef.current) return;
    lastSeriesRef.current.setData(last);
    if (last.length > 0) {
      const first = last[0]?.time as UTCTimestamp | undefined;
      const lastT = last[last.length - 1]?.time as UTCTimestamp | undefined;
      if (first && lastT) {
        const d0 = new Date((first as number) * 1000);
        const d1 = new Date((lastT as number) * 1000);
        const compact = d0.toDateString() === d1.toDateString();
        const spanHours = Math.max(1, (d1.getTime() - d0.getTime()) / 3600000);
        chartRef.current.applyOptions({ timeScale: { tickMarkFormatter: makeTickFormatter(compact, spanHours) } });
      }
      chartRef.current.timeScale().fitContent();
    }
  }, [last]);

  useEffect(() => {
    if (!bidSeriesRef.current) return;
    bidSeriesRef.current.setData(bidL);
  }, [bidL]);

  useEffect(() => {
    if (!askSeriesRef.current) return;
    askSeriesRef.current.setData(askL);
  }, [askL]);

  return <div ref={containerRef} style={{ width: "100%", height }} />;
}
