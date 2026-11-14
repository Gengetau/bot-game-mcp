/**
 * 运行时装配：配置 → GameManager（含存档、计时器）→ Authenticator。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BotGameConfig } from '../config.js';
import { resolveAuth } from '../config.js';
import { GameManager } from '../core/manager.js';
import { CryptoRng, SeededRng } from '../core/rng.js';
import { FileStateStore } from '../core/store.js';
import { Settings } from '../core/settings.js';
import { createRegistry } from '../games/index.js';
import { driveAssets, localAssets, type AssetStore, type ServiceAccount } from '../core/assets.js';
import { directoryLibrary, type ScriptLibrary } from '../games/jubensha/index.js';
import { Authenticator } from '../mcp/auth.js';
import { VERSION } from '../version.js';
import { createWorld, type WorldService } from '../world/index.js';
import { stderrLog } from './log.js';

export interface Runtime {
  config: BotGameConfig;
  manager: GameManager;
  auth: Authenticator;
  /** 管理页改的设置 */
  settings: Settings;
  /** 剧本杀的剧本库（没配 scriptsDir 时为空） */
  scripts?: ScriptLibrary;
  /** 持续世界「栖灯镇」（配置里 town.enabled 才有） */
  world?: WorldService;
  version: string;
  startedAt: number;
  /** 停止计时器并写盘 */
  close(): void;
}

export function createRuntime(config: BotGameConfig, log: (msg: string) => void = stderrLog): Runtime {
  const store = config.stateFile ? new FileStateStore(config.stateFile) : undefined;
  if (config.seed) log('⚠️  已设置固定随机种子 seed：身份分配可被复现，只应用于测试！');
  const scripts = config.scriptsDir ? directoryLibrary(config.scriptsDir) : undefined;
  if (scripts) {
    log(`剧本库：${scripts.list().length} 个剧本`);
    for (const [file, err] of Object.entries(scripts.errors())) log(`⚠️  剧本 ${file} 加载失败：${err}`);
  }
  const assets = createAssets(config, log);
  const settingsFile =
    config.settingsFile !== undefined ? config.settingsFile : config.stateFile ? join(dirname(config.stateFile), 'botgame-settings.json') : null;
  const settings = new Settings(settingsFile, log);
  const manager = new GameManager({
    registry: createRegistry({
      ...(scripts ? { scripts } : {}),
      ...(assets ? { assets } : {}),
      defaultScript: () => settings.jubenshaDefaultScript,
    }),
    ...(assets ? { assets } : {}),
    rng: config.seed ? new SeededRng(config.seed) : new CryptoRng(),
    store,
    refereeStaleMs: config.refereeStaleSeconds * 1000,
    lobbyTtlMs: config.lobbyTtlMinutes * 60_000,
    idleGameTtlMs: config.idleGameTtlMinutes * 60_000,
    allowedGroups: config.allowedGroups,
    maxActiveGames: config.maxActiveGames,
    refereeIds: config.refereeIds,
    defaultOptions: config.defaultOptions,
    ...(config.webUrl ? { webUrl: config.webUrl } : {}),
  });
  const world = config.town.enabled
    ? createWorld({
        dbPath: config.town.dbFile,
        registry: manager.registry,
        params: config.town.params,
        publicUrl: config.town.publicUrl,
        devLogin: config.town.devLogin,
        log,
        ...(config.seed ? { seed: config.seed } : {}),
      })
    : undefined;
  if (world) {
    if (config.town.allowedAgents) log(`栖灯镇准入名单已启用：${config.town.allowedAgents.length} 个身份可以经 MCP 进镇`);
    if (config.town.adminOnlyTickets) log('栖灯镇的真人登录票据只有管理员能签');
    if (config.town.devLogin) log('⚠️  栖灯镇开了本机试玩登录（town.devLogin）：任何人输入名字就能进入，只应用于本机或可信内网！');
    // 启动恢复：按停机前的检查点追赶到期事务；完成前小镇的写接口返回 recovering
    void world.start().then(
      () => log(`栖灯镇已就绪：${config.town.dbFile}`),
      (e) => log(`[town] 启动恢复失败：${e instanceof Error ? e.stack : String(e)}`),
    );
  }
  const auth = new Authenticator(resolveAuth(config), manager, log);
  manager.isKeyedAgent = (id) => auth.hasKeyFor(id);
  const timer = setInterval(() => {
    try {
      manager.tick();
    } catch (e) {
      log(`[tick] ${e instanceof Error ? e.stack : String(e)}`);
    }
    // 小镇的调度和桌游的计时各走各的：一边出错不影响另一边
    world?.tick();
  }, 1000);
  timer.unref();
  // 清理已结束对局的云盘图片副本
  const sweeper = assets
    ? setInterval(() => {
        try {
          assets.sweep(manager.activeGameIds());
        } catch (e) {
          log(`[assets] ${e instanceof Error ? e.message : String(e)}`);
        }
      }, 60_000)
    : null;
  sweeper?.unref();
  return {
    config,
    manager,
    auth,
    settings,
    ...(scripts ? { scripts } : {}),
    ...(world ? { world } : {}),
    version: VERSION,
    startedAt: Date.now(),
    close() {
      clearInterval(timer);
      if (sweeper) clearInterval(sweeper);
      manager.flush();
      world?.close();
    },
  };
}

/** 按配置创建图片素材库（云盘优先，其次本地目录）；都没配返回 undefined。 */
export function createAssets(config: BotGameConfig, log: (msg: string) => void): AssetStore | undefined {
  if (config.drive) {
    let credentials: ServiceAccount;
    try {
      const raw = JSON.parse(readFileSync(config.drive.credentialsFile, 'utf8'));
      if (typeof raw.client_email !== 'string' || typeof raw.private_key !== 'string') throw new Error('缺少 client_email 或 private_key');
      credentials = { client_email: raw.client_email, private_key: raw.private_key };
    } catch (e) {
      // 只报原因，绝不打印密钥内容
      throw new Error(`云盘服务账号密钥读取失败（${config.drive.credentialsFile}）：${e instanceof Error ? e.message.slice(0, 80) : 'unknown'}`);
    }
    log(`剧本图片：Google 云盘（服务账号 ${credentials.client_email}），缓存目录 ${config.assetCacheDir}`);
    return driveAssets({ folderId: config.drive.folderId, credentials, cacheDir: config.assetCacheDir, log: (m) => log(`[assets] ${m}`) });
  }
  if (config.assetsDir) {
    log(`剧本图片：本地目录 ${config.assetsDir}`);
    return localAssets(config.assetsDir);
  }
  return undefined;
}
