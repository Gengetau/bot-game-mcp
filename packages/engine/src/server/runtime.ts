/**
 * 运行时装配：配置 → GameManager（含存档、计时器）→ Authenticator。
 */
import type { BotGameConfig } from '../config.js';
import { resolveAuth } from '../config.js';
import { GameManager } from '../core/manager.js';
import { CryptoRng, SeededRng } from '../core/rng.js';
import { FileStateStore } from '../core/store.js';
import { createRegistry } from '../games/index.js';
import { Authenticator } from '../mcp/auth.js';
import { VERSION } from '../version.js';

export interface Runtime {
  config: BotGameConfig;
  manager: GameManager;
  auth: Authenticator;
  version: string;
  /** 停止计时器并写盘 */
  close(): void;
}

export function createRuntime(config: BotGameConfig, log: (msg: string) => void = (m) => process.stderr.write(`${m}\n`)): Runtime {
  const store = config.stateFile ? new FileStateStore(config.stateFile) : undefined;
  if (config.seed) log('⚠️  已设置固定随机种子 seed：身份分配可被复现，只应用于测试！');
  const manager = new GameManager({
    registry: createRegistry(),
    rng: config.seed ? new SeededRng(config.seed) : new CryptoRng(),
    store,
    refereeStaleMs: config.refereeStaleSeconds * 1000,
    lobbyTtlMs: config.lobbyTtlMinutes * 60_000,
    idleGameTtlMs: config.idleGameTtlMinutes * 60_000,
  });
  const auth = new Authenticator(resolveAuth(config), manager);
  const timer = setInterval(() => {
    try {
      manager.tick();
    } catch (e) {
      log(`[tick] ${e instanceof Error ? e.stack : String(e)}`);
    }
  }, 1000);
  timer.unref();
  return {
    config,
    manager,
    auth,
    version: VERSION,
    close() {
      clearInterval(timer);
      manager.flush();
    },
  };
}
