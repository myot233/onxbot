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

默认响应显式指令。`/chat` 后的正文按普通文本处理，保留 `$(...)`、开头的横线、引号和换行。指令会话按平台、机器人账号、频道和用户区分。`/reset` 只清空当前身份的指令会话历史。

使用支持图片输入的 `OPENAI_MODEL` 时，可以在 `/chat` 里附上 QQ 图片，或引用一张图片再发送 `/chat`。已启用自然群聊的群也会把最近的图片附给模型。每次请求最多附 4 张，每张最多 5 MiB，支持 JPEG、PNG、GIF 和 WebP。下载失败时会保留文字和图片占位。指令历史和定时任务保留文字占位，观测面板只记录图片类型。

在 `CHAT_GROUP_IDS` 中填写允许自然参与的 QQ 群号，用逗号分隔。机器人会回应 @ 和引用自己的消息，回复时会 @ 触发回复的群友。使用真实模型时，它也会按群聊上下文判断是否接普通消息，主动接话有 3 分钟冷却。群聊在内存里按顺序追加消息，超过 16 条时批量丢弃最早 8 条，以便多次触发能复用相同的输入前缀，和指令会话分开。`CHAT_GROUP_SYSTEM_PROMPT` 可单独设置群聊人格，留空时沿用 `CHAT_SYSTEM_PROMPT`。

可将[理工系文学少女人设示例](examples/personas/literary-engineer.txt)的全文复制到 `.env`，用一对单引号包住多行的 `CHAT_GROUP_SYSTEM_PROMPT` 值。示例包含说话习惯、语气词在短消息里的用法和定时话题的开场方式。

默认 `CHAT_PROVIDER=echo`，回复 `收到：…`，用于验证整个接入链路。启用真实模型时修改 `.env`：

```dotenv
CHAT_PROVIDER=openai
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=你的密钥
OPENAI_MODEL=你的模型名称
```

模型请求和工具循环由 Vercel AI SDK 执行，支持 OpenAI 兼容的 `/chat/completions`。 使用 DeepSeek 时可设 `DEEPSEEK_REASONING_EFFORT=high` 启用高强度推理。工具回合会按协议回传推理内容，观测面板只标记该内容已隐藏。`OPENAI_BASE_URL` 应设置为服务商的 API 基地址。模型生成的回复正文作为普通文本发送，群聊提及由消息适配器根据触发消息的发送者生成。

### QQ 原生工具

使用 NapCat 和真实模型时，可在 `CHAT_QQ_TOOL_GROUP_IDS` 填写已启用自然群聊的群号。Agent 可以读取本群近期消息、群资料、根目录文件列表和本轮消息或引用中的合并转发，也可以给触发消息加表情或戳触发者。群号、成员和消息由会话绑定。定时回合仅开放本群历史、资料和文件列表。普通群聊可以只做表情回应，无需补发文字。

### 网页检索

使用官方 DeepSeek HTTPS API 时，可设置 `CHAT_WEB_RESEARCH=true`。Agent 遇到需要核对的梗、缩写或概念，可以用 `search_web` 查公开网页，并用 `fetch_page` 读取本轮搜索结果中的网页正文。搜索和抓取共用每轮 3 次请求额度。被直接点名的检索回合如果只生成了最终文本，也会发送一条简短回复。模型只应提交相关关键词，网页内容作为外部资料使用。DeepSeek 对成功的搜索和抓取按次计费。

### 定时发起群聊话题

把试点群号同时填入 `CHAT_GROUP_IDS` 和 `CHAT_TOPIC_GROUP_IDS`，并使用真实模型。该群收到第一条可用消息后在 PostgreSQL 建立定时任务，每次认领时写入下一次随机触发时间，间隔 15 至 20 分钟。任务和最多 16 条近期上下文会跨重启保留。多个进程共享数据库时，只有一个进程能认领同一回合。进程若在认领后中断，该次不会重发。群里有新活动、上次真人发言距今不超过一小时、至少有两条上下文且当前没有回合在跑时，Agent 才会被唤醒。它可以基于近期群聊和群记忆开一个话题，也可以保持沉默。发起话题时面向全群，不 @ 个人。

主动话题使用 Croner 每五秒检查 PostgreSQL 中的到期任务，记忆回顾使用 Croner 每五分钟检查。两者都启用防重入，停止时取消后续调度并等待在途任务结束。Croner 只负责唤醒，随机间隔、下次触发时间和已消费进度仍以数据库为准。

主动发言默认贡献一句具体看法、相关联想、有来源的补充或轻梗，不以提问起手维持互动。提示词要求发出一次贡献后结束定时回合，等待真人接话。旧项目、未解释术语和记忆中的未知项不会被当成催问待办；没人接的问句不能换个说法继续追。问题只有在有具体交流目的时才使用，没内容可补充时保持沉默。这些是模型行为规则，调度频率和普通对话的多轮发送能力不变。

### 定时回顾群记忆

把需要回顾的群号同时填入 `CHAT_GROUP_IDS` 和 `CHAT_MEMORY_REVIEW_GROUP_IDS`，并使用真实模型。启用后，新收到的群聊、Bot 回复和群内 `/chat` 对话进入 PostgreSQL 待回顾队列，保留发言者 ID 和消息时间。Croner 每五分钟检查到期任务，每群默认每小时回顾一次，每批最多 100 条，有积压时后续检查继续处理。空队列不会调用模型。

回顾模型根据本批证据整理有后续价值的领域语言、项目、明确的长期偏好、约定和反复出现的聊天模式。单次感叹、即时吃喝、未知缩写和猜测默认跳过，不要求每位成员或每批都产生文档。明确解释一次即可建立术语；聊天习惯需要多个独立回合的证据，不能从一次夜班、提问或玩笑推断作息、专业能力、身份或关系。更新相关笔记时合并证据、清理无依据推断和失效的临时细节，保留仍有用的事实。成员记忆只能选择本批出现的成员 ID。回顾仅开放记忆和完成工具。模型完成且文件写入落盘后才确认进度并删除这批待处理消息。数据库租约防止重复认领，中断后会重新处理未确认消息，失败时五分钟后重试。模型上下文和工具调用可在观测面板的 `memory-review/<groupId>` 会话查看。

### Markdown 记忆

使用真实模型时，Agent 可以在同一回合调用 `send_message`、`list_memory`、`read_memory` 和 `write_memory`。自然群聊的 Agent 每次调用 `send_message` 发一条最多 100 字的消息。它可以在后续步骤继续发，较长回复通常拆成两到三条短消息。回复群友时，只有第一条 @ 触发者。自定义群聊提示词中的工具示例应使用 `{"text":"…"}`。指令 `/chat` 会在数据库提交后回复。默认目录为 `memory/group/<群号>/` 和 `memory/user/<用户号>/`，可以用 `CHAT_MEMORY_DIR` 更换根目录。配置了自然参与的群使用该群目录，私聊 `/chat` 使用该用户目录。 群聊 Agent 会主动记录有长期价值的群内约定和成员偏好，即使它选择保持沉默。群共享记忆用 `scope=group`，当前发言者在本群的个人记忆用 `scope=user`，存放在 `memory/user/<用户号>/group/<群号>/`。定时回合只访问群共享记忆。

模型可以创建和更新多份按主题命名的 `.md` 文件。`write_memory` 排队后立即返回，后台串行写盘并原子替换文件。队列中的内容可以立即读到，正常退出时会等队列写完。容器部署时应把 `CHAT_MEMORY_DIR` 指到可写的持久卷。`/reset` 清理指令对话历史，Markdown 记忆单独管理。

实时聊天与定时回顾共用记忆筛选、证据和时间规则。模型只提交正文，不生成 `Recorded at:` 或 `Updated:` 元数据。每次写入会去掉正文中独立的旧时间元数据行，由存储层追加唯一的 `Recorded at` 更新时间；引用和代码示例中的同名文本保留。正文中带完整日期和显式时区的有效时间会规范为上海时区的 ISO 8601 格式，保留分钟、秒或小数精度。未知日期、缺少时区的旧时间和仅有日期的事件不会自动补值，需由模型依据来源纠正。旧文件在下次成功写入时修复格式，此过程不会扫描或批量重写线上记忆。上述筛选属于模型行为约束，代码确定执行的是格式清理与存储校验。

### 群聊反馈

通过 `CHAT_FEEDBACK_GROUP_IDS` 为指定群开启接话采样和引用反馈。启用方式、周报查询和回归流程见[群聊反馈与评测](docs/group-feedback.md)。

### 会话观测面板

Dashboard 是独立 workspace `@onxbot/dashboard`，使用 React、Vite、Tailwind CSS 和 shadcn/ui。Bot 承载同源只读 API 与构建后的前端，无需另起一个生产服务。在 `.env` 设置 `OBSERVE_PORT=8787` 后打开 [本地面板](http://127.0.0.1:8787)，默认不认证；如需启用 HTTP Basic 认证，可显式配置 `OBSERVE_PASSWORD`（至少 24 个可打印 ASCII 字符），用户名为 `onxbot`。

面板支持会话、状态与编号筛选，每五秒自动刷新且可暂停。选中回合后，可按步骤查看实际模型上下文、人格指令、工具参数与结果，也能查看包含 token 用量、缓存统计的原始事件。API 为 `GET /api/traces`、`GET /api/traces/:id`，支持 `session`、`status`、`search` 和 `before` 游标过滤，`limit` 默认为 50、最大 100。回合摘要和逐步事件存入 PostgreSQL，ID 在重启后保持稳定。历史通过“更早回合”翻页查询，不再因超过 50 个或重启而删除。页面指标仅统计当前页。此信息不代表 QQ 在线状态。

Trace 记录独立于面板开关，不启用面板也会记录实际模型调用。首次模型事件创建摘要，事件异步顺序写入；结束和退出时等待接受的写入完成。记录失败会报警并标记内容可能不完整，不会重试模型或 QQ 消息。每轮仍最多保留 16 个事件，每个事件最多 64,000 字符；供应商配置和原始供应商元数据会被裁剪。当前版本不自动清理数据库历史，旧版本已经丢失的内存 trace 无法补回。

顶部“记忆文档”入口提供全部 Markdown 记忆的只读浏览，覆盖 `group/<groupId>`、`user/<userId>` 和 `user/<userId>/group/<groupId>`。可按文件名、目录、群号或成员号搜索，切换渲染预览与原文，并沿文档引用跳转。目录与当前文档每 30 秒刷新，已接受的后台写入也立即可读。页面不提供写入、删除或任意服务器文件访问；沿用数字 ID、文件名、目录、符号链接和大小校验。Markdown 原始 HTML 不执行，外部图片不自动加载。API 为 `GET /api/memory` 和 `GET /api/memory/document?path=...`，与 trace API 共用认证设置。

记录进程每 30 秒续租，租期 90 秒。进程异常退出后，租约过期的未完成回合在下一次维护中标记为“中断”，不会伪造实际结束时间。

不设置 `OBSERVE_PORT` 时面板保持关闭。容器部署时设置 `OBSERVE_HOST=0.0.0.0`，将端口发布为 `127.0.0.1:8787:8787`，通过 `ssh -N -L 8787:127.0.0.1:8787 <服务器>` 访问。面板包含聊天与记忆正文，默认无认证的访问范围由本地绑定或外层代理控制。

前端开发使用 `pnpm --filter @onxbot/dashboard dev`，Vite 将 `/api` 代理到 `127.0.0.1:8787`。`pnpm dev` 同时运行 Bot 与前端开发任务，需要本地 `.env`。生产资源随 `pnpm build` 一并构建并打入镜像。

### 构建与运行

```bash
pnpm build
pnpm start
```

在仓库根目录执行。Turborepo 按 workspace 依赖顺序执行构建和类型检查并缓存产物；`pnpm typecheck` 会先构建依赖和 dashboard 资源，再检查应用与测试。`dev` 通过 `development` 导出条件直接加载各 workspace 的 TypeScript 源码，修改共享包也会触发重启；`start` 使用编译后的 JavaScript。迁移单独执行，应用启动时检查业务表是否已存在。

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

每次成功的指令对话按完整回合原子写入 AI SDK 消息。同一会话通过 PostgreSQL 行锁串行处理，不同会话可并发。记忆 Agent 的文件读取内容和工具参数只在本轮使用，指令历史只保存用户正文和实际回复。

当前实现会在整个指令回合期间持有事务及连接，连接池上限为 10。`CHAT_HISTORY_TURNS` 限制完整历史回合数。`ContextBuilder` 提供可选 token 预算接口。历史记录持续保存在数据库，直到 `/reset` 删除。`CHAT_MAX_INPUT_CHARS` 限制单条输入长度，`CHAT_TIMEOUT_MS` 限制每步模型请求时间，`TurnRunner` 默认最多请求模型 8 次。

升级已有数据库时执行 `pnpm db:migrate`。迁移 `003-sdk-turns` 会删除旧的指令对话历史，新回合写入 `conversation_turns`。

## Koishi 的使用边界

按[官方依赖调用方式](https://koishi.chat/zh-CN/manual/starter/direct)手动创建 `Context`，不使用 Koishi CLI 启动，不启用 console、sandbox、插件市场界面或 Koishi 数据库驱动。依赖 `koishi` 以满足 OneBot 的 peer dependency；包本身会传递安装 loader 等依赖，但应用不启用对应服务。

Koishi 4.18.11 的 ESM loader 入口存在 CommonJS 默认导入兼容问题，因此两个消息接入边界通过 Node.js `createRequire()` 使用官方 CommonJS 入口；项目其余代码保持 ESM。此兼容处理已有完整 OneBot 测试覆盖。

### GHCR 自动部署

`main` 的 CI 通过后会发布 `ghcr.io/myot233/onxbot:sha-<commit>`，并将通过检查的当前主分支镜像标记为 `:main`。GHCR 首次发布的包默认私有。服务器可以匿名拉取公开包，私有包需在部署用户的 Docker 会话中配置 GHCR 读取凭据。

将 `deploy/` 放到服务器的 `~/services/onxbot/`，使用现有的生产 `compose.yaml`、`compose.override.yaml` 和 `.env`。先确认首个 GHCR 镜像包含线上使用的功能，再安装并启用定时任务。

```sh
cd ~/services/onxbot
install -d ~/.config/systemd/user
install -m 0644 deploy/onxbot-image-update.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now onxbot-image-update.timer
```

定时任务每五分钟拉取镜像，发现变化时先用候选镜像运行数据库迁移，再重建 Bot。服务单元以本机观测面板为就绪探针。候选镜像启动失败时会尝试恢复上一个镜像，数据库迁移仍保留。后续检查会跳过这个失败的镜像，直到 GHCR 发布新镜像，或管理员删除服务器部署目录中的 `.ghcr-rejected-image`。手动操作 Bot 时使用相同的 Compose 文件组合。

```sh
docker compose -f compose.yaml -f compose.override.yaml -f deploy/compose.ghcr.yaml ps
journalctl --user -u onxbot-image-update.service -n 30
```
