# 群聊反馈与评测

先向参与群的群友说明采样范围，再把群号同时填入 `CHAT_GROUP_IDS` 和 `CHAT_FEEDBACK_GROUP_IDS`。执行数据库迁移后启动 Bot。反馈采样默认关闭，仅真实模型启用。私聊和未进入模型决策的消息不会产生样本。每个样本包含模型实际看到的最近最多 16 条发言、发送结果以及策略版本。发言者名称替换为样本内编号，正文和引用仍可能含个人信息。

群友可以引用本群的一条 Bot 回复并发出以下命令。连续发送多条时，引用带 @ 的第一条。每个人对同一条回复保留最新的一票。

| 命令                      | 含义             |
| ------------------------- | ---------------- |
| `/bot-feedback good`      | 接话自然且有帮助 |
| `/bot-feedback interrupt` | 这时候不该插话   |
| `/bot-feedback wrong`     | 回复不准确或跑题 |

## 按周查看

按群、策略和触发类型拆开看。主动开口的频率以实际进入模型决策的自然回合为分母。被冷却或排队规则过滤的消息不在这个分母里。反馈覆盖率和反馈构成分开看，无票的回复保持未标注。

```sql
with votes as (
  select decision_id,
         count(*) filter (where label = 'good') as good,
         count(*) filter (where label = 'interrupt') as interrupt,
         count(*) filter (where label = 'wrong') as wrong
  from group_ratings
  group by decision_id
)
select group_id, policy, trigger,
       count(*) as decisions,
       count(*) filter (where outcome = 'sent') as sent,
       count(*) filter (where outcome = 'silent') as silent,
       count(*) filter (where outcome = 'stale') as stale,
       count(*) filter (where outcome = 'error') as errors,
       count(votes.decision_id) as rated_replies,
       coalesce(sum(votes.good), 0) as good_votes,
       coalesce(sum(votes.interrupt), 0) as interrupt_votes,
       coalesce(sum(votes.wrong), 0) as wrong_votes
from group_decisions
left join votes on votes.decision_id = group_decisions.id
where created_at >= now() - interval '7 days'
group by group_id, policy, trigger
order by group_id, policy, trigger;
```

## 用样本改策略

1. 每周从有负评、有正评和主动沉默的回合各挑一些。检查沉默样本有没有错过明确的问题。将运行失败和过时回复单独排查。
2. 用去掉身份细节的上下文构建固定回归集，为每条标注「应该接话」「应该保持沉默」以及回复需要满足的事实或语气要求。反馈是选样依据，最终标签由人工判断。
3. 用同一批样本离线比较现行提示词和候选提示词。统计误插话、漏答和回复合格率。保留一部分样本专门验收，避免用来调提示词。离线回放和评分目前由人工操作。
4. 在同一个群小范围验证候选版本，再跑周报。模型或群提示词变化会产生新的策略标识。修改内置群聊规则时，同时更新应用里的策略版本号。

建议由管理员每周清理超过 30 天的原始样本。删除样本会同时清理它的反馈票。保留用于回归的样本前先去除正文中的个人信息。

```sql
delete from group_decisions
where created_at < now() - interval '30 days';
```
