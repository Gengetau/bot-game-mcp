/**
 * 管理页改的设置（目前只有剧本杀的默认剧本）。存一个小 JSON 文件，和对局存档分开；file 为 null 时只放内存。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SettingsData {
  /** 剧本杀开房没写 script 时用的剧本 id */
  jubenshaDefaultScript?: string;
}

export class Settings {
  private data: SettingsData = {};

  constructor(
    private readonly file: string | null,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        if (raw && typeof raw === 'object') {
          const s = (raw as Record<string, unknown>).jubenshaDefaultScript;
          if (typeof s === 'string' && s.trim()) this.data.jubenshaDefaultScript = s.trim().slice(0, 32);
        }
      } catch (e) {
        log(`[settings] 读取 ${file} 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  get jubenshaDefaultScript(): string | undefined {
    return this.data.jubenshaDefaultScript;
  }

  setJubenshaDefaultScript(id: string | null): void {
    if (id) this.data.jubenshaDefaultScript = id;
    else delete this.data.jubenshaDefaultScript;
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
