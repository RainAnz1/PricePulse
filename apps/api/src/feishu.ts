import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Req } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Request } from 'express';

export interface FeishuWebhookConfig {
  webhookUrl: string;
  secret: string;
  enabled: boolean;
  notifyOnPriceDrop: boolean;
  notifyOnDelist: boolean;
  notifyOnSessionExpire: boolean;
  updatedAt: string;
  lastPushAt?: string;
  lastPushStatus?: 'success' | 'error';
  lastPushMessage?: string;
}

export interface PriceDropAlertPayload {
  platform: 'jd' | 'taobao';
  productId: string;
  title: string;
  shopName: string;
  url: string;
  previousPrice: number;
  currentFinalPrice: number;
  pagePrice: number;
  couponPrice: number | null;
  subsidyPrice: number | null;
  coupons: string[];
  hasSubsidy: boolean;
  subsidyLabel: string | null;
  allTimeLow: number;
  isNewAllTimeLow: boolean;
}

function getDataRoot(): string {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { workspaces?: unknown };
        if (pkg.workspaces) {
          return join(dir, '.local-data');
        }
      } catch {
        // ignore
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), '.local-data');
}

function getFeishuConfigPath(): string {
  return join(getDataRoot(), 'PriceDrop', 'data', 'feishu.json');
}

function validateOrigin(req: Request) {
  const origin = req.get('origin');
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ForbiddenException('非法的请求来源协议');
    }
  } catch {
    throw new ForbiddenException('非法的请求来源');
  }
}

export function loadFeishuConfig(): FeishuWebhookConfig {
  const filePath = getFeishuConfigPath();
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<FeishuWebhookConfig>;
      return {
        webhookUrl: parsed.webhookUrl || '',
        secret: parsed.secret || '',
        enabled: parsed.enabled ?? Boolean(parsed.webhookUrl),
        notifyOnPriceDrop: parsed.notifyOnPriceDrop ?? true,
        notifyOnDelist: parsed.notifyOnDelist ?? true,
        notifyOnSessionExpire: parsed.notifyOnSessionExpire ?? true,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
        lastPushAt: parsed.lastPushAt,
        lastPushStatus: parsed.lastPushStatus,
        lastPushMessage: parsed.lastPushMessage,
      };
    } catch {
      // ignore corrupted file
    }
  }
  return {
    webhookUrl: '',
    secret: '',
    enabled: false,
    notifyOnPriceDrop: true,
    notifyOnDelist: true,
    notifyOnSessionExpire: true,
    updatedAt: new Date().toISOString(),
  };
}

export function saveFeishuConfig(config: FeishuWebhookConfig): FeishuWebhookConfig {
  const filePath = getFeishuConfigPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

function buildFeishuSign(secret: string): { timestamp: string; sign: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = createHmac('sha256', stringToSign).update('').digest('base64');
  return { timestamp, sign };
}

export async function sendFeishuCard(card: Record<string, unknown>, force = false): Promise<{
  ok: boolean;
  message: string;
}> {
  const config = loadFeishuConfig();
  if (!config.webhookUrl) {
    return { ok: false, message: '尚未配置飞书 Webhook 地址' };
  }
  if (!config.enabled && !force) {
    return { ok: false, message: '飞书推送当前处于关闭状态' };
  }

  const body: Record<string, unknown> = {
    msg_type: 'interactive',
    card,
  };

  if (config.secret.trim()) {
    const { timestamp, sign } = buildFeishuSign(config.secret.trim());
    body.timestamp = timestamp;
    body.sign = sign;
  }

  try {
    const res = await fetch(config.webhookUrl, {
      signal: AbortSignal.timeout(6000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { code?: number; msg?: string; StatusCode?: number; StatusMessage?: string };
    const code = json.code ?? json.StatusCode ?? (res.ok ? 0 : -1);
    const ok = res.ok && code === 0;
    const message = ok ? '飞书卡片推送成功' : `飞书返回错误: ${json.msg || json.StatusMessage || res.statusText}`;

    saveFeishuConfig({
      ...config,
      lastPushAt: new Date().toISOString(),
      lastPushStatus: ok ? 'success' : 'error',
      lastPushMessage: message,
    });

    return { ok, message };
  } catch (err) {
    const message = `飞书推送网络异常: ${err instanceof Error ? err.message : '未知错误'}`;
    saveFeishuConfig({
      ...config,
      lastPushAt: new Date().toISOString(),
      lastPushStatus: 'error',
      lastPushMessage: message,
    });
    return { ok: false, message };
  }
}

export async function notifyPriceDropToFeishu(payload: PriceDropAlertPayload, force = false) {
  const config = loadFeishuConfig();
  if (!force && (!config.enabled || !config.notifyOnPriceDrop || !config.webhookUrl)) {
    return { ok: false, message: '未开启降价推送或未配置 Webhook' };
  }

  const dropAmount = Math.max(0, Number((payload.previousPrice - payload.currentFinalPrice).toFixed(2)));
  const dropPercent =
    payload.previousPrice > 0
      ? ((dropAmount / payload.previousPrice) * 100).toFixed(1)
      : '0.0';
  const platformName = payload.platform === 'jd' ? '京东' : '淘宝 / 天猫';
  const couponSummary = payload.coupons.length > 0 ? payload.coupons.join('、') : '暂无可用优惠券';
  const subsidySummary = payload.hasSubsidy
    ? `支持国补 (${payload.subsidyLabel || '政府补贴'}) · 国补后 ¥${payload.subsidyPrice?.toFixed(2) ?? payload.currentFinalPrice.toFixed(2)}`
    : '暂未检测到国补标识';
  const lowCompare = payload.isNewAllTimeLow
    ? `🔥 已创监控以来新史低（¥${payload.allTimeLow.toFixed(2)}）`
    : `历史最低价：¥${payload.allTimeLow.toFixed(2)}（距史低还差 ¥${Math.max(0, payload.currentFinalPrice - payload.allTimeLow).toFixed(2)}）`;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: payload.isNewAllTimeLow ? 'red' : 'green',
      title: {
        tag: 'plain_text',
        content: `📉 【${platformName}降价提醒】${payload.title.slice(0, 40)}`,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**商品名称**：${payload.title}`,
            `**所属店铺**：${payload.shopName || platformName}`,
            `**降价前价格**：~~¥${payload.previousPrice.toFixed(2)}~~`,
            `**当前最优到手价**：**¥${payload.currentFinalPrice.toFixed(2)}** （直降 **¥${dropAmount.toFixed(2)}** / **-${dropPercent}%**）`,
            `**价格拆解**：页面标价 ¥${payload.pagePrice.toFixed(2)}${
              payload.couponPrice !== null ? ` ｜ 券后价 ¥${payload.couponPrice.toFixed(2)}` : ''
            }${payload.subsidyPrice !== null ? ` ｜ 国补价 ¥${payload.subsidyPrice.toFixed(2)}` : ''}`,
            `**优惠券信息**：${couponSummary}`,
            `**国家补贴（国补）**：${subsidySummary}`,
            `**史低价对比**：${lowCompare}`,
          ].join('\n'),
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `前往${platformName}查看商品` },
            type: 'primary',
            url: payload.url,
          },
        ],
      },
    ],
  };

  return sendFeishuCard(card, force);
}

export async function notifyDelistToFeishu(params: {
  platform: 'jd' | 'taobao';
  title: string;
  url: string;
  lastPrice: number;
  reason: string;
}) {
  const config = loadFeishuConfig();
  if (!config.enabled || !config.notifyOnDelist || !config.webhookUrl) {
    return { ok: false, message: '未开启下架提醒' };
  }
  const platformName = params.platform === 'jd' ? '京东' : '淘宝 / 天猫';
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `⚠️ 【商品下架/无货提醒】${params.title.slice(0, 36)}` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**监控平台**：${platformName}`,
            `**商品名称**：${params.title}`,
            `**当前状态**：${params.reason}`,
            `**最后有效价格**：¥${params.lastPrice.toFixed(2)}`,
          ].join('\n'),
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看原商品页面' },
            type: 'default',
            url: params.url,
          },
        ],
      },
    ],
  };
  return sendFeishuCard(card);
}

export async function notifySessionExpiredToFeishu(platform: 'jd' | 'taobao', detail?: string) {
  const config = loadFeishuConfig();
  if (!config.enabled || !config.notifyOnSessionExpire || !config.webhookUrl) {
    return { ok: false, message: '未开启登录态失效提醒' };
  }
  const platformName = platform === 'jd' ? '京东' : '淘宝 / 天猫';
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'wathet',
      title: { tag: 'plain_text', content: `🔐 【登录态失效告警】${platformName}会话需重新扫码` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**告警平台**：${platformName}`,
            `**告警原因**：${detail || '检测到登录 Cookie 已过期或触发登录拦截，可能影响券后价与国补价格抓取'}`,
            `**处理建议**：请打开 PricePulse 的平台账号页面，重新登录并完成平台验证。`,
          ].join('\n'),
        },
      },
    ],
  };
  return sendFeishuCard(card);
}

@Controller('feishu')
export class FeishuController {
  @Get('config')
  getConfig() {
    const cfg = loadFeishuConfig();
    return {
      ...cfg,
      hasSecret: Boolean(cfg.secret),
    };
  }

  @Post('config')
  updateConfig(
    @Body()
    body: {
      webhookUrl?: string;
      secret?: string;
      enabled?: boolean;
      notifyOnPriceDrop?: boolean;
      notifyOnDelist?: boolean;
      notifyOnSessionExpire?: boolean;
    },
    @Req() req: Request,
  ) {
    validateOrigin(req);
    const current = loadFeishuConfig();
    const webhookUrl = (body.webhookUrl ?? current.webhookUrl).trim();
    if (webhookUrl && !/^https:\/\/open\.(feishu|larksuite)\.(cn|com)\/open-apis\/bot\/v2\/hook\//.test(webhookUrl)) {
      throw new BadRequestException('请输入有效的飞书自定义机器人 Webhook 地址（https://open.feishu.cn/open-apis/bot/v2/hook/...）');
    }
    const saved = saveFeishuConfig({
      webhookUrl,
      secret: body.secret !== undefined ? body.secret.trim() : current.secret,
      enabled: body.enabled ?? Boolean(webhookUrl),
      notifyOnPriceDrop: body.notifyOnPriceDrop ?? current.notifyOnPriceDrop,
      notifyOnDelist: body.notifyOnDelist ?? current.notifyOnDelist,
      notifyOnSessionExpire: body.notifyOnSessionExpire ?? current.notifyOnSessionExpire,
      updatedAt: new Date().toISOString(),
      lastPushAt: current.lastPushAt,
      lastPushStatus: current.lastPushStatus,
      lastPushMessage: current.lastPushMessage,
    });
    return {
      ...saved,
      message: webhookUrl ? '飞书 Webhook 配置已保存' : '飞书 Webhook 配置已清空',
    };
  }

  @Post('test')
  async sendTest(@Req() req: Request) {
    validateOrigin(req);
    const cfg = loadFeishuConfig();
    if (!cfg.webhookUrl) {
      throw new BadRequestException('请先填写并保存飞书机器人 Webhook 地址');
    }
    const card = {
      config: { wide_screen_mode: true },
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '✅ Price Drop 飞书 Webhook 连通性测试成功' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: [
              '**连接状态**：已成功接入 Price Drop 价格观察室',
              `**已启用通知项**：${[
                cfg.notifyOnPriceDrop ? '商品降价/国补/神券提醒' : '',
                cfg.notifyOnDelist ? '商品下架/无货提醒' : '',
                cfg.notifyOnSessionExpire ? '平台登录态失效告警' : '',
              ]
                .filter(Boolean)
                .join('、') || '无'}`,
              `**测试时间**：${new Date().toLocaleString('zh-CN')}`,
            ].join('\n'),
          },
        },
      ],
    };
    const result = await sendFeishuCard(card, true);
    if (!result.ok) {
      throw new BadRequestException(result.message);
    }
    return result;
  }
}
