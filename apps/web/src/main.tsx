import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type NavPage = 'home' | 'sessions' | 'feishu';
type TimeRangePreset = '3d' | '7d' | '15d' | '30d' | 'custom';
type WatchlistFilter = 'all' | 'dropped' | 'unchanged' | 'low';

interface PriceHistoryPoint {
  timestamp: string;
  pagePrice: number;
  couponPrice: number | null;
  subsidyPrice: number | null;
  finalPrice: number | null;
  inStock: boolean;
  note?: string;
}

interface MonitoredProduct {
  key: string;
  platform: 'jd' | 'taobao' | string;
  platformLabel?: string;
  id: string;
  skuId: string | null;
  canonicalUrl: string;
  title: string;
  imageUrl: string;
  shopName: string;
  brandName: string;
  spec: string;
  inStock: boolean;
  stockText: string;
  pagePrice: number;
  couponPrice: number | null;
  subsidyPrice: number | null;
  finalPrice: number | null;
  coupons: string[];
  couponDiscount: number;
  hasSubsidy: boolean;
  subsidyLabel: string | null;
  subsidyDiscount: number;
  allTimeLow: number | null;
  allTimeLowAt: string | null;
  allTimeHigh: number | null;
  initialPrice: number | null;
  previousFinalPrice: number | null;
  lastDropAmount: number;
  priceHistory: PriceHistoryPoint[];
  createdAt: string;
  updatedAt: string;
}

interface PlatformSessionInfo {
  state: string;
  nickname?: string;
  pin?: string;
  mobile?: string;
  source?: string;
  updatedAt?: string;
  lastKeepAliveAt?: string;
  keepAliveCount?: number;
  cookieCount?: number;
  mobileLoginReady?: boolean;
  storagePath?: string;
  message: string;
}

interface JdQrCodeState {
  state: string;
  qrImage?: string;
  token?: string;
  code?: number;
  url?: string;
  title?: string;
  screenshot?: string;
  viewport?: { width: number; height: number };
  message: string;
}

interface RemoteBrowserFrame {
  state: string;
  frameId?: number;
  url?: string;
  title?: string;
  screenshot?: string;
  viewport?: { width: number; height: number };
  message?: string;
}

interface FeishuConfigState {
  webhookUrl: string;
  secret: string;
  enabled: boolean;
  notifyOnPriceDrop: boolean;
  notifyOnDelist: boolean;
  notifyOnSessionExpire: boolean;
  lastPushAt?: string;
  lastPushStatus?: 'success' | 'error';
  lastPushMessage?: string;
}

function formatPrice(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isAtHistoricLow(product: MonitoredProduct): boolean {
  return product.allTimeLow !== null && product.finalPrice !== null && product.finalPrice <= product.allTimeLow;
}

function ApplePriceDetail({ product }: { product: MonitoredProduct }) {
  const rawPoints = product.priceHistory || [];
  const hasPrice = rawPoints.length > 0;
  const totalSaved = product.finalPrice === null ? 0 : Math.max(0, product.pagePrice - product.finalPrice);
  const isAtLow = isAtHistoricLow(product);

  // 走势图与历史价格记录统一的时间区间筛选状态
  const [preset, setPreset] = useState<TimeRangePreset>('15d');
  const [startDate, setStartDate] = useState<string>(() =>
    toDateInputValue(new Date(Date.now() - 15 * 24 * 3600 * 1000)),
  );
  const [endDate, setEndDate] = useState<string>(() => toDateInputValue(new Date()));

  // 历史记录默认只显示 3 条，可按需展开
  const [showAllHistory, setShowAllHistory] = useState(false);

  // 股市级走势图交互状态：滚轮缩放区间 [zoomStartIdx, zoomEndIdx]、悬停十字准星索引、拖拽平移
  const [zoomRange, setZoomRange] = useState<[number, number] | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [dragStart, setDragStart] = useState<{ clientX: number; range: [number, number] } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const chartBoxRef = useRef<HTMLDivElement | null>(null);

  // 切换预设天数 (3天 / 7天 / 15天 / 30天) 时同步更新起止日期输入框
  function applyPreset(nextPreset: Exclude<TimeRangePreset, 'custom'>) {
    setPreset(nextPreset);
    const daysMap: Record<Exclude<TimeRangePreset, 'custom'>, number> = {
      '3d': 3,
      '7d': 7,
      '15d': 15,
      '30d': 30,
    };
    const days = daysMap[nextPreset];
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 3600 * 1000);
    setStartDate(toDateInputValue(from));
    setEndDate(toDateInputValue(now));
    setZoomRange(null);
    setHoverIdx(null);
  }

  // 根据选定的时间区间过滤价格采样点（同时作用于上方走势图与下方历史价格表）
  const filteredPoints = useMemo(() => {
    if (rawPoints.length === 0) return [];
    const startMs = startDate ? new Date(`${startDate}T00:00:00`).getTime() : 0;
    const endMs = endDate ? new Date(`${endDate}T23:59:59.999`).getTime() : Number.MAX_SAFE_INTEGER;

    return rawPoints.filter(pt => {
      const t = new Date(pt.timestamp).getTime();
      return t >= startMs && t <= endMs;
    });
  }, [rawPoints, startDate, endDate]);

  // 当商品或时间筛选变化时重置滚轮缩放
  useEffect(() => {
    setZoomRange(null);
    setHoverIdx(null);
    setShowAllHistory(false);
  }, [product.key, startDate, endDate]);

  // 当前滚轮缩放后的可见走势采样点
  const activeRange: [number, number] = useMemo(() => {
    const total = filteredPoints.length;
    if (total <= 1) return [0, 0];
    if (!zoomRange) return [0, total - 1];
    const s = Math.max(0, Math.min(total - 2, zoomRange[0]));
    const e = Math.max(s + 1, Math.min(total - 1, zoomRange[1]));
    return [s, e];
  }, [filteredPoints.length, zoomRange]);

  const visiblePoints = useMemo(
    () => filteredPoints.slice(activeRange[0], activeRange[1] + 1),
    [filteredPoints, activeRange],
  );

  const isZoomed =
    filteredPoints.length > 2 &&
    (activeRange[0] > 0 || activeRange[1] < filteredPoints.length - 1);
  const zoomFactor =
    filteredPoints.length > 1
      ? Number(((filteredPoints.length - 1) / Math.max(1, activeRange[1] - activeRange[0])).toFixed(1))
      : 1;

  // 绑定原生非被动滚轮事件：鼠标放在走势图上直接滚轮放大缩小，不触发页面滚动
  useEffect(() => {
    const el = chartBoxRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      if (filteredPoints.length <= 2) return;
      e.preventDefault();

      const svgEl = svgRef.current;
      let cursorRatio = 0.5;
      if (svgEl) {
        const rect = svgEl.getBoundingClientRect();
        cursorRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      }

      const total = filteredPoints.length;
      const curStart = activeRange[0];
      const curEnd = activeRange[1];
      const curSpan = curEnd - curStart;

      // deltaY < 0 为向上滚轮（放大），deltaY > 0 为向下滚轮（缩小）
      const zoomIn = e.deltaY < 0;
      const deltaSpan = Math.max(1, Math.round(curSpan * 0.22));
      const nextSpan = zoomIn
        ? Math.max(2, curSpan - deltaSpan)
        : Math.min(total - 1, curSpan + deltaSpan);

      if (nextSpan >= total - 1) {
        setZoomRange(null);
        return;
      }

      const anchorIdx = curStart + cursorRatio * curSpan;
      let nextStart = Math.round(anchorIdx - cursorRatio * nextSpan);
      let nextEnd = nextStart + nextSpan;

      if (nextStart < 0) {
        nextStart = 0;
        nextEnd = nextSpan;
      }
      if (nextEnd > total - 1) {
        nextEnd = total - 1;
        nextStart = Math.max(0, nextEnd - nextSpan);
      }

      setZoomRange([nextStart, nextEnd]);
      setHoverIdx(null);
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [filteredPoints.length, activeRange]);

  const width = 880;
  const height = 250;
  const padLeft = 62;
  const padRight = 24;
  const padTop = 28;
  const padBottom = 36;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const allValues = visiblePoints.flatMap(p => p.finalPrice === null ? [p.pagePrice] : [p.finalPrice, p.pagePrice]);
  const minVal = allValues.length ? Math.min(...allValues, product.allTimeLow ?? Infinity) : 0;
  const maxVal = Math.max(0, ...allValues);
  const span = Math.max(10, maxVal - minVal);
  const yMin = Math.max(0, Math.floor(minVal - span * 0.2));
  const yMax = Math.ceil(maxVal + span * 0.2);

  const getX = (idx: number) =>
    visiblePoints.length <= 1 ? padLeft + plotW / 2 : padLeft + (idx / (visiblePoints.length - 1)) * plotW;
  const getY = (val: number) => padTop + plotH - ((val - yMin) / Math.max(1, yMax - yMin)) * plotH;

  const finalCoords = visiblePoints.map((p, i) => p.finalPrice === null ? null : { x: getX(i), y: getY(p.finalPrice) });
  const pageCoords = visiblePoints.map((p, i) => ({ x: getX(i), y: getY(p.pagePrice), point: p }));

  const finalPath = finalCoords.map((c, i) => c ? `${finalCoords[i - 1] ? 'L' : 'M'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}` : '').join(' ');
  const pagePath = pageCoords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
  const areaPath = pageCoords.length > 0 && finalCoords.every(Boolean)
    ? `${finalPath} L ${pageCoords.at(-1)!.x.toFixed(1)} ${padTop + plotH} L ${pageCoords[0].x.toFixed(1)} ${padTop + plotH} Z`
    : '';
  const lowY = product.allTimeLow === null ? null : getY(product.allTimeLow);

  // 鼠标在图表上移动时计算最近的采样点索引 + 拖拽平移
  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const svgEl = svgRef.current;
    if (!svgEl || visiblePoints.length === 0) return;
    const rect = svgEl.getBoundingClientRect();

    if (dragStart && isZoomed) {
      const dxRatio = (e.clientX - dragStart.clientX) / Math.max(1, rect.width);
      const spanCount = dragStart.range[1] - dragStart.range[0];
      const shift = Math.round(-dxRatio * spanCount);
      const total = filteredPoints.length;
      let nextStart = Math.max(0, Math.min(total - 1 - spanCount, dragStart.range[0] + shift));
      let nextEnd = nextStart + spanCount;
      setZoomRange([nextStart, nextEnd]);
      return;
    }

    const relX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * width;
    const clampedX = Math.max(padLeft, Math.min(width - padRight, relX));
    if (visiblePoints.length === 1) {
      setHoverIdx(0);
      return;
    }
    const ratio = (clampedX - padLeft) / plotW;
    const idx = Math.max(0, Math.min(visiblePoints.length - 1, Math.round(ratio * (visiblePoints.length - 1))));
    setHoverIdx(idx);
  }

  function handleMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    if (!isZoomed) return;
    setDragStart({ clientX: e.clientX, range: activeRange });
  }

  function handleMouseUpOrLeave() {
    setDragStart(null);
    setHoverIdx(null);
  }

  const activeHoverCoord = hoverIdx === null ? pageCoords.at(-1) : pageCoords[hoverIdx];
  const activeFinalCoord = hoverIdx === null ? undefined : finalCoords[hoverIdx];
  const activeFinalPrice = hoverIdx === null ? product.finalPrice : activeHoverCoord?.point.finalPrice ?? null;
  const firstFinalPrice = visiblePoints.find(point => point.finalPrice !== null)?.finalPrice ?? null;
  const deltaFromStart = activeFinalPrice !== null && firstFinalPrice !== null
    ? Number((activeFinalPrice - firstFinalPrice).toFixed(2)) : null;
  const deltaPercent = deltaFromStart !== null && firstFinalPrice
    ? ((deltaFromStart / firstFinalPrice) * 100).toFixed(2) : '0.00';

  // 下方历史记录表数据（与走势图共享同一时间筛选，默认只保留最新 3 条）
  const reversedHistory = useMemo(() => [...filteredPoints].reverse(), [filteredPoints]);
  const displayedHistory = showAllHistory ? reversedHistory : reversedHistory.slice(0, 3);

  // 控制 X 轴底部显示的刻度密度，避免重叠
  const xTickStep = Math.max(1, Math.ceil(visiblePoints.length / 6));

  return (
    <div className="detail-stack">
      {/* Apple Store 风格四格参数摘要 */}
      <div className="apple-metrics-grid">
        <div className="apple-metric-tile featured">
          <div className="tile-top">
            <span>预估到手价</span>
            {isAtLow && <span className="apple-badge blue">当前史低</span>}
          </div>
          <div className="tile-price">{product.finalPrice === null ? '待采集' : `¥${formatPrice(product.finalPrice)}`}</div>
          {product.finalPrice !== null && <div className="tile-caption">较页面标价立省 ¥{formatPrice(totalSaved)}</div>}
        </div>

        <div className="apple-metric-tile">
          <div className="tile-top">
            <span>页面参考价</span>
          </div>
          <div className="tile-price-sm">{hasPrice ? `¥${formatPrice(product.pagePrice)}` : '待采集'}</div>
          <div className="tile-caption">
            {product.allTimeLow !== null ? `到手史低 ¥${formatPrice(product.allTimeLow)}` : '到手史低待采集'}
            {product.allTimeHigh !== null && ` · 标价最高 ¥${formatPrice(product.allTimeHigh)}`}
          </div>
        </div>

        <div className="apple-metric-tile">
          <div className="tile-top">
            <span>优惠券减免</span>
            {hasPrice && product.couponDiscount > 0 && <span className="apple-badge neutral">-¥{product.couponDiscount}</span>}
          </div>
          <div className="tile-price-sm">
            {product.couponPrice !== null ? `¥${formatPrice(product.couponPrice)}` : '待采集'}
          </div>
          {hasPrice && <div className="tile-caption">
            {product.coupons.length > 0 ? product.coupons.join(' · ') : '暂未检出可用店铺券'}
          </div>}
        </div>

        <div className="apple-metric-tile">
          <div className="tile-top">
            <span>国家补贴（国补）</span>
            {product.hasSubsidy && product.subsidyDiscount > 0 && <span className="apple-badge green">-¥{product.subsidyDiscount}</span>}
          </div>
          <div className="tile-price-sm">
            {product.hasSubsidy && product.subsidyPrice !== null
              ? `¥${formatPrice(product.subsidyPrice)}`
              : product.finalPrice !== null ? '暂未检出' : '待采集'}
          </div>
          {product.subsidyLabel && <div className="tile-caption">{product.subsidyLabel}</div>}
        </div>
      </div>

      {/* 统一时间区间筛选栏（同时联动控制价格走势图 + 下方历史价格记录表） */}
      <div className="unified-filter-bar">
        <div className="filter-left">
          <span className="filter-title">时间范围</span>
          <div className="apple-segmented">
            {(['3d', '7d', '15d', '30d'] as const).map(key => {
              const labelMap = { '3d': '3天', '7d': '7天', '15d': '15天', '30d': '30天' };
              return (
                <button
                  key={key}
                  type="button"
                  className={preset === key ? 'active' : ''}
                  onClick={() => applyPreset(key)}
                >
                  {labelMap[key]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="filter-right">
          <label className="date-range-picker">
            <span>自定义区间</span>
            <input
              type="date"
              value={startDate}
              onChange={e => {
                setPreset('custom');
                setStartDate(e.target.value);
              }}
            />
            <span className="range-to">至</span>
            <input
              type="date"
              value={endDate}
              onChange={e => {
                setPreset('custom');
                setEndDate(e.target.value);
              }}
            />
          </label>
        </div>
      </div>

      {/* Apple Stocks 股市级交互式价格走势图（支持鼠标移上去看盘 + 滚轮缩放 + 拖拽平移） */}
      <div className="apple-chart-block" ref={chartBoxRef}>
        {/* 股市实时盯盘 HUD 表头：鼠标悬停时动态显示指针所在时刻的各项价格与涨跌幅 */}
        <div className="stocks-hud-bar">
          <div className="hud-primary">
            <span className="hud-tag">{hoverIdx !== null ? '指针盯盘价' : '最新到手价'}</span>
            <strong className="sf-mono hud-price">
              {activeFinalPrice === null ? '待采集' : `¥${formatPrice(activeFinalPrice)}`}
            </strong>
            {deltaFromStart !== null && <span className={`sf-mono hud-delta ${deltaFromStart <= 0 ? 'down' : 'up'}`}>
              {deltaFromStart > 0 ? `+¥${formatPrice(deltaFromStart)}` : `¥${formatPrice(deltaFromStart)}`} (
              {deltaFromStart > 0 ? `+${deltaPercent}%` : `${deltaPercent}%`})
            </span>}
          </div>

          {activeHoverCoord && (
            <div className="hud-meta sf-mono">
              <span>
                时间：{new Date(activeHoverCoord.point.timestamp).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span>标价：¥{formatPrice(activeHoverCoord.point.pagePrice)}</span>
              {activeHoverCoord.point.couponPrice !== null && (
                <span>券后：¥{formatPrice(activeHoverCoord.point.couponPrice)}</span>
              )}
              {activeHoverCoord.point.subsidyPrice !== null && (
                <span>国补：¥{formatPrice(activeHoverCoord.point.subsidyPrice)}</span>
              )}
            </div>
          )}

          <div className="hud-controls">
            <span className="zoom-tip">
              {isZoomed ? `已缩放 ${zoomFactor}x（可按住左右拖拽）` : '鼠标移入看盘 · 滚轮放大缩小'}
            </span>
            {isZoomed && (
              <button type="button" className="reset-zoom-btn" onClick={() => setZoomRange(null)}>
                重置缩放
              </button>
            )}
          </div>
        </div>

        <div className="block-header">
          <div className="apple-legend">
            <span>
              <i className="legend-indicator blue" /> 到手价（含券与国补）
            </span>
            <span>
              <i className="legend-indicator gray" /> 页面参考价
            </span>
            {product.allTimeLow !== null && <span>
              <i className="legend-indicator green" /> 史低基准线 (¥{formatPrice(product.allTimeLow)})
            </span>}
          </div>
          <span className="block-sub">
            当前视图：{visiblePoints.length} / {filteredPoints.length} 个采样点
          </span>
        </div>

        <div className="stocks-svg-stage">
          {visiblePoints.length > 0 ? <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            className={`apple-chart-svg ${isZoomed ? 'grab-cursor' : 'crosshair-cursor'}`}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUpOrLeave}
            onMouseLeave={handleMouseUpOrLeave}
          >
            <defs>
              <linearGradient id="appleBlueFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="oklch(0.555 0.195 253)" stopOpacity="0.22" />
                <stop offset="100%" stopColor="oklch(0.555 0.195 253)" stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
              const y = padTop + ratio * plotH;
              const labelVal = Math.round(yMax - ratio * (yMax - yMin));
              return (
                <g key={idx}>
                  <line x1={padLeft} y1={y} x2={width - padRight} y2={y} className="apple-grid-line" />
                  <text x={padLeft - 10} y={y + 3.5} textAnchor="end" className="apple-axis-label">
                    ¥{labelVal}
                  </text>
                </g>
              );
            })}

            {lowY !== null && <line x1={padLeft} y1={lowY} x2={width - padRight} y2={lowY} className="apple-low-line" />}
            {areaPath && <path d={areaPath} fill="url(#appleBlueFill)" />}
            <path d={pagePath} fill="none" className="apple-page-line" />
            {finalPath && <path d={finalPath} fill="none" className="apple-final-line" />}

            {/* 采样点与 X 轴时间刻度 */}
            {pageCoords.map((c, idx) => {
              const final = finalCoords[idx];
              const isHovered = hoverIdx === idx;
              const showTick = idx % xTickStep === 0 || idx === pageCoords.length - 1;
              return (
                <g key={idx}>
                  <circle
                    cx={c.x}
                    cy={final?.y ?? c.y}
                    r={isHovered ? 5.5 : visiblePoints.length <= 16 ? 3.2 : 2.2}
                    className={final ? (isHovered ? 'apple-dot-active' : 'apple-dot') : 'apple-page-dot-active'}
                  />
                  {showTick && (
                    <text x={c.x} y={height - 10} textAnchor="middle" className="apple-axis-label">
                      {new Date(c.point.timestamp).toLocaleDateString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                      })}
                    </text>
                  )}
                </g>
              );
            })}

            {/* 鼠标悬停时的股市十字准星线与价格浮标 */}
            {hoverIdx !== null && activeHoverCoord && (
              <g className="crosshair-group">
                <line
                  x1={activeHoverCoord.x}
                  y1={padTop}
                  x2={activeHoverCoord.x}
                  y2={padTop + plotH}
                  className="crosshair-line"
                />
                <line
                  x1={padLeft}
                  y1={activeFinalCoord?.y ?? activeHoverCoord.y}
                  x2={width - padRight}
                  y2={activeFinalCoord?.y ?? activeHoverCoord.y}
                  className="crosshair-line-h"
                />
                <circle cx={activeHoverCoord.x} cy={activeHoverCoord.y} r="4" className="apple-page-dot-active" />
                {activeFinalCoord && <>
                  <circle cx={activeFinalCoord.x} cy={activeFinalCoord.y} r="9" className="apple-dot-halo" />
                  <circle cx={activeFinalCoord.x} cy={activeFinalCoord.y} r="4.5" className="apple-dot-active" />
                </>}
              </g>
            )}
          </svg> : (
            <div className="apple-empty large">所选时间范围内暂无真实采集记录</div>
          )}

          {/* 悬停浮动详情气泡 */}
          {hoverIdx !== null && activeHoverCoord && (
            <div
              className="stocks-floating-tooltip"
              style={{
                left: `${Math.min(78, Math.max(10, ((activeHoverCoord.x - padLeft) / plotW) * 100))}%`,
              }}
            >
              <div className="tooltip-time sf-mono">
                {new Date(activeHoverCoord.point.timestamp).toLocaleString('zh-CN', {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
              <div className="tooltip-row">
                <span>最优到手价</span>
                <strong className="sf-mono blue-text">{activeFinalPrice === null ? '待采集' : `¥${formatPrice(activeFinalPrice)}`}</strong>
              </div>
              <div className="tooltip-row">
                <span>页面标价</span>
                <span className="sf-mono">¥{formatPrice(activeHoverCoord.point.pagePrice)}</span>
              </div>
              {activeHoverCoord.point.couponPrice !== null && (
                <div className="tooltip-row">
                  <span>券后价</span>
                  <span className="sf-mono">¥{formatPrice(activeHoverCoord.point.couponPrice)}</span>
                </div>
              )}
              {activeHoverCoord.point.subsidyPrice !== null && (
                <div className="tooltip-row">
                  <span>国补到手</span>
                  <span className="sf-mono green-text">¥{formatPrice(activeHoverCoord.point.subsidyPrice)}</span>
                </div>
              )}
              <div className="tooltip-note">{activeHoverCoord.point.note || '定时价格巡检'}</div>
            </div>
          )}
        </div>
      </div>

      {/* 历史价格采集记录表（与上方走势图共用时间筛选，默认只保留最新 3 条） */}
      <div className="apple-table-block">
        <div className="block-header">
          <div>
            <span className="block-title">历史价格记录</span>
            <span className="block-sub-inline">
              （与上方时间区间同步：当前区间共 {reversedHistory.length} 条，默认仅显示最新 3 条）
            </span>
          </div>
          {reversedHistory.length > 3 && (
            <button
              type="button"
              className="table-toggle-btn"
              onClick={() => setShowAllHistory(prev => !prev)}
            >
              {showAllHistory ? '收起（仅显示 3 条）' : `展开全部 ${reversedHistory.length} 条`}
            </button>
          )}
        </div>
        <div className="apple-table-wrap">
          <table className="apple-table">
            <thead>
              <tr>
                <th>采集时间</th>
                <th className="num">页面标价</th>
                <th className="num">券后价</th>
                <th className="num">国补后价格</th>
                <th className="num">最优到手价</th>
                <th>库存状态</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {displayedHistory.length === 0 && <tr><td colSpan={7}>所选时间范围内暂无真实采集记录</td></tr>}
              {displayedHistory.map((pt, idx) => (
                <tr key={idx}>
                  <td className="sf-mono">{new Date(pt.timestamp).toLocaleString('zh-CN')}</td>
                  <td className="num sf-mono">¥{formatPrice(pt.pagePrice)}</td>
                  <td className="num sf-mono">{pt.couponPrice !== null ? `¥${formatPrice(pt.couponPrice)}` : '—'}</td>
                  <td className="num sf-mono">{pt.subsidyPrice !== null ? `¥${formatPrice(pt.subsidyPrice)}` : '—'}</td>
                  <td className="num sf-mono price-highlight">{pt.finalPrice === null ? '—' : `¥${formatPrice(pt.finalPrice)}`}</td>
                  <td>
                    <span className={pt.inStock ? 'status-text green' : 'status-text red'}>
                      {pt.inStock ? '现货' : '无货'}
                    </span>
                  </td>
                  <td className="secondary-text">{pt.note || '定时巡检'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

type RemotePoint = { x: number; y: number };
type RemotePointerEnd = ({ type: 'up' } & RemotePoint) | { type: 'cancel' };
type RemotePointerEvent = RemotePointerEnd | ({ type: 'down' } & RemotePoint) | { type: 'move'; points: RemotePoint[] };

const verificationBase = '/api/products/verification';

function browserInteractionId() {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('');
}

function verificationHeaders(token: string) {
  return { 'X-PricePulse-Verification-Token': token };
}

interface RemotePointerInteraction {
  id: string;
  browserPointerId: number;
  start: RemotePoint;
  started: boolean;
  sending: boolean;
  moves: RemotePoint[];
  end?: RemotePointerEnd;
}

function RemoteBrowserViewport({
  platform,
  initialFrame,
  onLoggedIn,
  onMessage,
  verificationToken,
  jdMobile = false,
}: {
  platform: 'jd' | 'taobao';
  initialFrame: RemoteBrowserFrame | null;
  onLoggedIn: (session: PlatformSessionInfo) => void;
  onMessage: (msg: string) => void;
  verificationToken?: string;
  jdMobile?: boolean;
}) {
  const [frame, setFrame] = useState<RemoteBrowserFrame | null>(initialFrame);
  const [loading, setLoading] = useState(false);
  const [frameError, setFrameError] = useState(initialFrame?.screenshot ? undefined : initialFrame?.message);
  const [textInput, setTextInput] = useState('');
  const pointerRef = useRef<RemotePointerInteraction | null>(null);
  const lastPointerEndRef = useRef(0);
  const actionBusyRef = useRef(false);
  const frameBusyRef = useRef(false);
  const frameIdRef = useRef<number | undefined>(undefined);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const base = verificationToken ? verificationBase : `/api/sessions/${platform}/remote`;

  const vw = frame?.viewport?.width || 1280;
  const vh = frame?.viewport?.height || 800;

  useEffect(() => {
    if (initialFrame?.screenshot) {
      setFrame(initialFrame);
      setFrameError(undefined);
    }
  }, [initialFrame]);

  async function readFrame(response: Response): Promise<RemoteBrowserFrame & PlatformSessionInfo> {
    if (response.status >= 500) throw new Error('服务端暂时无法启动实时画面，请稍后重试');
    const data = (await response.json()) as RemoteBrowserFrame & PlatformSessionInfo;
    if (!response.ok) throw new Error(data.message || '无法获取实时画面');
    return data;
  }

  async function initRemote(resetToLogin = false) {
    if (pointerRef.current || actionBusyRef.current) return;
    setLoading(true);
    actionBusyRef.current = true;
    try {
      const res = await fetch(verificationToken ? `${base}/frame` : `${base}/start`, verificationToken ? {
        headers: verificationHeaders(verificationToken),
        signal: AbortSignal.timeout(12000),
      } : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepCurrent: !resetToLogin, ...(platform === 'jd' ? { jdMobile } : {}) }),
      });
      const data = await readFrame(res);
      if (data.state === 'ready') {
        setFrame(null);
        setFrameError('已返回商品页，请点击「确定」继续采集');
        return;
      }
      if (data.state === 'logged_in') {
        onLoggedIn(data);
        return;
      }
      setFrame(data);
      frameIdRef.current = data.frameId;
      setFrameError(data.screenshot ? undefined : data.message);
      if (data.message) onMessage(data.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法连接云端实时浏览器画面';
      setFrameError(message);
      onMessage(message);
    } finally {
      setLoading(false);
      actionBusyRef.current = false;
    }
  }

  useEffect(() => {
    if (!frame?.screenshot) {
      void initRemote(false);
    }
    let lastPoll = 0;
    const controller = new AbortController();
    const timer = window.setInterval(async () => {
      const now = Date.now();
      const interacting = pointerRef.current || now - lastPointerEndRef.current < 500;
      const interval = verificationToken ? (interacting ? 40 : 850) : (interacting ? 140 : 1350);
      if (actionBusyRef.current || frameBusyRef.current || now - lastPoll < interval) return;
      lastPoll = now;
      frameBusyRef.current = true;
      try {
        const after = frameIdRef.current === undefined ? '' : `?after=${frameIdRef.current}`;
        const res = await fetch(`${base}/frame${after}`, {
          headers: verificationToken ? verificationHeaders(verificationToken) : undefined,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        });
        const data = await readFrame(res);
        if (data.state === 'unchanged') return;
        if (data.state === 'ready' && !controller.signal.aborted) {
          setFrame(null);
          setFrameError('已返回商品页，请点击「确定」继续采集');
          return;
        }
        if (data.state === 'logged_in') {
          onLoggedIn(data);
          return;
        }
        if (!actionBusyRef.current && !controller.signal.aborted) {
          setFrameError(data.screenshot ? undefined : data.message);
          if (data.screenshot) {
            frameIdRef.current = data.frameId;
            setFrame(data);
          }
        }
      } catch (error) {
        // Retain the last frame while the connection recovers.
        if (!actionBusyRef.current && !controller.signal.aborted) {
          setFrameError(error instanceof Error ? error.message : '暂时无法获取实时画面');
        }
      } finally {
        frameBusyRef.current = false;
      }
    }, verificationToken ? 50 : 140);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      const pointer = pointerRef.current;
      if (pointer && !pointer.end) {
        pointer.end = { type: 'cancel' };
        void flushPointer(pointer);
      }
    };
  }, [platform, verificationToken]);

  async function sendRemoteAction(payload: Record<string, unknown>) {
    if (pointerRef.current || actionBusyRef.current) return;
    actionBusyRef.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${platform}/remote/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readFrame(res);
      if (data.state === 'logged_in') {
        onLoggedIn(data);
        return;
      }
      setFrameError(data.screenshot ? undefined : data.message);
      if (data.screenshot) setFrame(data);
    } catch (error) {
      setFrameError(error instanceof Error ? error.message : '实时操作失败，请重试');
    } finally {
      setLoading(false);
      actionBusyRef.current = false;
    }
  }

  function clientToVirtual(clientX: number, clientY: number): { x: number; y: number } {
    const el = imgRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const rx = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const ry = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    return {
      x: Math.round(rx * vw),
      y: Math.round(ry * vh),
    };
  }

  async function sendPointer(id: string, event: RemotePointerEvent) {
    const response = await fetch(`${base}/pointer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(verificationToken ? verificationHeaders(verificationToken) : {}),
      },
      body: JSON.stringify({ id, ...event }),
      keepalive: event.type === 'cancel' || event.type === 'up',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(data.message || '鼠标连线失败，请重新按下');
    }
  }

  async function flushPointer(pointer: RemotePointerInteraction) {
    if (pointer.sending) return;
    pointer.sending = true;
    try {
      if (!pointer.started) {
        await sendPointer(pointer.id, { type: 'down', ...pointer.start });
        pointer.started = true;
      }
      while (pointer.end?.type !== 'cancel' && pointer.moves.length > 0) {
        await sendPointer(pointer.id, { type: 'move', points: pointer.moves.splice(0, 24) });
      }
      if (pointer.end) {
        await sendPointer(pointer.id, pointer.end);
        lastPointerEndRef.current = Date.now();
        if (pointerRef.current === pointer) pointerRef.current = null;
      }
    } catch (error) {
      if (pointerRef.current === pointer) pointerRef.current = null;
      void sendPointer(pointer.id, { type: 'cancel' }).catch(() => {});
      onMessage(error instanceof Error ? error.message : '鼠标操作中断，请重试');
    } finally {
      pointer.sending = false;
    }
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!frame?.screenshot || actionBusyRef.current || pointerRef.current || !e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const id = browserInteractionId();
    const pointer: RemotePointerInteraction = {
      id,
      browserPointerId: e.pointerId,
      start: clientToVirtual(e.clientX, e.clientY),
      started: false,
      sending: false,
      moves: [],
    };
    pointerRef.current = pointer;
    void flushPointer(pointer);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const pointer = pointerRef.current;
    if (!pointer || pointer.browserPointerId !== e.pointerId || pointer.end) return;
    const samples = e.nativeEvent.getCoalescedEvents?.();
    for (const sample of samples?.length ? samples : [e]) {
      pointer.moves.push(clientToVirtual(sample.clientX, sample.clientY));
    }
    if (pointer.moves.length > 256) {
      pointer.end = { type: 'cancel' };
      onMessage('远程操作延迟过高，本次拖动已中止，请重试');
    }
    void flushPointer(pointer);
  }

  function finishPointer(e: React.PointerEvent<HTMLDivElement>, type: 'up' | 'cancel') {
    const pointer = pointerRef.current;
    if (!pointer || pointer.browserPointerId !== e.pointerId || pointer.end) return;
    pointer.end = type === 'up' ? { type, ...clientToVirtual(e.clientX, e.clientY) } : { type };
    void flushPointer(pointer);
  }

  function handleSendText(e: React.FormEvent) {
    e.preventDefault();
    if (!textInput) return;
    const val = textInput;
    setTextInput('');
    void sendRemoteAction({ type: 'type', text: val });
  }

  return (
    <div className="remote-browser-box">
      <div className="remote-browser-toolbar">
        <div className="remote-url-pill" title={frame?.url || ''}>
          <span className="remote-live-dot" />
          <span className="sf-mono">{frame?.url || (frameError && !loading ? '实时画面暂不可用' : '正在连接云端浏览器画面…')}</span>
        </div>
        {!verificationToken && <div className="remote-tool-btns">
          <button
            type="button"
            className="apple-btn-secondary sm"
            disabled={loading}
            onClick={() => void sendRemoteAction({ type: 'scroll', deltaY: -260 })}
          >
            上滚
          </button>
          <button
            type="button"
            className="apple-btn-secondary sm"
            disabled={loading}
            onClick={() => void sendRemoteAction({ type: 'scroll', deltaY: 260 })}
          >
            下滚
          </button>
          <button
            type="button"
            className="apple-btn-secondary sm"
            disabled={loading}
            onClick={() => void sendRemoteAction({ type: 'reload' })}
          >
            刷新网页
          </button>
          <button
            type="button"
            className="apple-btn-secondary sm"
            disabled={loading}
            onClick={() => void initRemote(true)}
          >
            重置回登录页
          </button>
        </div>}
      </div>

      {!verificationToken && <form className="remote-input-bar" onSubmit={handleSendText}>
        <input
          type="text"
          value={textInput}
          onChange={e => setTextInput(e.target.value)}
          placeholder="先在下方画面中点击输入框使其获得焦点，再在此输入手机号 / 短信验证码 / 文字并点击「填入」..."
        />
        <button type="submit" className="apple-btn-primary sm" disabled={loading || !textInput}>
          填入文字
        </button>
        <button
          type="button"
          className="apple-btn-secondary sm"
          disabled={loading}
          onClick={() => void sendRemoteAction({ type: 'key', key: 'Backspace' })}
        >
          退格
        </button>
        <button
          type="button"
          className="apple-btn-secondary sm"
          disabled={loading}
          onClick={() => void sendRemoteAction({ type: 'key', key: 'Enter' })}
        >
          回车
        </button>
      </form>}

      <div className="remote-tip-row">
        {verificationToken ? <span>在画面中按淘宝提示完成验证，再点击「确定」。</span> : <span>
          操作说明：直接在下方画面中<strong>点击按钮/点选验证码</strong>，或<strong>按住鼠标左键拖动滑块</strong>即可过人机验证；验证/登录完成后系统将自动识别并保存完整 Cookie。
        </span>}
        {loading && <span className="remote-sync-tag">正在同步云端操作…</span>}
      </div>

      <div
        className="remote-stage-wrap"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={e => finishPointer(e, 'up')}
        onPointerCancel={e => finishPointer(e, 'cancel')}
        onLostPointerCapture={e => finishPointer(e, 'cancel')}
      >
        {frame?.screenshot ? (
          <img
            ref={imgRef}
            src={frame.screenshot}
            alt="云端实时浏览器验证画面"
            className="remote-stage-img"
            draggable={false}
          />
        ) : (
          <div className="remote-stage-empty">
            {loading ? '正在加载服务端 Chromium 实时画面…' : frameError || '正在获取实时画面…'}
          </div>
        )}
      </div>
    </div>
  );
}

function TaobaoVerificationDialog({ token, onDismiss, onCollected }: {
  token: string;
  onDismiss: (message?: string) => void;
  onCollected: (product: MonitoredProduct & { message?: string }) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  function cancel() {
    if (busy) return;
    void fetch(`${verificationBase}/cancel`, {
      method: 'POST', headers: verificationHeaders(token), keepalive: true,
    }).catch(() => {});
    onDismiss('已取消商品验证');
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`${verificationBase}/confirm`, {
        method: 'POST', headers: verificationHeaders(token), signal: AbortSignal.timeout(55000),
      });
      const data = (await response.json()) as MonitoredProduct & {
        message?: string; code?: string; verificationAvailable?: boolean;
      };
      if (response.ok) {
        onCollected(data);
      } else if ([403, 410].includes(response.status) || (data.code && !data.verificationAvailable)) {
        onDismiss(data.message || '商品验证已结束');
      } else {
        setMessage(data.message || '暂时无法继续采集');
      }
    } catch {
      setMessage('暂时无法连接服务器，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="product-verification-dialog"
      aria-labelledby="taobao-verification-title"
      onCancel={event => { event.preventDefault(); cancel(); }}
    >
      <h2 id="taobao-verification-title">淘宝商品验证</h2>
      <RemoteBrowserViewport
        platform="taobao"
        verificationToken={token}
        initialFrame={null}
        onLoggedIn={() => {}}
        onMessage={setMessage}
      />
      <p role="status" className="product-verification-status">{message}</p>
      <div className="product-verification-actions">
        <button type="button" className="apple-btn-secondary" onClick={cancel} disabled={busy}>取消</button>
        <button type="button" className="apple-btn-primary" onClick={() => void confirm()} disabled={busy}>
          {busy ? '正在采集…' : '确定'}
        </button>
      </div>
    </dialog>
  );
}

function App() {
  const [activePage, setActivePage] = useState<NavPage>('home');
  const [status, setStatus] = useState('连接中');
  const [url, setUrl] = useState('');
  const [result, setResult] = useState('');
  const [productVerification, setProductVerification] = useState<{ token: string; clearInput: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const [products, setProducts] = useState<MonitoredProduct[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [productActionBusy, setProductActionBusy] = useState<string>('');
  const [watchSearch, setWatchSearch] = useState<string>('');
  const [watchFilter, setWatchFilter] = useState<WatchlistFilter>('all');

  // 第一排：京东登录态
  const [jdMessage, setJdMessage] = useState('京东登录态持久保存在服务端，刷新网页或重启服务不会丢失。');
  const [jdBusy, setJdBusy] = useState(false);
  const [jdSession, setJdSession] = useState<PlatformSessionInfo | null>(null);
  const [jdQr, setJdQr] = useState<JdQrCodeState | null>(null);
  const [jdRemoteFrame, setJdRemoteFrame] = useState<RemoteBrowserFrame | null>(null);
  const [authTab, setAuthTab] = useState<'qrcode' | 'sms' | 'remote' | 'mobile'>('qrcode');
  const [showJdAuthPanel, setShowJdAuthPanel] = useState(false);
  const [mobileInput, setMobileInput] = useState('');
  const [smsCodeInput, setSmsCodeInput] = useState('');
  const [smsCountdown, setSmsCountdown] = useState(0);

  // 第二排：淘宝登录态（与京东完全一致的网页内扫码 + 手机号短信验证码 + 云端实时人机验证）
  const [tbMessage, setTbMessage] = useState('淘宝登录态持久保存在服务端，刷新网页或重启服务不会丢失。');
  const [tbBusy, setTbBusy] = useState(false);
  const [tbSession, setTbSession] = useState<PlatformSessionInfo | null>(null);
  const [tbQr, setTbQr] = useState<JdQrCodeState | null>(null);
  const [tbRemoteFrame, setTbRemoteFrame] = useState<RemoteBrowserFrame | null>(null);
  const [tbAuthTab, setTbAuthTab] = useState<'qrcode' | 'sms' | 'remote'>('qrcode');
  const [showTbAuthPanel, setShowTbAuthPanel] = useState(false);
  const [tbMobileInput, setTbMobileInput] = useState('');
  const [tbSmsCodeInput, setTbSmsCodeInput] = useState('');
  const [tbSmsCountdown, setTbSmsCountdown] = useState(0);

  // 飞书推送配置
  const [feishuConfig, setFeishuConfig] = useState<FeishuConfigState>({
    webhookUrl: '',
    secret: '',
    enabled: true,
    notifyOnPriceDrop: true,
    notifyOnDelist: true,
    notifyOnSessionExpire: true,
  });
  const [feishuMessage, setFeishuMessage] = useState('');
  const [feishuBusy, setFeishuBusy] = useState(false);

  function isProductDropped(item: MonitoredProduct): boolean {
    if (item.finalPrice === null || item.initialPrice === null) return false;
    return (
      item.lastDropAmount > 0 ||
      item.finalPrice < item.initialPrice ||
      item.finalPrice < item.pagePrice
    );
  }

  const filteredWatchlist = useMemo(() => {
    const q = watchSearch.trim().toLowerCase();
    return products.filter(item => {
      if (q) {
        const haystack = [
          item.title,
          item.shopName,
          item.brandName,
          item.spec,
          item.id,
          item.platformLabel || item.platform,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      const dropped = isProductDropped(item);
      if (watchFilter === 'dropped') return dropped;
      if (watchFilter === 'unchanged') return item.finalPrice !== null && !dropped;
      if (watchFilter === 'low') return isAtHistoricLow(item);
      return true;
    });
  }, [products, watchSearch, watchFilter]);

  const watchCounts = useMemo(() => {
    const dropped = products.filter(p => isProductDropped(p)).length;
    const unchanged = products.filter(p => p.finalPrice !== null && !isProductDropped(p)).length;
    const low = products.filter(isAtHistoricLow).length;
    return { all: products.length, dropped, unchanged, low };
  }, [products]);

  const selectedProduct = useMemo(
    () =>
      products.find(p => p.key === selectedKey) ||
      filteredWatchlist[0] ||
      products[0] ||
      null,
    [products, filteredWatchlist, selectedKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    const load = (path: string, timeout = 10000) => fetch(path, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
    });
    load('/api/health')
      .then(response => {
        if (!response.ok) throw new Error('API unavailable');
        return response.json();
      })
      .then((data: { status: string }) => setStatus(data.status === 'ok' ? '服务在线' : '服务异常'))
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setStatus('未连接');
      });

    load('/api/products')
      .then(res => {
        if (!res.ok) throw new Error('无法读取商品列表');
        return res.json();
      })
      .then((data: { products?: MonitoredProduct[] } | null) => {
        if (data?.products) {
          setProducts(data.products);
          if (data.products[0]) setSelectedKey(data.products[0].key);
        }
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') {
          setResult(previous => previous || '商品列表暂时无法加载，请稍后刷新页面');
        }
      });

    load('/api/sessions/jd/status', 18000)
      .then(res => (res.ok ? res.json() : null))
      .then((data: PlatformSessionInfo | null) => {
        if (data) {
          setJdSession(data);
          if (data.state === 'logged_in' || data.mobileLoginReady) {
            setJdQr(null);
            setShowJdAuthPanel(false);
            setJdMessage(data.message);
          } else {
            setShowJdAuthPanel(true);
          }
        }
      })
      .catch(() => {});

    load('/api/sessions/taobao/status')
      .then(res => (res.ok ? res.json() : null))
      .then((data: PlatformSessionInfo | null) => {
        if (data) {
          setTbSession(data);
          if (data.state === 'logged_in') {
            setTbQr(null);
            setShowTbAuthPanel(false);
            setTbMessage(data.message);
          } else {
            setShowTbAuthPanel(true);
            if (data.message) setTbMessage(data.message);
          }
        }
      })
      .catch(() => {});

    load('/api/feishu/config')
      .then(res => (res.ok ? res.json() : null))
      .then((data: FeishuConfigState | null) => {
        if (data) {
          setFeishuConfig({
            webhookUrl: data.webhookUrl || '',
            secret: data.secret || '',
            enabled: data.enabled ?? true,
            notifyOnPriceDrop: data.notifyOnPriceDrop ?? true,
            notifyOnDelist: data.notifyOnDelist ?? true,
            notifyOnSessionExpire: data.notifyOnSessionExpire ?? true,
            lastPushAt: data.lastPushAt,
            lastPushStatus: data.lastPushStatus,
            lastPushMessage: data.lastPushMessage,
          });
        }
      })
      .catch(() => {});

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!showJdAuthPanel || authTab !== 'qrcode' || !jdQr || !['qr_ready', 'qr_waiting', 'qr_scanned'].includes(jdQr.state)) {
      return;
    }
    const controller = new AbortController();
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const res = await fetch('/api/sessions/jd/qrcode/status', { signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json()) as JdQrCodeState & PlatformSessionInfo;
        if (controller.signal.aborted) return;
        if (data.state === 'logged_in') {
          setJdQr(null);
          setShowJdAuthPanel(false);
          setJdSession(data);
          setJdMessage(data.message);
          return;
        }
        if (data.state === 'verify_required') {
          setJdQr(null);
          setJdRemoteFrame(data);
          setAuthTab('remote');
          setShowJdAuthPanel(true);
          setJdMessage(data.message);
          return;
        }
        setJdQr(prev =>
          prev
            ? {
                ...data,
                qrImage: prev.qrImage,
                token: prev.token,
              }
            : null,
        );
        setJdMessage(`扫码状态 [${data.code ?? '-'}]：${data.message}`);
      } catch {
        // Retry on the next poll.
      } finally {
        polling = false;
      }
    }, 2200);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [jdQr?.state, showJdAuthPanel, authTab]);

  useEffect(() => {
    if (smsCountdown <= 0) return;
    const t = window.setInterval(() => {
      setSmsCountdown(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [smsCountdown]);

  // 淘宝二维码扫码状态实时轮询（登录成功后二维码实时自动关闭并切换为已登录状态）
  useEffect(() => {
    if (!showTbAuthPanel || tbAuthTab !== 'qrcode' || !tbQr || !['qr_ready', 'qr_waiting', 'qr_scanned'].includes(tbQr.state)) {
      return;
    }
    const controller = new AbortController();
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const res = await fetch('/api/sessions/taobao/qrcode/status', { signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json()) as JdQrCodeState & PlatformSessionInfo;
        if (controller.signal.aborted) return;
        if (data.state === 'logged_in') {
          setTbQr(null);
          setShowTbAuthPanel(false);
          setTbSession(data);
          setTbMessage(data.message);
          return;
        }
        if (data.state === 'verify_required') {
          setTbQr(null);
          setTbRemoteFrame(data);
          setTbAuthTab('remote');
          setTbMessage(data.message);
          return;
        }
        setTbQr(prev =>
          prev
            ? {
                ...data,
                qrImage: prev.qrImage,
                token: prev.token,
              }
            : null,
        );
        setTbMessage(`淘宝扫码状态 [${data.code ?? '-'}]：${data.message}`);
      } catch {
        // Retry on the next poll.
      } finally {
        polling = false;
      }
    }, 2200);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [tbQr?.state, showTbAuthPanel, tbAuthTab]);

  useEffect(() => {
    if (tbSmsCountdown <= 0) return;
    const t = window.setInterval(() => {
      setTbSmsCountdown(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [tbSmsCountdown]);

  function applyCollectedProduct(product: MonitoredProduct) {
    setProducts(prev => {
      const idx = prev.findIndex(item => item.key === product.key);
      if (idx < 0) return [product, ...prev];
      const copy = [...prev];
      copy[idx] = product;
      return copy;
    });
    setSelectedKey(product.key);
  }

  async function parse(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResult('');
    try {
      const token = browserInteractionId();
      const response = await fetch('/api/products/parse?url=' + encodeURIComponent(url), {
        headers: verificationHeaders(token),
        signal: AbortSignal.timeout(60000),
      });
      const data = (await response.json()) as MonitoredProduct & { message?: string; verificationAvailable?: boolean };
      if (!response.ok && data.verificationAvailable) {
        setProductVerification({ token, clearInput: true });
        return;
      }
      if (!response.ok) throw new Error(data.message || '商品链接识别或抓取失败');
      setResult(`${data.platformLabel || data.platform} · ${data.title.slice(0, 34)} — ${data.message}`);
      applyCollectedProduct(data);
      setUrl('');
    } catch (error) {
      setResult(error instanceof Error && error.name === 'TimeoutError'
        ? '服务器未在 60 秒内完成采集，请稍后重试'
        : error instanceof TypeError ? '暂时无法连接 PricePulse 服务器，请稍后重试'
          : error instanceof Error ? error.message : '服务未连接');
    } finally {
      setBusy(false);
    }
  }

  async function refreshProduct(item: MonitoredProduct) {
    setProductActionBusy(item.key);
    try {
      const token = browserInteractionId();
      const res = await fetch(`/api/products/${encodeURIComponent(item.key)}/refresh`, {
        method: 'POST', headers: verificationHeaders(token), signal: AbortSignal.timeout(60000),
      });
      const data = (await res.json()) as { product?: MonitoredProduct; message?: string; verificationAvailable?: boolean };
      if (!res.ok && data.verificationAvailable) {
        setProductVerification({ token, clearInput: false });
        return;
      }
      if (!res.ok) throw new Error(data.message || '刷新失败');
      if (data.product) applyCollectedProduct(data.product);
      if (data.message) setResult(data.message);
    } catch (err) {
      setResult(err instanceof Error && err.name === 'TimeoutError'
        ? '服务器未在 60 秒内完成刷新，请稍后重试'
        : err instanceof TypeError ? '暂时无法连接 PricePulse 服务器，请稍后重试'
          : err instanceof Error ? err.message : '刷新商品价格失败');
    } finally {
      setProductActionBusy('');
    }
  }

  async function removeProduct(item: MonitoredProduct) {
    setProductActionBusy(item.key);
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      const data = (await res.json()) as { products?: MonitoredProduct[]; message?: string };
      if (data.products) {
        setProducts(data.products);
        if (selectedKey === item.key) {
          setSelectedKey(data.products[0]?.key || '');
        }
      }
    } finally {
      setProductActionBusy('');
    }
  }

  async function startJdQrLogin() {
    setJdBusy(true);
    setAuthTab('qrcode');
    setShowJdAuthPanel(true);
    try {
      const response = await fetch('/api/sessions/jd/qrcode/start', { method: 'POST' });
      const data = (await response.json()) as JdQrCodeState;
      if (!response.ok) throw new Error(data.message || '获取京东二维码失败');
      if (data.state === 'verify_required') {
        setJdQr(null);
        setJdRemoteFrame(data);
        setAuthTab('remote');
        setJdMessage(data.message);
        return;
      }
      if (data.state === 'logged_in') {
        setJdQr(null);
        setJdSession(data);
        setShowJdAuthPanel(false);
        setJdMessage(data.message);
        return;
      }
      setJdQr(data);
      setJdMessage(data.message);
    } catch (error) {
      setJdMessage(error instanceof Error ? error.message : '无法连接本地服务');
    } finally {
      setJdBusy(false);
    }
  }

  async function sendJdSmsCode() {
    if (!/^1[3-9]\d{9}$/.test(mobileInput.trim())) {
      setJdMessage('请输入有效的 11 位手机号码');
      return;
    }
    setJdBusy(true);
    try {
      const res = await fetch('/api/sessions/jd/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: mobileInput.trim() }),
      });
      const data = (await res.json()) as RemoteBrowserFrame & { message?: string; countdown?: number };
      if (!res.ok) throw new Error(data.message || '发送验证码失败');
      if (data.state === 'logged_in') {
        setJdSession(data as PlatformSessionInfo);
        setShowJdAuthPanel(false);
        setJdMessage(data.message || '登录成功');
        return;
      }
      if (data.state === 'verify_required') {
        setJdRemoteFrame(data);
        setAuthTab('remote');
        setJdMessage(data.message || '请在下方云端实时画面中完成人机验证');
        return;
      }
      setSmsCountdown(data.countdown || 60);
      setJdMessage(data.message || '短信验证码已发送');
    } catch (err) {
      setJdMessage(err instanceof Error ? err.message : '发送验证码失败');
    } finally {
      setJdBusy(false);
    }
  }

  async function submitJdSmsLogin(event: React.FormEvent) {
    event.preventDefault();
    setJdBusy(true);
    try {
      const res = await fetch('/api/sessions/jd/sms/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mobile: mobileInput.trim(),
          code: smsCodeInput.trim(),
        }),
      });
      const data = (await res.json()) as PlatformSessionInfo & RemoteBrowserFrame;
      if (!res.ok) throw new Error(data.message || '短信验证码登录失败');
      if (data.state === 'logged_in') {
        setJdSession(data);
        setJdQr(null);
        setShowJdAuthPanel(false);
        setSmsCodeInput('');
      } else if (data.state === 'verify_required') {
        setJdRemoteFrame(data);
        setAuthTab('remote');
      }
      setJdMessage(data.message);
    } catch (err) {
      setJdMessage(err instanceof Error ? err.message : '登录失败');
    } finally {
      setJdBusy(false);
    }
  }

  async function keepAliveJd() {
    setJdBusy(true);
    try {
      const res = await fetch('/api/sessions/jd/keepalive', { method: 'POST' });
      const data = (await res.json()) as PlatformSessionInfo;
      if (!res.ok) throw new Error(data.message || '保活失败');
      setJdSession(data);
      setJdMessage(data.message);
    } catch (err) {
      setJdMessage(err instanceof Error ? err.message : '保活请求失败');
    } finally {
      setJdBusy(false);
    }
  }

  async function checkJdSession() {
    setJdBusy(true);
    try {
      const response = await fetch('/api/sessions/jd/check', { method: 'POST' });
      const data = (await response.json()) as PlatformSessionInfo;
      if (!response.ok) throw new Error(data.message);
      setJdSession(data);
      if (data.state === 'logged_in') {
        setJdQr(null);
        setShowJdAuthPanel(false);
      }
      setJdMessage(data.message || '检查完成');
    } catch {
      setJdMessage('无法连接本地服务');
    } finally {
      setJdBusy(false);
    }
  }

  async function logoutJdSession() {
    setJdBusy(true);
    try {
      const response = await fetch('/api/sessions/jd/logout', { method: 'POST' });
      const data = (await response.json()) as PlatformSessionInfo;
      setJdSession(data);
      setJdQr(null);
      setShowJdAuthPanel(true);
      setJdMessage(data.message || '已退出京东账号');
    } catch {
      setJdMessage('无法连接本地服务');
    } finally {
      setJdBusy(false);
    }
  }

  async function startTaobaoQrLogin() {
    setTbBusy(true);
    setTbAuthTab('qrcode');
    setShowTbAuthPanel(true);
    try {
      const response = await fetch('/api/sessions/taobao/qrcode/start', { method: 'POST' });
      const data = (await response.json()) as JdQrCodeState;
      if (!response.ok) throw new Error(data.message || '获取淘宝二维码失败');
      if (data.state === 'verify_required') {
        setTbQr(null);
        setTbRemoteFrame(data);
        setTbAuthTab('remote');
        setTbMessage(data.message);
        return;
      }
      if (data.state === 'logged_in') {
        setTbQr(null);
        setTbSession(data);
        setShowTbAuthPanel(false);
        setTbMessage(data.message);
        return;
      }
      setTbQr(data);
      setTbMessage(data.message);
    } catch (error) {
      setTbMessage(error instanceof Error ? error.message : '无法连接本地服务');
    } finally {
      setTbBusy(false);
    }
  }

  async function sendTaobaoSmsCode() {
    if (!/^1[3-9]\d{9}$/.test(tbMobileInput.trim())) {
      setTbMessage('请输入有效的 11 位手机号码');
      return;
    }
    setTbBusy(true);
    try {
      const res = await fetch('/api/sessions/taobao/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: tbMobileInput.trim() }),
      });
      const data = (await res.json()) as RemoteBrowserFrame & { message?: string; countdown?: number };
      if (!res.ok) throw new Error(data.message || '发送验证码失败');
      if (data.state === 'logged_in') {
        setTbSession(data as PlatformSessionInfo);
        setShowTbAuthPanel(false);
        setTbMessage(data.message || '登录成功');
        return;
      }
      if (data.state === 'verify_required') {
        setTbRemoteFrame(data);
        setTbAuthTab('remote');
        setTbMessage(data.message || '请在下方云端实时画面中拖动滑块完成验证');
        return;
      }
      setTbSmsCountdown(data.countdown || 60);
      setTbMessage(data.message || '淘宝短信验证码已发送');
    } catch (err) {
      setTbMessage(err instanceof Error ? err.message : '发送验证码失败');
    } finally {
      setTbBusy(false);
    }
  }

  async function submitTaobaoSmsLogin(event: React.FormEvent) {
    event.preventDefault();
    setTbBusy(true);
    try {
      const res = await fetch('/api/sessions/taobao/sms/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mobile: tbMobileInput.trim(),
          code: tbSmsCodeInput.trim(),
        }),
      });
      const data = (await res.json()) as PlatformSessionInfo & RemoteBrowserFrame;
      if (!res.ok) throw new Error(data.message || '淘宝短信验证码登录失败');
      if (data.state === 'logged_in') {
        setTbSession(data);
        setTbQr(null);
        setShowTbAuthPanel(false);
        setTbSmsCodeInput('');
      } else if (data.state === 'verify_required') {
        setTbRemoteFrame(data);
        setTbAuthTab('remote');
      }
      setTbMessage(data.message);
    } catch (err) {
      setTbMessage(err instanceof Error ? err.message : '登录失败');
    } finally {
      setTbBusy(false);
    }
  }

  async function checkTaobaoSession() {
    setTbBusy(true);
    try {
      const response = await fetch('/api/sessions/taobao/check', { method: 'POST' });
      const data = (await response.json()) as PlatformSessionInfo;
      if (!response.ok) throw new Error(data.message);
      setTbSession(data);
      if (data.state === 'logged_in') {
        setTbQr(null);
        setShowTbAuthPanel(false);
      }
      setTbMessage(data.message || '检查完成');
    } catch {
      setTbMessage('无法连接本地服务');
    } finally {
      setTbBusy(false);
    }
  }

  async function keepAliveTaobao() {
    setTbBusy(true);
    try {
      const response = await fetch('/api/sessions/taobao/keepalive', { method: 'POST' });
      const data = (await response.json()) as PlatformSessionInfo;
      if (!response.ok) throw new Error(data.message || '保活失败');
      setTbSession(data);
      setTbMessage(data.message || '淘宝服务端保活完成');
    } catch (err) {
      setTbMessage(err instanceof Error ? err.message : '淘宝保活失败');
    } finally {
      setTbBusy(false);
    }
  }

  async function logoutTaobaoSession() {
    setTbBusy(true);
    try {
      const response = await fetch('/api/sessions/taobao/logout', { method: 'POST' });
      const data = (await response.json()) as PlatformSessionInfo;
      setTbSession(data);
      setTbQr(null);
      setShowTbAuthPanel(true);
      setTbMessage(data.message || '已退出淘宝账号');
    } catch {
      setTbMessage('无法连接本地服务');
    } finally {
      setTbBusy(false);
    }
  }

  async function saveFeishu(event: React.FormEvent) {
    event.preventDefault();
    setFeishuBusy(true);
    setFeishuMessage('');
    try {
      const res = await fetch('/api/feishu/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feishuConfig),
      });
      const data = (await res.json()) as FeishuConfigState & { message?: string };
      if (!res.ok) throw new Error(data.message || '保存飞书配置失败');
      setFeishuConfig(prev => ({ ...prev, ...data }));
      setFeishuMessage(data.message || '飞书 Webhook 配置已保存');
    } catch (err) {
      setFeishuMessage(err instanceof Error ? err.message : '保存失败');
    } finally {
      setFeishuBusy(false);
    }
  }

  async function testFeishuPush() {
    setFeishuBusy(true);
    setFeishuMessage('');
    try {
      const res = await fetch('/api/feishu/test', { method: 'POST' });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      if (!res.ok) throw new Error(data.message || '发送测试消息失败');
      setFeishuMessage(data.message || '飞书测试卡片发送成功，请查看飞书群消息');
    } catch (err) {
      setFeishuMessage(err instanceof Error ? err.message : '发送测试卡片失败');
    } finally {
      setFeishuBusy(false);
    }
  }

  return (
    <div className="macos-window">
      {productVerification && (
        <TaobaoVerificationDialog
          key={productVerification.token}
          token={productVerification.token}
          onDismiss={message => {
            setProductVerification(null);
            setResult(message || '');
          }}
          onCollected={product => {
            applyCollectedProduct(product);
            if (productVerification.clearInput) setUrl('');
            setProductVerification(null);
            setResult(product.message || '商品采集完成');
          }}
        />
      )}
      {/* 左侧 macOS 风格应用导航边栏 */}
      <aside className="macos-sidebar">
        <div className="sidebar-brand">
          <a
            href="/"
            onClick={e => {
              e.preventDefault();
              setActivePage('home');
            }}
            className="apple-title"
          >
            PricePulse
          </a>
          <span className="apple-subtitle">价格观察与国补雷达</span>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          <span className="sidebar-section-title">工作台</span>
          <button
            type="button"
            className={`sidebar-nav-btn ${activePage === 'home' ? 'active' : ''}`}
            onClick={() => setActivePage('home')}
          >
            <span className="nav-btn-label">主页 · 商品监控</span>
            <span className="nav-btn-count">{products.length}</span>
          </button>

          <span className="sidebar-section-title">系统与集成</span>
          <button
            type="button"
            className={`sidebar-nav-btn ${activePage === 'sessions' ? 'active' : ''}`}
            onClick={() => setActivePage('sessions')}
          >
            <span className="nav-btn-label">平台账号与服务端会话</span>
            <i
              className={`apple-dot ${
                jdSession?.state === 'logged_in' || tbSession?.state === 'logged_in' ? 'green' : 'gray'
              }`}
            />
          </button>

          <button
            type="button"
            className={`sidebar-nav-btn ${activePage === 'feishu' ? 'active' : ''}`}
            onClick={() => setActivePage('feishu')}
          >
            <span className="nav-btn-label">飞书 Webhook 推送设置</span>
            <i className={`apple-dot ${feishuConfig.webhookUrl && feishuConfig.enabled ? 'green' : 'gray'}`} />
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-status-row">
            <span>后端服务</span>
            <span className="status-inline">
              <i className={`apple-dot ${status === '服务在线' ? 'green' : 'gray'}`} />
              {status}
            </span>
          </div>
          <div className="sidebar-status-row">
            <span>京东登录态</span>
            <span className="status-inline">
              <i className={`apple-dot ${jdSession?.state === 'logged_in' ? 'green' : 'gray'}`} />
              {jdSession?.state === 'logged_in' ? jdSession.nickname || '已登录' : jdSession?.state === 'unverified' ? '待复核' : '未登录'}
            </span>
          </div>
          <div className="sidebar-status-row">
            <span>淘宝登录态</span>
            <span className="status-inline">
              <i className={`apple-dot ${tbSession?.state === 'logged_in' ? 'green' : 'gray'}`} />
              {tbSession?.state === 'logged_in' ? tbSession.nickname || '已登录' : '未登录'}
            </span>
          </div>
          <div className="sidebar-status-row">
            <span>飞书通知</span>
            <span className="status-inline">
              <i className={`apple-dot ${feishuConfig.webhookUrl && feishuConfig.enabled ? 'green' : 'gray'}`} />
              {feishuConfig.webhookUrl && feishuConfig.enabled ? '已开启' : '未配置'}
            </span>
          </div>
        </div>
      </aside>

      {/* 右侧主视图区域 */}
      <div className="macos-content">
        <header className="content-header">
          <div className="header-titles">
            <h1>
              {activePage === 'home' && '商品实时价格监控'}
              {activePage === 'sessions' && '平台账号与服务端会话'}
              {activePage === 'feishu' && '飞书 Webhook 推送设置'}
            </h1>
            <p>
              {activePage === 'home' && '粘贴京东或淘宝商品链接，自动抓取标价、优惠券、国家补贴与历史价格走势'}
              {activePage === 'sessions' && '集中管理京东与淘宝登录凭证，所有 Cookie 持久保存在服务端本地'}
              {activePage === 'feishu' && '配置飞书自定义机器人，实时接收商品降价、神券国补、下架与会话告警卡片'}
            </p>
          </div>
        </header>

        {/* 页面 1：主页（商品监控） */}
        {activePage === 'home' && (
          <main className="page-body">
            <section className="apple-search-bar">
              <form onSubmit={parse} className="apple-search-form">
                <input
                  id="product-url"
                  type="text"
                  required
                  value={url}
                  onChange={event => setUrl(event.target.value)}
                  placeholder="粘贴京东、淘宝或天猫商品链接（支持 3.cn 等分享短链），自动解析标价、优惠券与国家补贴..."
                />
                <button type="submit" disabled={busy} className="apple-btn-primary">
                  {busy ? '正在采集…' : '添加监控'}
                </button>
              </form>
              {result && (
                <div className="apple-notice" role="status">
                  {result}
                </div>
              )}
            </section>

            <section className="apple-main-split">
              <aside className="apple-surface sidebar-surface">
                <div className="surface-header">
                  <h2>关注列表</h2>
                  <span className="surface-count">
                    {filteredWatchlist.length} / {products.length} 件商品
                  </span>
                </div>

                {/* 关注列表搜索框与降价状态筛选栏 */}
                <div className="watchlist-toolbar">
                  <div className="watchlist-search-box">
                    <input
                      type="text"
                      value={watchSearch}
                      onChange={e => setWatchSearch(e.target.value)}
                      placeholder="搜索商品名称、店铺、规格或 SKU..."
                      aria-label="搜索关注商品"
                    />
                    {watchSearch && (
                      <button
                        type="button"
                        className="clear-search-btn"
                        onClick={() => setWatchSearch('')}
                      >
                        清空
                      </button>
                    )}
                  </div>

                  <div className="apple-segmented full-width">
                    <button
                      type="button"
                      className={watchFilter === 'all' ? 'active' : ''}
                      onClick={() => setWatchFilter('all')}
                    >
                      全部 ({watchCounts.all})
                    </button>
                    <button
                      type="button"
                      className={watchFilter === 'dropped' ? 'active' : ''}
                      onClick={() => setWatchFilter('dropped')}
                    >
                      已降价 ({watchCounts.dropped})
                    </button>
                    <button
                      type="button"
                      className={watchFilter === 'unchanged' ? 'active' : ''}
                      onClick={() => setWatchFilter('unchanged')}
                    >
                      未降价 ({watchCounts.unchanged})
                    </button>
                    <button
                      type="button"
                      className={watchFilter === 'low' ? 'active' : ''}
                      onClick={() => setWatchFilter('low')}
                    >
                      史低 ({watchCounts.low})
                    </button>
                  </div>
                </div>

                {products.length === 0 ? (
                  <div className="apple-empty">
                    <p>暂无监控商品</p>
                    <span>在上方粘贴京东或淘宝商品链接即可开始追踪价格走势</span>
                  </div>
                ) : filteredWatchlist.length === 0 ? (
                  <div className="apple-empty">
                    <p>未找到匹配商品</p>
                    <span>没有符合当前搜索词或筛选条件的关注商品</span>
                    <div style={{ marginTop: '12px' }}>
                      <button
                        type="button"
                        className="apple-btn-secondary sm"
                        onClick={() => {
                          setWatchSearch('');
                          setWatchFilter('all');
                        }}
                      >
                        重置搜索与筛选
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="apple-list">
                    {filteredWatchlist.map(item => {
                      const isSelected = selectedProduct?.key === item.key;
                      const isLoading = productActionBusy === item.key;
                      const dropped = isProductDropped(item);
                      const dropDiff = Math.max(
                        item.lastDropAmount,
                        item.finalPrice === null ? 0 : item.pagePrice - item.finalPrice,
                      );
                      return (
                        <div
                          key={item.key}
                          className={`apple-list-item ${isSelected ? 'active' : ''}`}
                          onClick={() => setSelectedKey(item.key)}
                        >
                          <div className="item-row-top">
                            {item.imageUrl ? (
                              <img src={item.imageUrl} alt={item.title} className="item-thumb" />
                            ) : (
                              <div className="item-thumb placeholder">{item.platformLabel || '商品'}</div>
                            )}

                            <div className="item-info">
                              <div className="item-tags">
                                <span className="platform-text">
                                  {item.platformLabel || (item.platform === 'jd' ? '京东' : '淘宝')}
                                </span>
                                <span className="dot-sep">·</span>
                                <span className={item.inStock ? 'status-text green' : 'status-text red'}>
                                  {item.stockText}
                                </span>
                                {dropped ? (
                                  <span className="apple-badge green">
                                    已降 ¥{dropDiff.toFixed(0)}
                                  </span>
                                ) : (
                                  <span className="apple-badge neutral">{item.finalPrice === null ? '到手价待采集' : '未降价'}</span>
                                )}
                                {isAtHistoricLow(item) && (
                                  <span className="apple-badge blue">史低</span>
                                )}
                              </div>
                              <h3 title={item.title}>{item.title}</h3>
                              <p className="item-sub">
                                {item.shopName} · {item.spec}
                              </p>
                            </div>

                            <div className="item-price-box">
                              <strong className="sf-mono item-final">
                                {item.finalPrice !== null ? `¥${formatPrice(item.finalPrice)}`
                                  : item.priceHistory.length > 0 ? `标价 ¥${formatPrice(item.pagePrice)}` : '待采集'}
                              </strong>
                              {item.finalPrice !== null && item.priceHistory.length > 0 &&
                                <del className="sf-mono item-origin">¥{formatPrice(item.pagePrice)}</del>}
                              {item.hasSubsidy && item.subsidyDiscount > 0 && (
                                <span className="item-subsidy-pill">国补 -¥{item.subsidyDiscount}</span>
                              )}
                            </div>
                          </div>

                          <div className="item-row-bottom" onClick={e => e.stopPropagation()}>
                            <div className="item-coupons">
                              {item.coupons.slice(0, 2).map((c, idx) => (
                                <span key={idx} className="coupon-tag">
                                  {c}
                                </span>
                              ))}
                            </div>
                            <div className="item-actions">
                              <button type="button" disabled={isLoading} onClick={() => refreshProduct(item)}>
                                刷新价格
                              </button>
                              <button
                                type="button"
                                className="danger-text"
                                disabled={isLoading}
                                onClick={() => removeProduct(item)}
                              >
                                移除
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </aside>

              <div className="apple-surface detail-surface">
                {selectedProduct ? (
                  <>
                    <div className="detail-top-bar">
                      <div className="detail-heading">
                        <div className="detail-caption">
                          <span>{selectedProduct.platformLabel || '京东'}</span>
                          <span>·</span>
                          <span className="sf-mono">SKU {selectedProduct.id}</span>
                          <span>·</span>
                          <span>{selectedProduct.shopName}</span>
                          <span>·</span>
                          <span className={selectedProduct.inStock ? 'status-text green' : 'status-text red'}>
                            {selectedProduct.stockText}
                          </span>
                        </div>
                        <h1>{selectedProduct.title}</h1>
                      </div>
                      <div className="detail-btns">
                        <button
                          type="button"
                          className="apple-btn-secondary"
                          disabled={productActionBusy === selectedProduct.key}
                          onClick={() => refreshProduct(selectedProduct)}
                        >
                          立即刷新价格
                        </button>
                        <a
                          href={selectedProduct.canonicalUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="apple-btn-primary"
                        >
                          前往商品页
                        </a>
                      </div>
                    </div>

                    <ApplePriceDetail product={selectedProduct} />
                  </>
                ) : (
                  <div className="apple-empty large">
                    <p>选择或添加一件商品</p>
                    <span>在此查看页面标价、优惠券折算、国家补贴到手价及历史走势折线图</span>
                  </div>
                )}
              </div>
            </section>
          </main>
        )}

        {/* 页面 2：平台账号与服务端会话（分为上下两排：第一排京东，第二排淘宝） */}
        {activePage === 'sessions' && (
          <main className="page-body sessions-rows">
            {/* 第一排：京东 (JD.com) */}
            <section className="apple-surface settings-surface">
              <div className="surface-header">
                <div>
                  <h2>京东 (JD.com) 平台账号与服务端长效会话</h2>
                  <p>支持网页内二维码扫码或手机号短信验证码登录，Cookie 长期保存在服务端并每 10 分钟自动保活</p>
                </div>
                <span className={`apple-badge ${jdSession?.state === 'logged_in' ? 'green' : 'neutral'}`}>
                  {jdSession?.state === 'logged_in' ? '已登录' : jdSession?.state === 'unverified' ? '待复核' : '未登录'}
                </span>
              </div>

              <div className="settings-body">
                <div className="apple-callout" role="status">
                  {jdMessage}
                </div>

                <div className="apple-account-group">
                  <div className="account-cells">
                    <div className="account-cell">
                      <span>京东昵称</span>
                      <strong>{jdSession?.nickname || '未登录'}</strong>
                    </div>
                    <div className="account-cell">
                      <span>账号标识 (PIN)</span>
                      <strong className="sf-mono">{jdSession?.state === 'logged_in' ? jdSession.pin : '—'}</strong>
                    </div>
                    <div className="account-cell">
                      <span>已持久化 Cookie</span>
                      <strong className="sf-mono">{jdSession?.cookieCount ?? 0} 项</strong>
                    </div>
                    <div className="account-cell">
                      <span>服务端保活机制</span>
                      <strong>{jdSession?.state === 'logged_in' ? '每 10 分钟检查会话' : '登录后自动开启'}</strong>
                    </div>
                  </div>

                  <div className="button-group">
                    {jdSession?.state === 'logged_in' && (
                      <button
                        type="button"
                        className="apple-btn-primary sm"
                        disabled={jdBusy}
                        onClick={keepAliveJd}
                      >
                        立即保活刷新
                      </button>
                    )}
                    <button
                      type="button"
                      className="apple-btn-secondary sm"
                      disabled={jdBusy}
                      onClick={checkJdSession}
                    >
                      检查京东状态
                    </button>
                    <button
                      type="button"
                      className="apple-btn-secondary sm"
                      disabled={jdBusy}
                      onClick={() => {
                        setAuthTab('mobile');
                        setShowJdAuthPanel(true);
                      }}
                    >
                      {jdSession?.mobileLoginReady ? '重新登录京东手机版' : '登录京东手机版'}
                    </button>
                    <button
                      type="button"
                      className="apple-btn-secondary sm"
                      disabled={jdBusy}
                      onClick={() => {
                        setShowJdAuthPanel(prev => !prev);
                        if (!showJdAuthPanel && authTab === 'qrcode' && !jdQr) {
                          void startJdQrLogin();
                        }
                      }}
                    >
                      {showJdAuthPanel
                        ? '收起京东登录面板'
                        : jdSession?.state === 'logged_in'
                          ? '切换京东账号'
                          : '展开京东扫码 / 验证码登录'}
                    </button>
                    {(jdSession?.state === 'logged_in' || jdSession?.mobileLoginReady) && (
                      <button
                        type="button"
                        className="apple-btn-danger sm"
                        disabled={jdBusy}
                        onClick={logoutJdSession}
                      >
                        退出京东账号
                      </button>
                    )}
                  </div>
                </div>

                {(showJdAuthPanel || (jdSession?.state !== 'logged_in' && !jdSession?.mobileLoginReady)) && (
                  <div className="apple-auth-group">
                    <div className="apple-segmented">
                      <button
                        type="button"
                        className={authTab === 'qrcode' ? 'active' : ''}
                        onClick={() => {
                          setAuthTab('qrcode');
                          if (!jdQr) void startJdQrLogin();
                        }}
                      >
                        京东 App 扫码登录
                      </button>
                      <button
                        type="button"
                        className={authTab === 'sms' ? 'active' : ''}
                        onClick={() => setAuthTab('sms')}
                      >
                        手机号短信验证码登录
                      </button>
                      <button
                        type="button"
                        className={authTab === 'remote' ? 'active' : ''}
                        onClick={() => setAuthTab('remote')}
                      >
                        云端实时画面（过人机验证 / 可视化登录）
                      </button>
                      <button
                        type="button"
                        className={authTab === 'mobile' ? 'active' : ''}
                        onClick={() => setAuthTab('mobile')}
                      >
                        京东手机版
                      </button>
                    </div>

                    {authTab === 'qrcode' ? (
                      <div className="apple-qr-panel">
                        {!jdQr?.qrImage ? (
                          <div className="button-group">
                            <button
                              type="button"
                              className="apple-btn-primary sm"
                              disabled={jdBusy}
                              onClick={startJdQrLogin}
                            >
                              获取京东登录二维码
                            </button>
                          </div>
                        ) : (
                          <div className="qr-card-row">
                            <div className="qr-image-frame">
                              <img src={jdQr.qrImage} alt="京东扫码登录" width={138} height={138} />
                              {['qr_expired', 'qr_cancelled'].includes(jdQr.state) && (
                                <div className="qr-mask-layer">
                                  <span>{jdQr.state === 'qr_expired' ? '二维码已过期' : '已取消扫码'}</span>
                                  <button
                                    type="button"
                                    className="apple-btn-primary sm"
                                    onClick={startJdQrLogin}
                                  >
                                    刷新
                                  </button>
                                </div>
                              )}
                            </div>
                            <div className="qr-copy">
                              <strong>使用京东 App 扫码登录</strong>
                              <p>{jdQr.message}</p>
                              <span>手机确认后二维码将立即自动关闭；若触发异地人机验证将自动切至云端实时画面。</span>
                              <div className="button-group">
                                <button
                                  type="button"
                                  className="apple-btn-secondary sm"
                                  disabled={jdBusy}
                                  onClick={startJdQrLogin}
                                >
                                  刷新二维码
                                </button>
                                <button
                                  type="button"
                                  className="apple-btn-secondary sm"
                                  disabled={jdBusy}
                                  onClick={() => setAuthTab('remote')}
                                >
                                  打开云端实时画面
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : authTab === 'sms' ? (
                      <form className="apple-sms-form" onSubmit={submitJdSmsLogin}>
                        <div className="sms-grid-row">
                          <div className="apple-field">
                            <label htmlFor="jd-phone">京东绑定手机号</label>
                            <div className="field-inline">
                              <input
                                id="jd-phone"
                                type="tel"
                                maxLength={11}
                                required
                                value={mobileInput}
                                onChange={e => setMobileInput(e.target.value)}
                                placeholder="输入 11 位手机号"
                              />
                              <button
                                type="button"
                                className="apple-btn-secondary"
                                disabled={jdBusy || smsCountdown > 0}
                                onClick={sendJdSmsCode}
                              >
                                {smsCountdown > 0 ? `${smsCountdown}s 后重发` : '获取验证码'}
                              </button>
                            </div>
                          </div>

                          <div className="apple-field">
                            <label htmlFor="jd-code">短信验证码</label>
                            <div className="field-inline">
                              <input
                                id="jd-code"
                                type="text"
                                maxLength={6}
                                required
                                value={smsCodeInput}
                                onChange={e => setSmsCodeInput(e.target.value)}
                                placeholder="输入 6 位短信验证码"
                              />
                              <button type="submit" className="apple-btn-primary" disabled={jdBusy}>
                                {jdBusy ? '登录中…' : '登录并保存'}
                              </button>
                            </div>
                          </div>
                        </div>
                      </form>
                    ) : (
                      <RemoteBrowserViewport
                        key={authTab}
                        platform="jd"
                        jdMobile={authTab === 'mobile'}
                        initialFrame={authTab === 'mobile' ? null : jdRemoteFrame}
                        onMessage={msg => setJdMessage(msg)}
                        onLoggedIn={session => {
                          setJdSession(session);
                          setJdQr(null);
                          setShowJdAuthPanel(false);
                          setJdMessage(session.message);
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* 第二排：淘宝 / 天猫 (Taobao / Tmall) —— 与京东完全一致的网页内直接扫码 + 手机号短信验证码双登录 */}
            <section className="apple-surface settings-surface">
              <div className="surface-header">
                <div>
                  <h2>淘宝 / 天猫 (Taobao / Tmall) 平台账号与服务端长效会话</h2>
                  <p>支持网页内二维码扫码或手机号短信验证码登录，Cookie 长期保存在服务端并每 10 分钟自动保活</p>
                </div>
                <span className={`apple-badge ${tbSession?.state === 'logged_in' ? 'green' : 'neutral'}`}>
                  {tbSession?.state === 'logged_in' ? '已登录' : '未登录'}
                </span>
              </div>

              <div className="settings-body">
                <div className="apple-callout" role="status">
                  {tbMessage}
                </div>

                <div className="apple-account-group">
                  <div className="account-cells">
                    <div className="account-cell">
                      <span>淘宝昵称</span>
                      <strong>{tbSession?.state === 'logged_in' ? tbSession.nickname : '未登录'}</strong>
                    </div>
                    <div className="account-cell">
                      <span>账号标识 (UID)</span>
                      <strong className="sf-mono">{tbSession?.state === 'logged_in' ? tbSession.pin : '—'}</strong>
                    </div>
                    <div className="account-cell">
                      <span>已持久化 Cookie</span>
                      <strong className="sf-mono">{tbSession?.cookieCount ?? 0} 项</strong>
                    </div>
                    <div className="account-cell">
                      <span>服务端保活机制</span>
                      <strong>{tbSession?.state === 'logged_in' ? '每 10 分钟检查会话' : '登录后自动开启'}</strong>
                    </div>
                  </div>

                  <div className="button-group">
                    {tbSession?.state === 'logged_in' && (
                      <button
                        type="button"
                        className="apple-btn-primary sm"
                        disabled={tbBusy}
                        onClick={keepAliveTaobao}
                      >
                        立即保活刷新
                      </button>
                    )}
                    <button
                      type="button"
                      className="apple-btn-secondary sm"
                      disabled={tbBusy}
                      onClick={checkTaobaoSession}
                    >
                      检查淘宝状态
                    </button>
                    <button
                      type="button"
                      className="apple-btn-secondary sm"
                      disabled={tbBusy}
                      onClick={() => {
                        setShowTbAuthPanel(prev => !prev);
                        if (!showTbAuthPanel && tbAuthTab === 'qrcode' && !tbQr) {
                          void startTaobaoQrLogin();
                        }
                      }}
                    >
                      {showTbAuthPanel
                        ? '收起淘宝登录面板'
                        : tbSession?.state === 'logged_in'
                          ? '切换淘宝账号'
                          : '展开淘宝扫码 / 验证码登录'}
                    </button>
                    {tbSession?.state === 'logged_in' && (
                      <button
                        type="button"
                        className="apple-btn-danger sm"
                        disabled={tbBusy}
                        onClick={logoutTaobaoSession}
                      >
                        退出淘宝账号
                      </button>
                    )}
                  </div>
                </div>

                {(tbSession?.state !== 'logged_in' || showTbAuthPanel) && (
                  <div className="apple-auth-group">
                    <div className="apple-segmented">
                      <button
                        type="button"
                        className={tbAuthTab === 'qrcode' ? 'active' : ''}
                        onClick={() => {
                          setTbAuthTab('qrcode');
                          if (!tbQr) void startTaobaoQrLogin();
                        }}
                      >
                        淘宝 App 扫码登录
                      </button>
                      <button
                        type="button"
                        className={tbAuthTab === 'sms' ? 'active' : ''}
                        onClick={() => setTbAuthTab('sms')}
                      >
                        手机号短信验证码登录
                      </button>
                      <button
                        type="button"
                        className={tbAuthTab === 'remote' ? 'active' : ''}
                        onClick={() => setTbAuthTab('remote')}
                      >
                        云端实时画面（过人机验证 / 可视化登录）
                      </button>
                    </div>

                    {tbAuthTab === 'qrcode' ? (
                      <div className="apple-qr-panel">
                        {!tbQr?.qrImage ? (
                          <div className="button-group">
                            <button
                              type="button"
                              className="apple-btn-primary sm"
                              disabled={tbBusy}
                              onClick={startTaobaoQrLogin}
                            >
                              获取淘宝登录二维码
                            </button>
                          </div>
                        ) : (
                          <div className="qr-card-row">
                            <div className="qr-image-frame">
                              <img src={tbQr.qrImage} alt="淘宝扫码登录" width={138} height={138} />
                              {['qr_expired', 'qr_cancelled'].includes(tbQr.state) && (
                                <div className="qr-mask-layer">
                                  <span>{tbQr.state === 'qr_expired' ? '二维码已过期' : '已取消扫码'}</span>
                                  <button
                                    type="button"
                                    className="apple-btn-primary sm"
                                    onClick={startTaobaoQrLogin}
                                  >
                                    刷新
                                  </button>
                                </div>
                              )}
                            </div>
                            <div className="qr-copy">
                              <strong>使用手机淘宝 App 扫码登录</strong>
                              <p>{tbQr.message}</p>
                              <span>手机确认后二维码将立即自动关闭，登录态持久保存于服务端。</span>
                              <div className="button-group">
                                <button
                                  type="button"
                                  className="apple-btn-secondary sm"
                                  disabled={tbBusy}
                                  onClick={startTaobaoQrLogin}
                                >
                                  刷新二维码
                                </button>
                                <button
                                  type="button"
                                  className="apple-btn-secondary sm"
                                  disabled={tbBusy}
                                  onClick={() => setTbAuthTab('remote')}
                                >
                                  打开云端实时画面
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : tbAuthTab === 'sms' ? (
                      <form className="apple-sms-form" onSubmit={submitTaobaoSmsLogin}>
                        <div className="sms-grid-row">
                          <div className="apple-field">
                            <label htmlFor="tb-phone">淘宝绑定手机号</label>
                            <div className="field-inline">
                              <input
                                id="tb-phone"
                                type="tel"
                                maxLength={11}
                                required
                                value={tbMobileInput}
                                onChange={e => setTbMobileInput(e.target.value)}
                                placeholder="输入 11 位手机号"
                              />
                              <button
                                type="button"
                                className="apple-btn-secondary"
                                disabled={tbBusy || tbSmsCountdown > 0}
                                onClick={sendTaobaoSmsCode}
                              >
                                {tbSmsCountdown > 0 ? `${tbSmsCountdown}s 后重发` : '获取验证码'}
                              </button>
                            </div>
                          </div>

                          <div className="apple-field">
                            <label htmlFor="tb-code">短信验证码</label>
                            <div className="field-inline">
                              <input
                                id="tb-code"
                                type="text"
                                maxLength={6}
                                required
                                value={tbSmsCodeInput}
                                onChange={e => setTbSmsCodeInput(e.target.value)}
                                placeholder="输入收到的短信验证码"
                              />
                              <button type="submit" className="apple-btn-primary" disabled={tbBusy}>
                                {tbBusy ? '登录中…' : '登录并保存'}
                              </button>
                            </div>
                          </div>
                        </div>
                      </form>
                    ) : (
                      <RemoteBrowserViewport
                        platform="taobao"
                        initialFrame={tbRemoteFrame}
                        onMessage={msg => setTbMessage(msg)}
                        onLoggedIn={session => {
                          setTbSession(session);
                          setTbQr(null);
                          setShowTbAuthPanel(false);
                          setTbMessage(session.message);
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
            </section>
          </main>
        )}

        {/* 页面 3：飞书 Webhook 推送设置 */}
        {activePage === 'feishu' && (
          <main className="page-body">
            <section className="apple-surface settings-surface">
              <div className="surface-header">
                <div>
                  <h2>飞书群自定义机器人 Webhook 设置</h2>
                  <p>当监控商品降价、新出大额优惠券与国家补贴、商品下架或平台登录态失效时，实时推送飞书富文本卡片</p>
                </div>
                <span
                  className={`apple-badge ${feishuConfig.webhookUrl && feishuConfig.enabled ? 'green' : 'neutral'}`}
                >
                  {feishuConfig.webhookUrl && feishuConfig.enabled ? '已开启' : '未配置'}
                </span>
              </div>

              <form className="settings-body" onSubmit={saveFeishu}>
                <div className="sms-grid-row">
                  <div className="apple-field">
                    <label htmlFor="feishu-url">飞书群自定义机器人 Webhook 地址</label>
                    <input
                      id="feishu-url"
                      type="url"
                      value={feishuConfig.webhookUrl}
                      onChange={e => setFeishuConfig(prev => ({ ...prev, webhookUrl: e.target.value }))}
                      placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                    />
                  </div>

                  <div className="apple-field">
                    <label htmlFor="feishu-key">签名校验密钥 Secret（选填）</label>
                    <input
                      id="feishu-key"
                      type="password"
                      value={feishuConfig.secret}
                      onChange={e => setFeishuConfig(prev => ({ ...prev, secret: e.target.value }))}
                      placeholder="对应飞书机器人安全设置中的签名密钥，未开启可留空"
                    />
                  </div>
                </div>

                <div className="apple-check-group">
                  <label className="apple-check-row">
                    <div>
                      <strong>启用飞书 Webhook 实时推送</strong>
                      <p>总开关：开启后所有命中的价格与状态事件将自动推送到飞书群</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={feishuConfig.enabled}
                      onChange={e => setFeishuConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                    />
                  </label>
                  <label className="apple-check-row">
                    <div>
                      <strong>商品降价 / 优惠券与国家补贴变动提醒</strong>
                      <p>推送降价前价格 vs 当前最优到手价、直降金额与比例、优惠券与国补明细及史低价对比</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={feishuConfig.notifyOnPriceDrop}
                      onChange={e => setFeishuConfig(prev => ({ ...prev, notifyOnPriceDrop: e.target.checked }))}
                    />
                  </label>
                  <label className="apple-check-row">
                    <div>
                      <strong>商品下架 / 无货提醒</strong>
                      <p>当监控中的京东或淘宝商品出现断货、下架或停止销售时第一时间通知</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={feishuConfig.notifyOnDelist}
                      onChange={e => setFeishuConfig(prev => ({ ...prev, notifyOnDelist: e.target.checked }))}
                    />
                  </label>
                  <label className="apple-check-row">
                    <div>
                      <strong>平台登录态失效告警</strong>
                      <p>当服务端保存的京东或淘宝 Cookie 过期需要重新扫码时发送提醒</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={feishuConfig.notifyOnSessionExpire}
                      onChange={e => setFeishuConfig(prev => ({ ...prev, notifyOnSessionExpire: e.target.checked }))}
                    />
                  </label>
                </div>

                <div className="button-group">
                  <button type="submit" className="apple-btn-primary sm" disabled={feishuBusy}>
                    保存飞书设置
                  </button>
                  <button
                    type="button"
                    className="apple-btn-secondary sm"
                    disabled={feishuBusy || !feishuConfig.webhookUrl}
                    onClick={testFeishuPush}
                  >
                    发送测试卡片
                  </button>
                </div>

                {(feishuMessage || feishuConfig.lastPushMessage) && (
                  <div className="apple-callout" role="status">
                    {feishuMessage ||
                      `最近推送 (${
                        feishuConfig.lastPushAt ? new Date(feishuConfig.lastPushAt).toLocaleString('zh-CN') : ''
                      })：${feishuConfig.lastPushMessage}`}
                  </div>
                )}
              </form>
            </section>
          </main>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
