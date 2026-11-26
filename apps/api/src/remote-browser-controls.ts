import { BadRequestException } from '@nestjs/common';
import type { CDPSession, Page } from 'playwright';

export type RemotePointerInput = { id?: string; type?: 'down' | 'move' | 'up' | 'cancel'; x?: number; y?: number };

interface RemotePointer {
  id: string;
  page: Page;
  timeout?: NodeJS.Timeout;
  capture?: Promise<string>;
  action?: Promise<void>;
  release?: Promise<void>;
}

export class RemoteBrowserControls<Key> {
  private readonly remotePointers = new Map<Key, RemotePointer>();
  private readonly screenshotSessions = new WeakMap<Page, Promise<CDPSession>>();

  isDragging(key: Key, page: Page): boolean {
    return this.remotePointers.get(key)?.page === page;
  }

  async clear(key?: Key): Promise<void> {
    if (key !== undefined) {
      const pointer = this.remotePointers.get(key);
      if (pointer) await this.releaseRemotePointer(key, pointer).catch(() => {});
      return;
    }
    await Promise.all(Array.from(this.remotePointers.keys(), current => this.clear(current)));
  }

  async screenshot(key: Key, page: Page): Promise<string> {
    const pointer = this.remotePointers.get(key);
    if (pointer?.page === page) return this.captureDragFrame(pointer);
    const image = await page.screenshot({ type: 'jpeg', quality: 78, timeout: 6500 }).catch(() => null);
    return image ? `data:image/jpeg;base64,${image.toString('base64')}` : '';
  }

  private captureDragFrame(pointer: RemotePointer): Promise<string> {
    if (pointer.capture) return pointer.capture;

    const page = pointer.page;
    let session = this.screenshotSessions.get(page);
    if (!session) {
      session = page.context().newCDPSession(page);
      this.screenshotSessions.set(page, session);
    }
    pointer.capture = session
      .then(async client => {
        const { data } = await client.send('Page.captureScreenshot', {
          format: 'jpeg', quality: 55, optimizeForSpeed: true,
        });
        return `data:image/jpeg;base64,${data}`;
      })
      .catch(async () => {
        const image = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 2000 }).catch(() => null);
        return image ? `data:image/jpeg;base64,${image.toString('base64')}` : '';
      })
      .finally(() => {
        pointer.capture = undefined;
      });
    return pointer.capture;
  }

  private async releaseRemotePointer(key: Key, pointer: RemotePointer) {
    clearTimeout(pointer.timeout);
    if (this.remotePointers.get(key) !== pointer) return;
    pointer.release ??= (async () => {
      await pointer.action?.catch(() => {});
      await pointer.page.mouse.up();
    })().finally(() => {
      if (this.remotePointers.get(key) === pointer) this.remotePointers.delete(key);
    });
    await pointer.release;
  }

  async update(key: Key, getPage: () => Page, body: RemotePointerInput) {
    const id = body?.id;
    const type = body?.type;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
        !type || !['down', 'move', 'up', 'cancel'].includes(type)) {
      throw new BadRequestException('鼠标操作无效');
    }
    const current = this.remotePointers.get(key);
    if (type === 'cancel') {
      if (current?.id === id) await this.releaseRemotePointer(key, current);
      return { ok: true };
    }

    const { x, y } = body;
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      throw new BadRequestException('鼠标坐标无效');
    }

    const page = getPage();
    let pointer: RemotePointer;
    if (type === 'down') {
      if (current && current.page === page) {
        throw new BadRequestException('上一次鼠标操作尚未结束');
      }
      if (current) clearTimeout(current.timeout);
      pointer = { id, page };
      this.remotePointers.set(key, pointer);
    } else {
      if (!current || current.id !== id || current.page !== page || current.release) {
        throw new BadRequestException('鼠标操作已结束，请重新按下');
      }
      pointer = current;
    }

    clearTimeout(pointer.timeout);
    pointer.timeout = setTimeout(() => {
      void this.releaseRemotePointer(key, pointer).catch(() => {});
    }, 10000);
    pointer.timeout.unref();

    try {
      const width = page.viewportSize()?.width ?? 1280;
      const height = page.viewportSize()?.height ?? 800;
      pointer.action = (pointer.action ?? Promise.resolve()).then(async () => {
        await page.mouse.move(Math.max(0, Math.min(width - 1, x)), Math.max(0, Math.min(height - 1, y)));
        if (type === 'down') await page.mouse.down();
      });
      await pointer.action;
      if (type === 'up') await this.releaseRemotePointer(key, pointer);
    } catch (error) {
      await this.releaseRemotePointer(key, pointer).catch(() => {});
      throw error;
    }
    return { ok: true };
  }

}
