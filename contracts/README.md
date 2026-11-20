# 墨台 v1 共享合同

`v1/*.schema.json` 是 Node 和 Go 共用的 Draft 7 线缆形状。引用只指向这五份本地文件；运行时禁用远程 Schema。Node 使用固定 `ajv@8.20.0`，Go 使用固定 `github.com/santhosh-tekuri/jsonschema/v5@v5.3.1`。格式校验独立注册严格 UTC 日历、HTTP(S) URL 和 IP/CIDR，不插默认值、强转或删字段。

| 文件 | 根 / definitions | 消费者 |
| --- | --- | --- |
| common | ID、UUID、十进制序列、安全整数、UTC、协议、终态枚举 | 所有合同 |
| config | config、credentials、manifest、desired_pointer | Node publisher、Go activator |
| usage | usage、count、provider_counts | Go normalizer、Node 计价和投影 |
| records | intent、terminal、attempt、event | Go 持久层、Node 查询和投影 |
| internal-api | 请求、响应和查询 DTO | Go `/internal/v1`、Node client |

Node 入口为 `src/gateway/schema.js`；`validateContract` / `assertContract` 只做格式校验，返回本地分类错误，不带被拒的值。`validateConfig`、`validateUsage`、`validateRecord` 和 `validateQuery` 分别校验域关系。Go 对应入口在 `gateway/core/overlay/motai/contract`，不依赖上游业务包。权限导入的新旧可达集合等价、文件权限/哈希、操作幂等和固定快照/游标绑定，须由发布器及相应业务实现检查，格式通过不代表这些业务验收通过。

写入与配置严格拒绝未知字段和版本。读取仅对明确的响应/记录合同放宽新增可选字段，仍校验 required、类型和枚举；`provider_counts` 在读取模式也保持严格白名单。未知 usage/终态版本必须阻止投影推进，不能当成功或略过。配置和变更请求没有宽松读取入口。

gen、seq、epoch 为十进制字符串，不经过 Number。Token/耗时为 `[0, 9007199254740991]` 整数；所有必填的可空字段仍需出现。UTC 只接受实际存在的 `YYYY-MM-DDTHH:mm:ss[.最多9位]Z`，拒绝日期归一化、闰秒和非零偏移；时间区间为 `[from,to)`，排序保留纳秒。分页 cursor 原样传递。

`intent.thinking_budget` 是请求预算元数据，接受 null、非负安全整数，以及 Gemini 自动预算哨兵 `-1`；`-2` 等其他负数无效。`-1` 不表示实际 Token 数，不放宽 common/usage 中任何计数的无符号约束。

渠道 ID 为 1–128 字符的合同 ID，原样保留字符串，`001` 与 `1` 是不同身份。旧成本、健康及钱包存储仅在入口兼容正安全整数 number 并转为字符串，不对 string 做数值归一化；拒绝空值、路径和超界 number。渠道字典使用空原型，合法的 `constructor`、`toString` 等 ID 与对象原型隔离。读取既有有效文件不触发格式重写；错误 ID 在批量 reconcile 修改状态或清理钱包凭据前整批拒绝。

每个 usage 计数独立携带 `value`、`availability=known/absent/estimated`、`completeness=final/partial`、`provenance=provider/derived/adapter_estimate/absent`。`null+absent` 表示未知，显式 `0+known` 表示已知零。`total_input` 包含互斥的 uncached、cache_read 和三类 cache_write；缓存写按 `ttl_5m`、`ttl_1h`、`ttl_unknown` 分开。TTL未知不按5分钟计价。缓存矛盾保留原始白名单数值和独立输出，只撤销无法证明的派生量。reasoning 为 `subset_of_output` 时不得重复收费；Gemini thoughts 与 output 的关系保持 `unknown`，有独立数值也不推断其包含关系。

`provider_counts` 仅保留 Schema 明列的供应商数值键。`issues`、终态、错误和渠道效果均为本地枚举，不复制上游自由文本、code/header/message。request/attempt 意图与终态不包含正文、工具内容、原始会话 Key 或凭据原值；凭据原值只在专用 credentials 文件和临时模型预览请求内使用。通用响应 Schema 接受的 error.message 由本地错误映射提供，不能用于证明任意上游文字已脱敏。

频道 `credential_ref` 与 `credential_version` 同时为 null 表示清空，只有 disabled 可用；有引用则须匹配当前 credentials 代次中的一项。权限的 `model_ids`、`channel_ids`、`protocols` 都是显式列表，或恰好一个元素的 `["*"]`。`model_ids: ["*"]` 表示所列渠道在所列协议下当前提供的全部模型；`channel_ids: ["*"]` 表示 `pool_id` 这个池里的全部渠道（渠道属于多个池时只按该权限的 `pool_id` 匹配），且跳过 `permission_channel_outside_pool` 校验；`protocols: ["*"]` 表示全部协议（含 `count_tokens`）。三者都由核心在选路时判定：别名先解析为真实模型，渠道必须真有该模型且支持该协议，停用渠道照旧跳过，跨池 `ambiguous_pool` 规则不变，`/v1/models` 随之列出这些渠道实际提供的模型。三个字段的 `*` 都必须是该数组的唯一元素，与任何具体值混用的配置被领域校验拒绝，错误码 `permission_wildcard_mixed`，Go 与 Node 一致；旧版核心会因 `unknown_permission_model`、`permission_channel_outside_pool` 或 schema 校验拒绝含 `*` 的配置，所以须先升级核心再发布。暂不可达的限制允许保留，启停和精确删除不得扩大权限。空 channel permission 应由编辑业务移除，而不是解释为全部渠道。

面板调用令牌变更使用 `POST /api/gateway/callers/change`，请求为 `{baseGen, operationId, change}`。`change.action` 为 `create/update/enable/disable/rotate`；create 的 `caller` 使用 camelCase 字段 `name, enabled, subjectEnabled, expiresAt, allowedIps, permissions`，默认 disabled、主体启用、无到期、IP 不限、权限空集。ID 由服务器生成，update 可携带相同 ID 并局部更新；enable/disable/rotate 只接受 `callerId`。permission 为显式 `{poolId, modelIds, channelIds, protocols, groups}`，`groups` 默认空数组；`modelIds`、`channelIds`、`protocols` 都可为 `["*"]`（语义见上）。

创建和显式 rotate 才生成 `sk-motai-` 加 32 随机字节 base64url 的调用令牌。Node 从专用 `MOTAI_CALLER_HASH_KEY` 获取原始 UTF-8 字节，经构造参数 `callerHashKey` 传入发布器；Go 的 `MOTAI_HMAC_KEY_FILE` 必须包含完全相同的 32–4096 字节，禁止 trim。持久配置只保留 `HMAC-SHA256(key, "motai-caller-v1" + NUL + token)` 的小写十六进制值（NUL 为一个零字节）；公开快照不含该哈希。原令牌在首次变更响应的 `oneTimeToken` 里返回；操作回执和配置文件不保存原令牌，控制台另把它加密存进密钥库 `caller-keys.json`，供列表随时复制（见 `BUILD_AND_ROLLBACK.md`「调用令牌密钥库」，网关鉴权不读该文件）。同 operationId 的恢复/重放保留相同 caller 和代次，只返回 `oneTimeTokenUnavailable:true`；丢失响应后通过用户明确确认的 rotate 更换，绝不因重试隐式轮换。rotate 保留调用方状态和权限，待新代次激活后旧令牌失效。

`fixtures/contract-vectors.json` 的结构校验与 `domain` 关系校验分开，双端直接读取。`usage-vectors.json` 包含 OpenAI 包含式、Anthropic 相加与混合 TTL、DeepSeek hit/miss、Gemini 已知字段/未知关系、缺失、显式零、失败 partial 与矛盾保留输出。所有样例标记 `synthetic_contract`，不代表现用上游协议已通过运行取证。provider_counts 的键是适配器允许写入的规范名字；并非原始 JSON 的自由抓取。

`billing_probe_response` 有两个可选字段。`error_class` 是本地枚举（`unauthorized`、`group_unresolved`、`http_4xx`、`http_5xx`、`timeout` 等，取自维护探测代码实际会给出的分类，加兜底值 `probe_failed`），只在 `unknown` / `unsupported` 时出现，不含上游文本。`upstream_group` 是匹配到的上游 `group_ratio` 分组名，1–128 个字符且不含控制字符，是整份合同里唯一来自上游的字符串，只在 `known` 时出现。两个字段缺省时与旧响应完全一致，旧控制台（读取模式放宽新增字段）和旧核心（字段本就可选）互相兼容；核心的字段清洗在 `motaiSanitizeUpstreamGroup`，枚举在 `motaiProbeErrorClasses`，两处须与 Schema 同步。

Node 验证：`node --test test/gateway-schema.test.js`。Go 在候选源码树内设置 `MOTAI_CONTRACTS_DIR` 指向本目录，运行 `go test ./motai/contract`；`usage` normalizer 直接消费相同 vectors 的 `provider_counts`、`partial` 与 `expected`。合同包仅做校验，不另写 SSE/transport 或计价算法。

假上游接线由现有 lab 在协议回调边界传入白名单计数，再以共享 usage 向量验证规范结果。原始 fixture 可以有合成金丝雀，持久意图/终态/事件和浏览器响应不得带入金丝雀。真实权限导入、HTTP 路由、PG事务、投影提交序和隐私流经测试另属 S2–S6 的运行验收。
