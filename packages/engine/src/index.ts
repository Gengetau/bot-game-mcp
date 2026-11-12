/**
 * 库入口：可以把引擎嵌入到你自己的 Node 程序里（例如在已有的 QQ bot 进程中直接启动 MCP 服务）。
 */
export * from './core/types.js';
export { GameError } from './core/errors.js';
export { BaseGame, type GameEnv, type OpenPhaseSpec } from './core/game.js';
export { GameManager, type ManagerOptions, type CreateGameInput } from './core/manager.js';
export { GameRegistry, type GameDefinition } from './core/registry.js';
export { GameRunner, type EmbeddedSeatView } from './core/runner.js';
export { CryptoRng, SeededRng, type Rng } from './core/rng.js';
export { FileStateStore, MemoryStateStore, type StateStore, type PersistedState } from './core/store.js';
export { createRegistry } from './games/index.js';
export { createMcpServer, SERVER_INSTRUCTIONS, type ServerDeps } from './mcp/server.js';
export { Authenticator, extractKey, type SessionContext } from './mcp/auth.js';
export { renderDelivery, toCq, toOneBot, type DeliveryFormat } from './mcp/render.js';
export { loadConfig, configSchema, type BotGameConfig } from './config.js';
export { createRuntime, type Runtime } from './server/runtime.js';
export { startHttpServer, type HttpHandle } from './server/http.js';
export { startStdioServer } from './server/stdio.js';
export { startBridge, type BridgeOptions } from './server/bridge.js';
export { simulate, type SimulateOptions } from './sim/simulate.js';
export { VERSION } from './version.js';
// 持续世界「栖灯镇」
export {
  createWorld,
  enterWorld,
  enterWorldAgent,
  WorldService,
  WorldError,
  agentPrincipal,
  issueTicket,
  exchangeTicket,
  sessionPrincipal,
  heartbeat as townHeartbeat,
  leaveWorld,
  claimControl,
  publicView as townPublicView,
  meView as townMeView,
  agentView as townAgentView,
  townParamsSchema,
  verifyBackup as verifyTownBackup,
  type WorldOptions,
  type TownParams,
  type MeView as TownMeView,
  type PublicView as TownPublicView,
} from './world/index.js';
export { mountTown } from './world/http.js';
export { TOWN_GUIDE } from './mcp/town.js';
