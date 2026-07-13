# 内网部署（无公网 IP，安全优先）

公网端口未批下来时的落地方案。核心安全前提：**beszel agent 无入站命令通道**，
hub 被攻破也无法在 agent 机器上执行命令，通信只有 agent 单向出站 + token。
这与哪吒监控（自带批量命令/WebSSH）有本质区别。

## 连接模式：优先 WebSocket 出站

两种模式，内网一律用前者：

| 模式 | 谁连谁 | agent 是否开端口 | 适用 |
|---|---|---|---|
| **WebSocket（推荐）** | agent 出站连 hub | **否，零入站** | 内网、跨网段、将来公网 |
| SSH | hub 主动连 agent | 是（默认 45876） | 同网段、hub 能直连 agent |

WebSocket 模式 agent 本机不监听任何对外端口，只要能出站访问 hub 的地址即可，
最符合“安全优先”。离线脚本默认 `LISTEN=127.0.0.1`，即使降级也不对外暴露。

## 灰度顺序：测试 → 开发 → 生产

### 1. 测试环境（已就绪）
hub 跑在 47.92.243.243:50000，test-node / test-node2 已接入、归入“开发环境”组。
先在这里把面板、分组、必检、告警都验证顺。

### 2. 开发环境（内网批量接入）
hub 放一台内网各段都能访问的机器（或每段一台中继，见下）。给开发机装 agent：

- **能连 GitHub 的机器**：面板“添加系统”复制命令，一行装。
- **连不上 GitHub 的机器**：用离线包（下面“离线安装”）。

装完在 agent.env 配必检项，按项目分组（编辑系统填“分组”）。

### 3. 生产环境（最后，最严）
- agent 装时 **不开自更新**（离线脚本默认就不装自更新定时器）。
- hub 数据目录 `/data/apps/ops/beszel-hub/data` 严格备份、限制访问（私钥在里面）。
- 面板只在内网开放；确需跨段用中继，不要图省事直接全网放通。
- 升级 agent 走人工离线包，不依赖外网。

## 离线安装（内网连不上 GitHub 的机器）

在一台**能上网**的机器上取二进制（或直接用本仓库 dist/rel 下已编译好的）：

```bash
# 二选一：从 fork Release 下，或用已有的 dist/rel/beszel-agent_linux_amd64.tar.gz
curl -L -o beszel-agent_linux_amd64.tar.gz \
  https://gh-proxy.com/https://github.com/2474481080/beszel/releases/download/v0.18.9/beszel-agent_linux_amd64.tar.gz
```

把 `install-agent-offline.sh` + `beszel-agent_linux_<arch>.tar.gz` 拷到目标机同一目录，执行：

```bash
# KEY/TOKEN 从面板“添加系统”弹窗获取（先在面板建好这台系统）
./install-agent-offline.sh \
  -k "ssh-ed25519 AAAA..." \
  -t "系统token" \
  -url "http://内网HUB_IP:50000"
```

- 默认 WebSocket 出站、`LISTEN=127.0.0.1`（不对外开端口）、不装自更新。
- 必检项装完编辑 `/opt/beszel-agent/agent.env`，`systemctl restart beszel-agent`。
- 重复执行安全：已装过则只更新 KEY/TOKEN/HUB_URL/端口。

## 跨网段不互通时

每个互不相通的网段放一台能同时访问本段和中心 hub 的机器，本段 agent 指向它。
beszel 的做法是这台机器用 WebSocket 出站连中心 hub，或用 hub 的多实例；
简单起见也可以每段独立一个 hub，面板分开看。（这块按实际网络拓扑再定，
需要时单独做中继脚本。）

## 将来公网 IP 批下来

agent 只需把 HUB_URL 改成公网地址（`systemctl edit` 或重跑脚本），无需重装。
公网 hub 前面套 nginx + HTTPS，防火墙只放行 443；agent 仍是纯出站，
不因为暴露到公网而增加被控风险。
