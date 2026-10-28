# onxbot

TypeScript monorepo 对话机器人。QQ 通过 OneBot v11 接入，Koishi 以依赖方式嵌入进程，负责消息接入、指令分发和插件生命周期。对话核心、模型调用和 PostgreSQL 存储独立于 Koishi。

## 技术栈

- Node.js 24+、pnpm 10 workspace、TypeScript 6、ESM。
- Koishi 4 + `koishi-plugin-adapter-onebot`，正向 WebSocket；按需加载 HTTP/WebSocket **客户端**服务。
- PostgreSQL 18 + `pg` 连接池 + Kysely 类型安全 SQL 与迁移。
- `ts-pattern` 做请求、模型配置和执行结果的穷尽匹配，`lodash-es` 选择完整历史回合，Zod 校验配置、模型响应与工具参数。
- Vitest 测试、Biome 格式化与检查、TypeScript project references 增量构建。

## 目录与依赖

```text
apps/bot                     读取配置、组装依赖、连接 OneBot、进程退出
packages/model               模型消息与工具协议、echo / OpenAI 兼容 provider
packages/core                ChatService 应用入口
packages/core/src/conversation  会话读写顺序、完整回合提交、存储接口
packages/core/src/context     人格、历史、上下文来源与预算
packages/core/src/turn        模型与工具执行循环、参数校验
packages/database            Kysely schema、迁移、PostgreSQL 会话存储
packages/koishi-plugin-chat   将 Koishi 指令映射为对话请求
tests                        模型协议、配置、真实 PG 和 OneBot 协议集成测试
```

调用链：`QQ → OneBot → Koishi 插件 → ChatService → ConversationService → ContextBuilder → TurnRunner → ModelProvider / 工具`；成功回合经 `ConversationStore` 写入 PostgreSQL。

`model` 独立于 `core`；`core` 不导入 Koishi、Kysely 或 pg。`database` 实现 `@onxbot/core/conversation` 的存储接口，并使用统一模型消息类型。完整职责、数据流与扩展方式见 [AI 对话系统模块设计](docs/architecture.md)。

## 本地启动

需要 Node.js 24+、pnpm 10，以及 Docker Compose 或已有 PostgreSQL **18** 实例。

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm db:migrate
```

`db:up` 用 Compose 启动 PostgreSQL 18；使用现有数据库时，修改 `.env` 的 `DATABASE_URL`，跳过这一步。迁移使用 PG 18 原生的 `uuidv7()`，不支持更早的 PostgreSQL。PG 18 镜像的数据卷挂载在 `/var/lib/postgresql`，遵循[官方镜像说明](https://hub.docker.com/_/postgres)。

### 配置 QQ / OneBot

本项目连接已有的 OneBot v11 实现（例如 NapCat），QQ 登录由该实现负责。

1. 在 OneBot 实现中开启**正向 WebSocket 服务端**，例如 `ws://127.0.0.1:3001`。
2. 设置非空 `access_token`，与 `.env` 的 `ONEBOT_TOKEN` 保持一致。
3. 将 `.env` 的 `ONEBOT_SELF_ID` 改为机器人 QQ 号，`ONEBOT_ENDPOINT` 改为实际地址。
4. 启动应用：

```bash
pnpm dev
```

在私聊或群聊中发送：

```text
/chat 你好
/chat 你记得上一条消息吗？
/reset
```

只响应显式指令。`/chat` 后的正文按普通文本处理，保留 `$(...)`、开头的横线、引号和换行。群内不同用户各有自己的上下文；身份由平台、机器人账号、频道和用户共同确定。`/reset` 只清空当前身份的历史。

默认 `CHAT_PROVIDER=echo`，回复 `收到：…`，用于验证整个接入链路。启用真实模型时修改 `.env`：

```dotenv
CHAT_PROVIDER=openai
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=你的密钥
OPENAI_MODEL=你的模型名称
```

支持 OpenAI 兼容的 `/chat/completions` 接口，采用非流式回复；模型包支持文本与 function tool calls。当前应用默认不注册工具，增加工具时在应用装配处注入 `TurnRunner`，示例见设计文档。`OPENAI_BASE_URL` 应包含 API 前缀，例如 `/v1`。消息作为普通文本发送，模型生成的 Koishi 元素标签不会被当作 @、图片等指令执行。

### 构建与运行

```bash
pnpm build
pnpm start
```

在仓库根目录执行。`dev` 通过 `development` 导出条件直接加载各 workspace 的 TypeScript 源码，修改共享包也会触发重启；`start` 使用编译后的 JavaScript。迁移单独执行，应用启动时检查业务表是否已存在。

## 检查与测试

```bash
pnpm check
pnpm typecheck
pnpm test
```

数据库集成测试要求显式提供 `TEST_DATABASE_URL`，不会默认连接开发库。测试使用随机独立 schema，结束后删除该 schema：

```bash
TEST_DATABASE_URL=postgresql://onxbot:onxbot_dev@127.0.0.1:5432/onxbot pnpm test:integration
```

集成测试覆盖真实 PostgreSQL 的迁移、上下文恢复、身份隔离、清空、失败回滚和并发请求，以及本地模拟 OneBot v11 服务的完整收发。没有测试真实 QQ 登录或调用付费模型。CI 提供 PostgreSQL 18 服务并运行这些检查。

## 存储行为

每次成功对话原子写入用户消息和本轮全部 assistant / tool 消息，包括工具调用与对应结果。调用模型或工具失败时回滚，不留下半个回合。同一会话通过 PostgreSQL 行锁串行处理，多进程也共享这一约束；不同会话可并发。数据库回滚不会撤销外部工具已经产生的效果，执行器不自动重试工具。

当前实现会在整个回合期间持有事务及连接，连接池上限为 10。这适合初始规模，吞吐量增加后可替换 `ConversationStore` 实现。`CHAT_HISTORY_TURNS` 限制完整历史回合数；一个回合可以包含多条工具消息。`ContextBuilder` 提供可选 token 预算接口，默认应用尚未配置计数器。摘要与长期记忆可通过上下文来源接入，当前尚未内置生成与检索。历史记录持续保存在数据库，直到 `/reset` 删除。`CHAT_MAX_INPUT_CHARS` 限制单条输入长度，`CHAT_TIMEOUT_MS` 限制每次模型请求时间；`TurnRunner` 默认最多请求模型 8 次。

升级已有数据库时执行 `pnpm db:migrate`；增量迁移保留原有对话并增加工具消息字段。

## Koishi 的使用边界

按[官方依赖调用方式](https://koishi.chat/zh-CN/manual/starter/direct)手动创建 `Context`，不使用 Koishi CLI 启动，不启用 console、sandbox、插件市场界面或 Koishi 数据库驱动。依赖 `koishi` 以满足 OneBot 的 peer dependency；包本身会传递安装 loader 等依赖，但应用不启用对应服务。

Koishi 4.18.11 的 ESM loader 入口存在 CommonJS 默认导入兼容问题，因此两个消息接入边界通过 Node.js `createRequire()` 使用官方 CommonJS 入口；项目其余代码保持 ESM。此兼容处理已有完整 OneBot 测试覆盖。
