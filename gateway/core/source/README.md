# 网关基础源码

`new-api-rc25-maintained.tar.gz` 是墨台构建所需的基础源码，不是渠道配置、数据库或运行备份。

- 来源：2026-10-25 从此前维护的 New API rc25 源码树生成的快照，已有历史兼容性修补；不是官方提交的原封副本。
- 上游仓库、文档记录的上游提交、原历史归档 SHA256：见 `manifest.json`。
- 当前归档 SHA256：同时由 `manifest.json` 和 `../../candidate-lock.json` 锁定。
- 归档中的全部保留文件与历史快照逐字节相同，包括 Go 源码、内嵌资源、前端源码和既有静态产物。
- 只移除 `.agents/`、根目录 `AGENTS.md`、`CLAUDE.md` 与本机部署脚本 `rehearse-docker-rc25-candidate.sh`。完整列表见清单，不删除任何 Go 源码或内嵌资源。
- `LICENSE`、`NOTICE` 为归档内相同文件的副本；其他第三方声明仍保留在归档内。不要移除版权或将维护源码另称为纯原创代码。

构建入口：

```sh
python3 gateway/build/replay.py --output /tmp/motai-build --build
```

在仓库根目录执行，需要 Python 3.12+、Git 和 Go 1.25.1 linux/amd64，且输出目录尚不存在。网络只用于下载锁定的 Go 模块，不再需要原部署服务器或私有源码包。测试与完整构建说明见 `../../build/README.md`。

原历史归档继续留在私有取证目录，不纳入发布；它用于解释旧构建记录，不能把原 SHA256 改写成当前公开包的 SHA256。
