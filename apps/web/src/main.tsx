import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

interface PriceHistoryPoint {
  timestamp: string;
  pagePrice: number;
  couponPrice: number | null;
  subsidyPrice: number | null;
  finalPrice: number;
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
  finalPrice: number;
  coupons: string[];
  couponDiscount: number;
  hasSubsidy: boolean;
  subsidyLabel: string | null;
  subsidyDiscount: number;
  allTimeLow: number;
  allTimeLowAt: string;
  allTimeHigh: number;
  initialPrice: number;
  previousFinalPrice: number | null;
  lastDropAmount: number;
  priceHistory: PriceHistoryPoint[];
  createdAt: string;
  updatedAt: string;
}

interface JdSessionInfo {
  state: string;
  nickname?: string;
  pin?: string;
  mobile?: string;
  source?: string;
  updatedAt?: string;
  lastKeepAliveAt?: string;
  keepAliveCount?: number;
  cookieCount?: number;
  storagePath?: string;
  message: string;
}

interface JdQrCodeState {
  state: string;
  qrImage?: string;
  token?: string;
  code?: number;
  message: string;
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

function PriceTrendChart({ product }: { product: MonitoredProduct }) {
  const points = product.priceHistory || [];
  if (points.length === 0) {
    return (
      <div className="chart-empty">
        <span>暂无价格轨迹数据</span>
      </div>
    );
  }

  const width = 760;
  const height = 230;
  const padLeft = 56;
  const padRight = 28;
  const padTop = 26;
  const padBottom = 38;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const allValues = points.flatMap(p => [p.finalPrice, p.pagePrice]).filter(v => v > 0);
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const span = Math.max(10, maxVal - minVal);
  const yMin = Math.max(0, Math.floor(minVal - span * 0.2));
  const yMax = Math.ceil(maxVal + span * 0.2);

  const getX = (idx: number) =>
    points.length === 1 ? padLeft + plotW / 2 : padLeft + (idx / (points.length - 1)) * plotW;
  const getY = (val: number) => padTop + plotH - ((val - yMin) / Math.max(1, yMax - yMin)) * plotH;

  const finalCoords = points.map((p, i) => ({ x: getX(i), y: getY(p.finalPrice), point: p }));
  const pageCoords = points.map((p, i) => ({ x: getX(i), y: getY(p.pagePrice), point: p }));

  const finalPath = finalCoords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
  const pagePath = pageCoords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
  const areaPath = `${finalPath} L ${finalCoords[finalCoords.length - 1].x.toFixed(1)} ${padTop + plotH} L ${finalCoords[0].x.toFixed(1)} ${padTop + plotH} Z`;
  const lowY = getY(product.allTimeLow);

  return (
    <div className="trend-panel">
      <div className="trend-metrics">
        <div className="metric-card highlight">
          <span>当前最优到手价（含券/国补）</span>
          <strong>¥{product.finalPrice.toFixed(2)}</strong>
          <small>
            {product.hasSubsidy
              ? product.subsidyLabel
              : product.couponDiscount > 0
                ? `已减免优惠券 ¥${product.couponDiscount}`
                : '当前页面直售价'}
          </small>
        </div>
        <div className="metric-card">
          <span>页面日常标价 / 券后价</span>
          <strong>
            ¥{product.pagePrice.toFixed(2)}
            {product.couponPrice !== null ? ` → ¥${product.couponPrice.toFixed(2)}` : ''}
          </strong>
          <small>
            {product.coupons.length > 0 ? `可领券：${product.coupons.join('、')}` : '暂未检测到店铺满减券'}
          </small>
        </div>
        <div className="metric-card low">
          <span>历史最低价（史低价）</span>
          <strong>¥{product.allTimeLow.toFixed(2)}</strong>
          <small>
            {product.finalPrice <= product.allTimeLow
              ? '🔥 当前正处于史低价'
              : `距史低差 ¥${(product.finalPrice - product.allTimeLow).toFixed(2)}`}
          </small>
        </div>
        <div className="metric-card">
          <span>监控最高价 / 最近降幅</span>
          <strong>¥{product.allTimeHigh.toFixed(2)}</strong>
          <small>
            {product.lastDropAmount > 0
              ? `最近一次直降 ¥${product.lastDropAmount.toFixed(2)}`
              : `累计较标价省 ¥${Math.max(0, product.pagePrice - product.finalPrice).toFixed(2)}`}
          </small>
        </div>
      </div>

      <div className="svg-chart-wrapper">
        <div className="chart-legend">
          <span className="legend-item">
            <i className="dot final-dot" /> 最优到手价（含国补 & 优惠券）
          </span>
          <span className="legend-item">
            <i className="dot page-dot" /> 页面标价
          </span>
          <span className="legend-item">
            <i className="dot low-dot" /> 史低基准线 (¥{product.allTimeLow.toFixed(2)})
          </span>
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} className="price-svg">
          <defs>
            <linearGradient id="priceAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#26734f" stopOpacity="0.24" />
              <stop offset="100%" stopColor="#26734f" stopOpacity="0.0" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((ratio, idx) => {
            const y = padTop + ratio * plotH;
            const labelVal = Math.round(yMax - ratio * (yMax - yMin));
            return (
              <g key={idx}>
                <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke="#ebf0ec" strokeWidth="1" />
                <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize="10" fill="#8b9b90">
                  ¥{labelVal}
                </text>
              </g>
            );
          })}
          <line
            x1={padLeft}
            y1={lowY}
            x2={width - padRight}
            y2={lowY}
            stroke="#d9534f"
            strokeDasharray="4 4"
            strokeWidth="1.2"
          />
          <path d={areaPath} fill="url(#priceAreaGrad)" />
          <path d={pagePath} fill="none" stroke="#9ab0a2" strokeWidth="2" strokeDasharray="5 4" />
          <path d={finalPath} fill="none" stroke="#26734f" strokeWidth="3" strokeLinecap="round" />

          {finalCoords.map((c, idx) => (
            <g key={idx}>
              <circle cx={c.x} cy={c.y} r="4.5" fill="#fff" stroke="#26734f" strokeWidth="2.5" />
              <text x={c.x} y={c.y - 10} textAnchor="middle" fontSize="10" fontWeight="600" fill="#1f5c3f">
                ¥{c.point.finalPrice}
              </text>
              <text x={c.x} y={height - 12} textAnchor="middle" fontSize="10" fill="#88988e">
                {new Date(c.point.timestamp).toLocaleTimeString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div className="history-table-wrap">
        <table className="history-table">
          <thead>
            <tr>
              <th>采集时间</th>
              <th>页面标价</th>
              <th>券后价</th>
              <th>国补后到手价</th>
              <th>最优到手价</th>
              <th>库存状态</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {[...points].reverse().map((pt, idx) => (
              <tr key={idx}>
                <td>{new Date(pt.timestamp).toLocaleString('zh-CN')}</td>
                <td>¥{pt.pagePrice.toFixed(2)}</td>
                <td>{pt.couponPrice !== null ? `¥${pt.couponPrice.toFixed(2)}` : '—'}</td>
                <td>{pt.subsidyPrice !== null ? `¥${pt.subsidyPrice.toFixed(2)}` : '—'}</td>
                <td className="final-cell">¥{pt.finalPrice.toFixed(2)}</td>
                <td>{pt.inStock ? '现货' : '无货/下架'}</td>
                <td>{pt.note || '定时巡检'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function App() {
  const [status, setStatus] = useState('正在连接');
  const [url, setUrl] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);

  // 商品与价格历史状态
  const [products, setProducts] = useState<MonitoredProduct[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [productActionBusy, setProductActionBusy] = useState<string>('');

  // 京东登录态（扫码 + 手机号验证码 + 服务端长期保持）
  const [sessionMessage, setSessionMessage] = useState('京东登录态持久保存在服务端，刷新页面不会丢失。');
  const [sessionBusy, setSessionBusy] = useState(false);
  const [jdSession, setJdSession] = useState<JdSessionInfo | null>(null);
  const [jdQr, setJdQr] = useState<JdQrCodeState | null>(null);
  const [authTab, setAuthTab] = useState<'qrcode' | 'sms'>('qrcode');
  const [showJdAuthPanel, setShowJdAuthPanel] = useState(false);
  const [mobileInput, setMobileInput] = useState('');
  const [smsCodeInput, setSmsCodeInput] = useState('');
  const [smsCountdown, setSmsCountdown] = useState(0);

  // 飞书 Webhook 状态
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

  const selectedProduct = useMemo(
    () => products.find(p => p.key === selectedKey) || products[0] || null,
    [products, selectedKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('API unavailable');
        return response.json();
      })
      .then((data: { status: string }) => setStatus(data.status === 'ok' ? '服务正常' : '服务异常'))
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setStatus('服务未连接');
      });

    fetch('/api/products', { signal: controller.signal })
      .then(res => (res.ok ? res.json() : null))
      .then((data: { products?: MonitoredProduct[] } | null) => {
        if (data?.products) {
          setProducts(data.products);
          if (data.products[0]) setSelectedKey(data.products[0].key);
        }
      })
      .catch(() => {});

    fetch('/api/sessions/jd/status', { signal: controller.signal })
      .then(res => (res.ok ? res.json() : null))
      .then((data: JdSessionInfo | null) => {
        if (data) {
          setJdSession(data);
          if (data.state === 'logged_in') {
            setJdQr(null);
            setShowJdAuthPanel(false);
            setSessionMessage(`京东：${data.message}`);
          } else {
            setShowJdAuthPanel(true);
          }
        }
      })
      .catch(() => {});

    fetch('/api/feishu/config', { signal: controller.signal })
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

  // 京东二维码轮询：一旦登录成功 (state === 'logged_in')，二维码立即消失并切换为已登录视图
  useEffect(() => {
    if (!jdQr || !['qr_ready', 'qr_waiting', 'qr_scanned'].includes(jdQr.state)) {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch('/api/sessions/jd/qrcode/status');
        if (!res.ok) return;
        const data = (await res.json()) as JdQrCodeState & JdSessionInfo;
        if (data.state === 'logged_in') {
          // 登录成功：立即销毁页面上的二维码面板，展示已登录状态
          setJdQr(null);
          setShowJdAuthPanel(false);
          setJdSession(data);
          setSessionMessage(`京东：${data.message}`);
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
        setSessionMessage(`京东扫码 [code=${data.code ?? '-'}]：${data.message}`);
      } catch {
        // ignore transient polling error
      }
    }, 2200);
    return () => window.clearInterval(timer);
  }, [jdQr?.state]);

  // 短信验证码倒计时
  useEffect(() => {
    if (smsCountdown <= 0) return;
    const t = window.setInterval(() => {
      setSmsCountdown(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [smsCountdown]);

  async function parse(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResult('');
    try {
      const response = await fetch('/api/products/parse?url=' + encodeURIComponent(url));
      const data = (await response.json()) as MonitoredProduct & { message?: string };
      if (!response.ok) throw new Error(data.message || '商品链接识别或抓取失败');
      setResult(`${data.platformLabel || data.platform} · ${data.title.slice(0, 32)}。${data.message}`);
      setProducts(prev => {
        const idx = prev.findIndex(p => p.key === data.key);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = data;
          return copy;
        }
        return [data, ...prev];
      });
      setSelectedKey(data.key);
      setUrl('');
    } catch (error) {
      setResult(error instanceof Error ? error.message : '服务未连接');
    } finally {
      setBusy(false);
    }
  }

  async function refreshProduct(item: MonitoredProduct) {
    setProductActionBusy(item.key);
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(item.id)}/refresh`, { method: 'POST' });
      const data = (await res.json()) as { product?: MonitoredProduct; message?: string };
      if (!res.ok) throw new Error(data.message || '刷新失败');
      if (data.product) {
        setProducts(prev => prev.map(p => (p.key === data.product!.key ? data.product! : p)));
        setSelectedKey(data.product.key);
      }
      if (data.message) setResult(data.message);
    } catch (err) {
      setResult(err instanceof Error ? err.message : '刷新商品价格失败');
    } finally {
      setProductActionBusy('');
    }
  }

  async function simulateDropAndPush(item: MonitoredProduct) {
    setProductActionBusy(item.key);
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(item.id)}/simulate-drop`, { method: 'POST' });
      const data = (await res.json()) as { product?: MonitoredProduct; message?: string };
      if (!res.ok) throw new Error(data.message || '模拟降价失败');
      if (data.product) {
        setProducts(prev => prev.map(p => (p.key === data.product!.key ? data.product! : p)));
        setSelectedKey(data.product.key);
      }
      if (data.message) setResult(data.message);
    } catch (err) {
      setResult(err instanceof Error ? err.message : '操作失败');
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
    setSessionBusy(true);
    setAuthTab('qrcode');
    setShowJdAuthPanel(true);
    try {
      const response = await fetch('/api/sessions/jd/qrcode/start', { method: 'POST' });
      const data = (await response.json()) as JdQrCodeState;
      if (!response.ok) throw new Error(data.message || '获取京东二维码失败');
      setJdQr(data);
      setSessionMessage('京东：' + data.message);
    } catch (error) {
      setSessionMessage(error instanceof Error ? error.message : '无法连接本地服务');
    } finally {
      setSessionBusy(false);
    }
  }

  async function sendJdSmsCode() {
    if (!/^1[3-9]\d{9}$/.test(mobileInput.trim())) {
      setSessionMessage('京东：请输入有效的 11 位手机号码');
      return;
    }
    setSessionBusy(true);
    try {
      const res = await fetch('/api/sessions/jd/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: mobileInput.trim() }),
      });
      const data = (await res.json()) as { message?: string; countdown?: number };
      if (!res.ok) throw new Error(data.message || '发送验证码失败');
      setSmsCountdown(data.countdown || 60);
      setSessionMessage('京东：' + (data.message || '短信验证码已发送'));
    } catch (err) {
      setSessionMessage('京东：' + (err instanceof Error ? err.message : '发送验证码失败'));
    } finally {
      setSessionBusy(false);
    }
  }

  async function submitJdSmsLogin(event: React.FormEvent) {
    event.preventDefault();
    setSessionBusy(true);
    try {
      const res = await fetch('/api/sessions/jd/sms/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mobile: mobileInput.trim(),
          code: smsCodeInput.trim(),
        }),
      });
      const data = (await res.json()) as JdSessionInfo;
      if (!res.ok) throw new Error(data.message || '短信验证码登录失败');
      if (data.state === 'logged_in') {
        setJdSession(data);
        setJdQr(null);
        setShowJdAuthPanel(false);
        setSmsCodeInput('');
      }
      setSessionMessage('京东：' + data.message);
    } catch (err) {
      setSessionMessage('京东：' + (err instanceof Error ? err.message : '登录失败'));
    } finally {
      setSessionBusy(false);
    }
  }

  async function keepAliveJd() {
    setSessionBusy(true);
    try {
      const res = await fetch('/api/sessions/jd/keepalive', { method: 'POST' });
      const data = (await res.json()) as JdSessionInfo;
      if (!res.ok) throw new Error(data.message || '保活失败');
      setJdSession(data);
      setSessionMessage('京东：' + data.message);
    } catch (err) {
      setSessionMessage('京东：' + (err instanceof Error ? err.message : '保活请求失败'));
    } finally {
      setSessionBusy(false);
    }
  }

  async function session(platform: 'jd' | 'taobao', action: 'open' | 'check') {
    setSessionBusy(true);
    try {
      const response = await fetch(`/api/sessions/${platform}/${action}`, { method: 'POST' });
      const data = (await response.json()) as JdSessionInfo;
      if (platform === 'jd' && data.state === 'logged_in') {
        setJdSession(data);
        setJdQr(null);
        setShowJdAuthPanel(false);
      }
      setSessionMessage((platform === 'jd' ? '京东：' : '淘宝：') + (data.message || '操作失败'));
    } catch {
      setSessionMessage('无法连接本地服务');
    } finally {
      setSessionBusy(false);
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
      setFeishuMessage(data.message || '飞书测试卡片发送成功！请查看飞书群消息');
    } catch (err) {
      setFeishuMessage(err instanceof Error ? err.message : '发送测试卡片失败');
    } finally {
      setFeishuBusy(false);
    }
  }

  return (
    <div className="shell">
      <header>
        <a className="brand" href="/">
          <span className="mark">↘</span>
          <span>
            price<span className="brand-light">drop</span>
            <small>价格观察室</small>
          </span>
        </a>
        <div className="status">
          <i className={status === '服务正常' ? 'online' : ''} />
          {status}
        </div>
      </header>
      <main>
        <div className="eyebrow">
          <span></span> PRICE MONITORING
        </div>
        <section className="intro">
          <div>
            <p className="kicker">YOUR SHOPPING COMPANION / 01</p>
            <h1>
              好价格，
              <br />
              <em>值得等一等。</em>
            </h1>
            <p className="description">
              实时追踪京东、淘宝商品标价、优惠券与国家补贴（国补）到手价，价格走势与飞书降价通知帮你把握最佳入手时机。
            </p>
          </div>
          <div className="art" aria-hidden="true">
            <div className="art-top">
              <span>PRICE TRACKER</span>
              <span>↗</span>
            </div>
            <div className="art-price">
              ¥ <strong>{selectedProduct ? selectedProduct.finalPrice.toFixed(0) : '— —'}</strong>
            </div>
            <div className="art-caption">
              {selectedProduct
                ? `${selectedProduct.title.slice(0, 18)}… (${selectedProduct.hasSubsidy ? '含国补到手价' : '当前到手价'})`
                : '等待发现好价格'}
            </div>
            <svg viewBox="0 0 300 100" fill="none">
              <path
                d="M0 20 C 32 24, 45 47, 78 38 S 117 28, 144 51 S 179 42, 208 64 S 257 57, 300 85"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <circle cx="300" cy="85" r="5" fill="currentColor" />
            </svg>
            <div className="art-bottom">
              <span>{products.length > 0 ? `正在监控 ${products.length} 件商品` : '实时价格 & 国补监控'}</span>
              <span>GOOD DEALS AHEAD ↗</span>
            </div>
          </div>
        </section>

        {/* 1. 商品链接添加与实时采集列表 */}
        <section className="workspace">
          <div className="section-heading">
            <div>
              <p className="kicker">PRODUCT SEARCH & SCRAPER</p>
              <h2>添加关注与实时采集</h2>
              <p>粘贴京东、淘宝或天猫商品链接（支持分享短链），立即抓取当前价格、可用优惠券及国家补贴（国补）后到手价。</p>
            </div>
            <span className="badge">已监控 {products.length} 件</span>
          </div>
          <form onSubmit={parse} className="search-form">
            <label htmlFor="product-url">商品链接</label>
            <div>
              <input
                id="product-url"
                type="text"
                required
                value={url}
                onChange={event => setUrl(event.target.value)}
                placeholder="粘贴京东 / 淘宝商品链接，例如 https://item.jd.com/100413060348.html"
              />
              <button disabled={busy}>{busy ? '采集中…' : '立即采集并监控'}</button>
            </div>
            <p role="status">{result || '粘贴链接即可自动解析商品信息、计算券后价与国补价并开启历史价格追踪。'}</p>
          </form>

          {products.length > 0 && (
            <div className="product-list">
              {products.map(item => {
                const isSelected = selectedProduct?.key === item.key;
                const isLoading = productActionBusy === item.key;
                return (
                  <div
                    key={item.key}
                    className={`product-card ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedKey(item.key)}
                  >
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt={item.title} className="product-thumb" />
                    ) : (
                      <div className="product-thumb placeholder">{item.platformLabel || '商品'}</div>
                    )}
                    <div className="product-body">
                      <div className="product-title-row">
                        <span className="platform-pill">{item.platformLabel || (item.platform === 'jd' ? '京东' : '淘宝')}</span>
                        <span className={`stock-pill ${item.inStock ? 'in-stock' : 'out-stock'}`}>{item.stockText}</span>
                        <h3>{item.title}</h3>
                      </div>
                      <p className="product-sub">
                        {item.shopName} · {item.spec} · 商品 ID: <code>{item.id}</code>
                      </p>
                      <div className="promo-tags">
                        {item.hasSubsidy && item.subsidyLabel && (
                          <span className="tag subsidy-tag">🟢 {item.subsidyLabel}</span>
                        )}
                        {item.coupons.map((c, idx) => (
                          <span key={idx} className="tag coupon-tag">
                            🎟️ {c}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="product-price-col">
                      <div className="final-price-box">
                        <small>{item.hasSubsidy ? '国补后到手价' : '预估到手价'}</small>
                        <strong>¥{item.finalPrice.toFixed(2)}</strong>
                      </div>
                      <div className="sub-prices">
                        <span>页面标价 ¥{item.pagePrice.toFixed(2)}</span>
                        {item.couponPrice !== null && <span>券后 ¥{item.couponPrice.toFixed(2)}</span>}
                        <span>史低 ¥{item.allTimeLow.toFixed(2)}</span>
                      </div>
                      <div className="product-card-actions" onClick={e => e.stopPropagation()}>
                        <button type="button" disabled={isLoading} onClick={() => refreshProduct(item)}>
                          刷新价格
                        </button>
                        <button
                          type="button"
                          className="secondary-btn"
                          disabled={isLoading}
                          onClick={() => simulateDropAndPush(item)}
                        >
                          模拟降价推送
                        </button>
                        <button
                          type="button"
                          className="danger-btn"
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
        </section>

        {/* 2. 价格走势与历史记录 */}
        <section className="workspace extra">
          <div className="section-heading">
            <div>
              <p className="kicker">PRICE HISTORY & TREND</p>
              <h2>价格走势与历史记录</h2>
              <p>
                {selectedProduct
                  ? `当前查看：${selectedProduct.title}（共 ${selectedProduct.priceHistory.length} 条价格记录）`
                  : '添加并选择上方监控商品后，这里将实时渲染页面标价、券后价与国补到手价走势图。'}
              </p>
            </div>
            <span className={`badge ${selectedProduct ? 'badge-success' : ''}`}>
              {selectedProduct ? `史低 ¥${selectedProduct.allTimeLow.toFixed(2)}` : '等待添加商品'}
            </span>
          </div>
          {selectedProduct ? (
            <PriceTrendChart product={selectedProduct} />
          ) : (
            <div className="chart-empty">
              <span>暂无价格数据</span>
              <small>请在上方粘贴商品链接并点击「立即采集并监控」</small>
            </div>
          )}
        </section>

        {/* 3. 平台登录管理（扫码登录 + 手机号验证码登录 + 服务端长效保持） */}
        <section className="workspace extra">
          <div className="section-heading">
            <div>
              <p className="kicker">PLATFORM SESSIONS</p>
              <h2>平台登录与服务端长效会话</h2>
              <p>支持京东二维码扫码或手机号短信验证码登录；登录成功后二维码实时关闭，登录态长期持久化保存在服务端。</p>
            </div>
            <span className={`badge ${jdSession?.state === 'logged_in' ? 'badge-success' : ''}`}>
              {jdSession?.state === 'logged_in'
                ? `京东已登录 · ${jdSession.nickname || jdSession.pin}`
                : '京东未登录'}
            </span>
          </div>

          <p className="integration-note" role="status">
            {sessionMessage}
          </p>

          {jdSession?.state === 'logged_in' && (
            <div className="session-logged-card">
              <div className="session-logged-main">
                <span className="online-dot" />
                <div>
                  <strong>京东服务端长效登录态运行中 · {jdSession.nickname}</strong>
                  <p>
                    账号标识：<code>{jdSession.pin}</code> ｜ 已持久化 Cookie：{jdSession.cookieCount ?? 0} 项 ｜ 服务端自动保活已开启
                    {jdSession.lastKeepAliveAt
                      ? `（最近保活：${new Date(jdSession.lastKeepAliveAt).toLocaleTimeString('zh-CN')}）`
                      : ''}
                  </p>
                </div>
              </div>
              <div className="session-actions">
                <button type="button" disabled={sessionBusy} onClick={keepAliveJd}>
                  立即保活刷新
                </button>
                <button
                  type="button"
                  disabled={sessionBusy}
                  onClick={() => session('jd', 'check')}
                  className="secondary-button"
                >
                  检查京东登录态
                </button>
                <button
                  type="button"
                  disabled={sessionBusy}
                  onClick={() => {
                    setShowJdAuthPanel(prev => !prev);
                    if (!showJdAuthPanel && authTab === 'qrcode' && !jdQr) {
                      void startJdQrLogin();
                    }
                  }}
                  className="secondary-button"
                >
                  {showJdAuthPanel ? '收起登录面板' : '切换京东账号'}
                </button>
                <button
                  type="button"
                  disabled={sessionBusy}
                  onClick={() => session('taobao', 'open')}
                  className="secondary-button"
                >
                  打开淘宝
                </button>
                <button
                  type="button"
                  disabled={sessionBusy}
                  onClick={() => session('taobao', 'check')}
                  className="secondary-button"
                >
                  检查淘宝
                </button>
              </div>
            </div>
          )}

          {(jdSession?.state !== 'logged_in' || showJdAuthPanel) && (
            <div className="auth-box">
              <div className="auth-tabs">
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
                  京东手机号验证码登录
                </button>
              </div>

              {authTab === 'qrcode' ? (
                <div className="auth-tab-body">
                  {!jdQr?.qrImage ? (
                    <div className="session-actions">
                      <button type="button" disabled={sessionBusy} onClick={startJdQrLogin}>
                        获取京东登录二维码
                      </button>
                      <button
                        type="button"
                        disabled={sessionBusy}
                        onClick={() => session('jd', 'check')}
                        className="secondary-button"
                      >
                        检查京东登录态
                      </button>
                    </div>
                  ) : (
                    <div className="qr-panel">
                      <div className="qr-image-box">
                        <img src={jdQr.qrImage} alt="京东扫码登录二维码" width={147} height={147} />
                        {['qr_expired', 'qr_cancelled'].includes(jdQr.state) && (
                          <div className="qr-mask">
                            <span>{jdQr.state === 'qr_expired' ? '二维码已失效' : '已取消扫码'}</span>
                            <button type="button" onClick={startJdQrLogin}>
                              点击刷新
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="qr-info">
                        <strong>打开手机京东 App 扫一扫</strong>
                        <p>{jdQr.message}</p>
                        <small>
                          扫码确认后此二维码将自动消失，登录 Cookie 将持久保存在服务端。
                        </small>
                        <div className="session-actions" style={{ marginTop: '8px' }}>
                          <button type="button" disabled={sessionBusy} onClick={startJdQrLogin}>
                            刷新二维码
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <form className="sms-login-form" onSubmit={submitJdSmsLogin}>
                  <div className="sms-row">
                    <input
                      type="tel"
                      maxLength={11}
                      required
                      value={mobileInput}
                      onChange={e => setMobileInput(e.target.value)}
                      placeholder="请输入 11 位京东绑定手机号"
                    />
                    <button
                      type="button"
                      disabled={sessionBusy || smsCountdown > 0}
                      onClick={sendJdSmsCode}
                      className="secondary-button"
                    >
                      {smsCountdown > 0 ? `${smsCountdown}s 后重发` : '获取短信验证码'}
                    </button>
                  </div>
                  <div className="sms-row">
                    <input
                      type="text"
                      maxLength={6}
                      required
                      value={smsCodeInput}
                      onChange={e => setSmsCodeInput(e.target.value)}
                      placeholder="请输入 6 位短信验证码"
                    />
                    <button type="submit" disabled={sessionBusy}>
                      {sessionBusy ? '登录中…' : '验证码登录并保存'}
                    </button>
                  </div>
                  <small className="sms-hint">
                    提示：若手机号触发京东图形/滑块风控拦截，可直接切换至「京东 App 扫码登录」免滑块直登。
                  </small>
                </form>
              )}
            </div>
          )}
        </section>

        {/* 4. 飞书 Webhook 实时消息通知配置 */}
        <section className="workspace extra">
          <div className="section-heading">
            <div>
              <p className="kicker">FEISHU WEBHOOK NOTIFICATIONS</p>
              <h2>飞书 Webhook 实时推送</h2>
              <p>接入飞书群自定义机器人 Webhook，当商品降价、新出优惠券/国补、商品下架或平台登录态失效时实时推送富文本卡片。</p>
            </div>
            <span className={`badge ${feishuConfig.webhookUrl && feishuConfig.enabled ? 'badge-success' : ''}`}>
              {feishuConfig.webhookUrl && feishuConfig.enabled ? 'Webhook 已启用' : '待配置 Webhook'}
            </span>
          </div>

          <form className="feishu-form" onSubmit={saveFeishu}>
            <div className="form-grid">
              <div>
                <label htmlFor="feishu-webhook">飞书机器人 Webhook 地址</label>
                <input
                  id="feishu-webhook"
                  type="url"
                  value={feishuConfig.webhookUrl}
                  onChange={e => setFeishuConfig(prev => ({ ...prev, webhookUrl: e.target.value }))}
                  placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                />
              </div>
              <div>
                <label htmlFor="feishu-secret">签名校验密钥（选填，对应飞书机器人安全设置中的签名密钥）</label>
                <input
                  id="feishu-secret"
                  type="password"
                  value={feishuConfig.secret}
                  onChange={e => setFeishuConfig(prev => ({ ...prev, secret: e.target.value }))}
                  placeholder="未开启签名校验可留空"
                />
              </div>
            </div>

            <div className="feishu-switches">
              <label>
                <input
                  type="checkbox"
                  checked={feishuConfig.enabled}
                  onChange={e => setFeishuConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                />
                启用飞书 Webhook 实时推送
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={feishuConfig.notifyOnPriceDrop}
                  onChange={e => setFeishuConfig(prev => ({ ...prev, notifyOnPriceDrop: e.target.checked }))}
                />
                商品降价 / 优惠券 & 国补变动推送（含原价 vs 现价、降幅与史低对比）
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={feishuConfig.notifyOnDelist}
                  onChange={e => setFeishuConfig(prev => ({ ...prev, notifyOnDelist: e.target.checked }))}
                />
                商品下架 / 无货提醒
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={feishuConfig.notifyOnSessionExpire}
                  onChange={e => setFeishuConfig(prev => ({ ...prev, notifyOnSessionExpire: e.target.checked }))}
                />
                平台登录态失效提醒
              </label>
            </div>

            <div className="session-actions">
              <button type="submit" disabled={feishuBusy}>
                保存飞书配置
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={feishuBusy || !feishuConfig.webhookUrl}
                onClick={testFeishuPush}
              >
                发送飞书测试卡片
              </button>
              {selectedProduct && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={feishuBusy || !feishuConfig.webhookUrl}
                  onClick={() => simulateDropAndPush(selectedProduct)}
                >
                  推送当前商品降价卡片到飞书
                </button>
              )}
            </div>

            {(feishuMessage || feishuConfig.lastPushMessage) && (
              <p className="integration-note" role="status">
                {feishuMessage ||
                  `最近推送（${
                    feishuConfig.lastPushAt ? new Date(feishuConfig.lastPushAt).toLocaleString('zh-CN') : ''
                  }）：${feishuConfig.lastPushMessage}`}
              </p>
            )}
          </form>
        </section>

        <div className="footnote">
          <span>01 / 持续关注</span>
          <span>为每一次心动，等一个好价格。</span>
        </div>
      </main>
      <footer>
        <span>© Price Drop</span>
        <span>用心观察，理性购买。</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
