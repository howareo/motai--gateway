# 核心来源与复用边界

墨台核心复用维护版 New API 的转发源码，通过补丁与 overlay 接入自己的配置、调度和账本。基础源码现已随仓库分发，位于 [core/source](core/source/README.md)，不再依赖本机私有归档。当前构建输入见 [candidate-lock.json](candidate-lock.json)；[core-lock.json](core-lock.json) 仅保留早期样板的历史来源。

| 来源 | 本次用途 | 许可与边界 |
| --- | --- | --- |
| [QuantumNous/new-api](https://github.com/QuantumNous/new-api) | 复用协议、工具、usage、连接和取消处理；维护源码加墨台补丁与 overlay | 保留归档中的 AGPLv3 `LICENSE`、`NOTICE` 和 `THIRD-PARTY-LICENSES.md`；源码目录另附许可与版权原文 |
| [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) | 对照调度和协议实现，当前未引入其代码 | 当前核验 LICENSE 为 LGPLv3；后续引入时按具体文件及固定提交保留许可 |
| 当前墨台 `src/`、`public/` 与 overlay | 渠道管理、价格、采购倍率、余额、探活、统计与前端，以及墨台核心管理接口 | 本仓库现有实现；此次仅补齐源码分发与构建入口，不改变生产行为 |

归档中的 `relaykit` 是这份维护源码的一部分，提供协议 DTO、转换与事件能力；未发现单独许可，不将它另行声明为 MIT 组件。完整 New API handler 仍依赖 Gin、service、全局配置和计费状态。Sub2 此处仍是参考实现，未因本次补齐操作引入其代码。

源码基线已包含历史维护变更，并非官方提交的原封副本。来源日期、原归档哈希、公开包哈希、保留文件哈希与移除的非运行文件均记录在 `core/source/manifest.json`。公开包与原包的每个保留文件字节一致，没有借此次打包升级协议实现。
