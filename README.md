# 无线传输 (Wireless Transfer)

基于 WebRTC 的**局域网 / 跨网 P2P 文件与文本传输**工具（Web 版，零运行时依赖）。
输入同一个「房间名」即可在设备间互传文件与文字，无需注册、无需云账号。

> 本项目从 [PairDrop](https://github.com/schlagmichtod/PairDrop)（AGPL-3.0）思路二次开发，遵循 AGPL-3.0 开源协议。

## 特性

- 📁 **文件 / 文本互传**：浏览器内选择文件或输入文字，同房间设备实时收发。
- 🌐 **P2P 直连**：传输走 WebRTC 点对点，不经服务器中转（服务器只负责信令）。
- 🔀 **TURN 中继兜底**：当两端 NAT 穿透失败无法直连时，自动走 TURN 中继保证连通。
- 🐳 **容器化部署**：服务端为「零依赖」Node 程序（仅用内置模块，连 WebSocket 都手搓），镜像极简。
- 🔧 **CI 自动构建**：GitHub Actions 多架构（amd64 / arm64）构建并推送到 GHCR。

## 架构

```
浏览器 A ──┐                        ┌── 浏览器 B
           │   WebSocket 信令        │
        ┌──┴────────────────────────┴──┐
        │   wireless-transfer (server)  │  纯 Node，零依赖
        └───────────────────────────────┘
           │  WebRTC 数据通道（P2P 直连 / TURN 中继）
        ┌──┴────────────────────────┴──┐
        │  coturn (TURN 中继服务器)      │
        └───────────────────────────────┘
```

- **server**：提供网页 + WebSocket 信令，并下发 ICE 配置（STUN/TURN）。
- **coturn**：提供 TURN 中继，保证复杂 NAT 环境下也能连通。

## 部署

### 方式一：拉取预构建镜像（推荐）

镜像已通过 CI 推送到 GitHub Container Registry：

| 组件   | 镜像                                            |
| ------ | ----------------------------------------------- |
| 主程序 | `ghcr.io/xxin12/wireless-transfer:latest`        |
| TURN   | `ghcr.io/xxin12/coturn:latest`                  |

> 国内 NAS 常无法访问 Docker Hub，故 coturn 已转存至 GHCR，两个镜像均不依赖 Docker Hub。

### 方式二：威联通 NAS（Container Station）部署

1. 打开 QNAP **Container Station → 应用程序 → 创建**。
2. 粘贴仓库内的 `wireless-transfer/docker-compose.qnap.yml`。
3. 把两处 `CHANGE_THIS_TO_A_STRONG_PASSWORD` 换成你自己的**强密码**
   （`app` 的 `TURN_CREDENTIAL` 与 `coturn` 的 `--user=wireless:...` 必须一致）。
4. 创建并启动。两个容器会从 GHCR 拉取镜像。

### 方式三：本地 / 其它 Docker 环境

```bash
# 克隆后手动构建
docker build -t wireless-transfer ./wireless-transfer
docker run -p 3000:3000 -e PORT=3000 wireless-transfer
```

## 配置

### 环境变量（server）

| 变量               | 默认值                         | 说明                                   |
| ------------------ | ------------------------------ | -------------------------------------- |
| `PORT`             | `3000`                         | 容器内监听端口                         |
| `STUN_SERVERS`     | `stun:stun.l.google.com:19302` | STUN 服务器，用于探测公网地址          |
| `TURN_USERNAME`    | `wireless`                     | TURN 中继用户名                        |
| `TURN_CREDENTIAL`  | （必填）                       | TURN 中继密码（与 coturn 一致）        |
| `TURN_PORT`        | `34780`                        | TURN 公网端口                          |

> TURN 地址由服务端根据请求 `Host` 自动推导，**无需在配置里写死域名 / IP**。

### 端口

| 协议 | 端口                | 用途                       |
| ---- | ------------------- | -------------------------- |
| TCP  | `30000 → 3000`      | 网页 + WebSocket 信令      |
| UDP  | `34780`             | TURN 控制 / 数据           |
| UDP  | `40000-40010`       | TURN 中继端口范围          |

外网访问需在路由器上做对应端口转发（范围端口建议用「范围转发」一条规则）。

## 使用

1. 浏览器打开 `http://< NAS 地址 >:30000`。
2. 多台设备进入**同一个房间名**。
3. 选择文件或输入文字，点击对端设备即可收发。

## ⚠️ 跨网 / HTTPS 说明

WebRTC 要求**安全上下文**：

- `localhost` 例外，本地调试无障碍。
- **HTTPS** 环境下浏览器放行 WebRTC。
- **纯 HTTP 跨网**（如 `http://域名:30000`）在手机 / iOS Safari 上会被浏览器限制 RTCPeerConnection。

本仓库默认按**纯 HTTP 跨网**部署（不启用 caddy / HTTPS）。若需手机端跨网稳定使用，建议前置反向代理并启用 HTTPS。

## 安全

- TURN 密码请使用强随机值，且 `app` 与 `coturn` 两处保持一致。
- 公开仓库不含任何明文凭证，所有密钥均在部署时由用户填入。
- 本仓库为公开仓库，基于 PairDrop（AGPL-3.0），请遵守对应许可证义务。

## 许可证

AGPL-3.0。本项目派生自 [PairDrop](https://github.com/schlagmichtod/PairDrop)。
