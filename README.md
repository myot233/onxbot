# onxbot

TypeScript monorepo 对话机器人。QQ 通过 OneBot v11 接入，Koishi 以依赖方式嵌入进程，负责消息接入、指令分发和插件生命周期。对话核心、模型调用和 PostgreSQL 存储独立于 Koishi。

## 技术栈

- Node.js 24+、pnpm 10 workspace、TypeScript 6、ESM。
- Koishi 4 + `koishi-plugin-adapter-onebot`，正向 WebSocket；按需加载 HTTP/WebSocket **客户端**服务。
- PostgreSQL 18 + `pg` 连接池 + Kysely 类型安全 SQL 与迁移。
- `ts-pattern` 做请求和模型配置的穷尽匹配，`lodash-es` 裁剪对话上下文，Zod 校验环境变量和模型响应。
- Vitest 测试、Biome 格式化与检查、TypeScript project references 增量构建。

## 目录与依赖

```text
apps/bot                     读取配置、组装依赖、连接 OneBot、进程退出
packages/core                对话服务、存储接口、echo / OpenAI 兼容 provider
packages/database            Kysely schema、迁移、PostgreSQL 会话存储
packages/koishi-plugin-chat   将 Koishi 指令映射为对话请求
tests                        模型协议、配置、真实 PG 和 OneBot 协议集成测试
```

调用链：`QQ → OneBot → Koishi 插件 → ChatService → provider / ConversationStore → PostgreSQL`。

`core` 不导入 Koishi、Kysely 或 pg，`database` 只依赖核心存储接口。以后更换消息框架时，可以保留对话与存储实现。

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

支持 OpenAI 兼容的 `/chat/completions` 接口，当前采用非流式文本回复。`OPENAI_BASE_URL` 应包含 API 前缀，例如 `/v1`。消息作为普通文本发送，模型生成的 Koishi 元素标签不会被当作 @、图片等指令执行。

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

每次成功对话原子写入一对 user / assistant 消息。调用模型失败时回滚，不留下半个回合。同一会话通过 PostgreSQL 行锁串行处理，多进程也共享这一约束；不同会话可并发。

当前实现会在模型调用期间持有事务及连接，连接池上限为 10。这适合初始规模，吞吐量增加后可替换 `ConversationStore` 实现。`CHAT_HISTORY_TURNS` 限制传给模型的历史回合数（不是 token 限额），历史记录持续保存在数据库，直到 `/reset` 删除。`CHAT_MAX_INPUT_CHARS` 限制单条输入长度，`CHAT_TIMEOUT_MS` 限制模型请求时间。

## Koishi 的使用边界

按[官方依赖调用方式](https://koishi.chat/zh-CN/manual/starter/direct)手动创建 `Context`，不使用 Koishi CLI 启动，不启用 console、sandbox、插件市场界面或 Koishi 数据库驱动。依赖 `koishi` 以满足 OneBot 的 peer dependency；包本身会传递安装 loader 等依赖，但应用不启用对应服务。

Koishi 4.18.11 的 ESM loader 入口存在 CommonJS 默认导入兼容问题，因此两个消息接入边界通过 Node.js `createRequire()` 使用官方 CommonJS 入口；项目其余代码保持 ESM。此兼容处理已有完整 OneBot 测试覆盖。
