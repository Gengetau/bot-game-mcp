# bot-game-mcp（引擎）

QQ 群聊桌游引擎，一个标准的 MCP 服务器：狼人杀、谁是卧底、大话骰、数字炸弹。身份、流程、结算、胜负全部由程序决定，AI 裁判只负责推进与私聊发牌。

这是工作区里的引擎包。完整说明、规则、接口参考和接入文档见仓库根目录的 [README](../../README.md) 与 [docs/](../../docs/)。

```bash
npm i bot-game-mcp
bot-game-mcp init-config     # 生成 botgame.config.json（密钥随机生成）
bot-game-mcp serve           # 启动 Streamable HTTP（默认 127.0.0.1:7700/mcp）
bot-game-mcp simulate werewolf --players 9 --humans 2 --seed 1   # 离线跑一局
```

作为库使用：

```ts
import { createRuntime, loadConfig, startHttpServer } from 'bot-game-mcp';

const rt = createRuntime(loadConfig('botgame.config.json'));
const handle = await startHttpServer(rt);
console.log(handle.url);
```

配套的包：代码裁判 [`bot-game-mcp-referee-onebot`](../referee-onebot)、接入端 [`bot-game-mcp-agent-kit`](../agent-kit)。
