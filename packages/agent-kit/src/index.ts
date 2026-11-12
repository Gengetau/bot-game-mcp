/**
 * bot-game-mcp 接入端：给 AI 玩家（或代码写的玩家）用的最小客户端。
 *
 * 引擎本身就是一个 MCP 服务器，任何 MCP 客户端都能直接连；这里只是把常用的几个工具包成方法，
 * 加上「等到轮到我」的辅助函数和给聊天 bot 用的提示词，省得每个接入方都重写一遍。
 * 栖灯镇（持续世界）的客户端 TownClient 和 AI 居民运行器 ResidentRunner 见 town.ts / resident.ts。
 */
export * from './client.js';
export * from './town.js';
export * from './resident.js';
export * from './prompts.js';
