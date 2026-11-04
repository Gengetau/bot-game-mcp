import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GameRecord } from './types.js';

/** 开放登录模式下的身份认领记录（只存 secret 的哈希）。 */
export interface ClaimRecord {
  id: string;
  name: string;
  secretHash: string;
  claimedAt: number;
}

export interface PersistedState {
  version: 1;
  savedAt: number;
  games: GameRecord[];
  claims: ClaimRecord[];
}

export interface StateStore {
  load(): PersistedState | null;
  /** 请求保存（可防抖）。getState 在真正写入时才调用。 */
  schedule(getState: () => PersistedState): void;
  /** 立即写入挂起的保存。 */
  flush(): void;
}

export class MemoryStateStore implements StateStore {
  last: PersistedState | null = null;
  private pending: (() => PersistedState) | null = null;

  load(): PersistedState | null {
    return this.last ? (JSON.parse(JSON.stringify(this.last)) as PersistedState) : null;
  }

  schedule(getState: () => PersistedState): void {
    this.pending = getState;
  }

  flush(): void {
    if (this.pending) {
      this.last = JSON.parse(JSON.stringify(this.pending())) as PersistedState;
      this.pending = null;
    }
  }
}

/** JSON 文件存档：防抖 + 先写临时文件再原子重命名。 */
export class FileStateStore implements StateStore {
  private timer: NodeJS.Timeout | null = null;
  private pending: (() => PersistedState) | null = null;

  constructor(
    private readonly file: string,
    private readonly debounceMs = 250,
  ) {}

  load(): PersistedState | null {
    if (!existsSync(this.file)) return null;
    const raw = readFileSync(this.file, 'utf8');
    if (!raw.trim()) return null;
    const data = JSON.parse(raw) as PersistedState;
    if (data.version !== 1) throw new Error(`不支持的存档版本：${String((data as any).version)}`);
    return data;
  }

  schedule(getState: () => PersistedState): void {
    this.pending = getState;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const state = this.pending();
    this.pending = null;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, this.file);
  }
}
