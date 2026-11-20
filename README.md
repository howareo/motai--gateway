# 墨台网关 · motai--gateway

墨台是自托管的模型网关与管理控制台。Go 核心负责模型请求转发，Node 控制台管理渠道、API 密钥、模型、价格、余额、探活和请求统计。

## 功能

- 支持 OpenAI Responses、Chat Completions 和 Anthropic Messages 等现有协议入口。
- 渠道模型拉取、分组、主用与备用顺序、请求亲和。
- API 密钥管理、分组权限与模型路由。
- 自动探活、成本倍率同步、上游余额与模型价格。
- 请求记录、缓存用量、成本分布和统计面板。
- 桌面与移动端控制台。

渠道能否使用某种协议、模型、倍率或余额接口，取决于对应上游的实际支持情况。

## 源码组成

| 目录 | 内容 |
| --- | --- |
| `src/`、`public/` | 控制台服务端与前端 |
| `gateway/core/source/` | 锁定的 New API 维护版基础源码与许可 |
| `gateway/core/overlay/`、`gateway/patches/` | 墨台核心代码与维护补丁 |
| `contracts/` | 共享契约、用量向量与测试夹具 |
| `test/` | 控制台回归测试 |
| `gateway/build/replay.py` | 可重放的核心构建入口 |

公开仓库保留完整功能源码，不包含作者的渠道密钥、生产配置、数据库、真实账单或私有 Git 历史。公开提交与内部开发提交各自维护历史；当前源码的来源提交和文件哈希记录在 `public-source-manifest.json`。

## 获取与检查

```sh
git clone https://github.com/howareo/motai--gateway.git
cd motai--gateway
npm ci
npm run check
```

控制台要求 Node.js 18.19 或更高版本。运行入口为 `node src/server.js`，默认控制台端口为 `8787`；模型客户端应连接网关核心的 `3001` 端口。

## 构建核心

在 Linux amd64 上准备 Python 3.12+、Git 与 Go 1.25.1：

```sh
python3 gateway/build/replay.py --output /tmp/motai-build --build
```

输出目录必须尚不存在。构建入口校验基础源码、补丁、依赖和 overlay 的哈希，生成 `motai-gateway`、`motai-migrate` 与构建清单。构建本身不会连接或替换生产服务。

运行服务还需要 PostgreSQL、数据库迁移、稳定的管理/HMAC 密钥，以及核心和控制台环境变量。新安装从自己的空数据开始。仓库中的历史隔离测试模板不等同于一键生产部署工具。

## 测试与来源

`npm test` 运行控制台测试；`python3 gateway/build/test_replay.py` 检查核心构建输入。需要数据库、容器或平台条件的验证应在相应环境中运行。

核心的第三方来源与许可见 [gateway/THIRD_PARTY.md](gateway/THIRD_PARTY.md)。New API 的 AGPL-3.0 许可和版权原文随基础源码保留在 [gateway/core/source/](gateway/core/source/)。公开源码不附带作者的上游账号或额度。
