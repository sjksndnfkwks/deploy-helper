# deploy-helper

> 把项目部署到任意 VPS，回答几个问题就够了。

不需要懂 Nginx、PM2、Certbot、supervisor——工具替你搞定服务器配置、进程管理、HTTPS 证书、代码更新。

---

## 快速开始

```bash
npx @zhengyizhao/deploy-helper
```

或全局安装后使用：

```bash
npm install -g @zhengyizhao/deploy-helper
deploy-helper
```

---

## 工作流程

```
[1/5] 服务器连接信息      → 输入 IP、SSH 密钥/密码，立即测试连通性
[2/5] 项目信息            → 自动检测类型、版本、启动命令，逐一确认
[3/5] 域名 & HTTPS        → 可选，自动申请 Let's Encrypt 免费证书
[4/5] 安装服务器环境      → 按需安装依赖，已安装的跳过
[5/5] 上传代码并启动服务  → rsync 上传 → 启动进程 → 配置 Nginx
```

完成后：

```
🎉 部署成功！

  访问地址：https://example.com
  更新代码 → deploy-helper update
  查看状态 → deploy-helper status
```

---

## 命令

| 命令 | 说明 |
|------|------|
| `deploy-helper` / `deploy-helper init` | 首次部署，全程引导 |
| `deploy-helper update` | 推送最新代码并重启服务 |
| `deploy-helper status` | 查看进程状态、内存、最近日志 |

---

## 支持的项目类型

### Node.js

自动检测：`.nvmrc` / `.node-version` / `package.json engines.node` → Node.js 版本；`package.json scripts.start` / 常见入口文件 → 启动命令。

- 进程管理：**PM2**（自动重启、开机自启）
- 支持 `npm start`、`node server.js`、`next start` 等所有启动方式

### Python

自动检测：`.python-version` / `pyproject.toml` → Python 版本；`requirements.txt` → 框架（FastAPI / Django / Flask）→ 推荐启动命令。

- 服务器无 Python 时自动安装（通过 deadsnakes PPA，支持 3.8–3.13）
- 已有对应版本则跳过安装
- 依赖隔离：自动创建 **virtualenv**，所有包装在 `venv/` 内，不污染系统
- 进程管理：**supervisor**（自动重启、开机自启、日志归档）
- 根据框架自动选择服务器：FastAPI → uvicorn；Django / Flask → gunicorn

### Docker

适合**所有** deploy-helper 原生不支持的场景：Java、Go、Rust、C++、CUDA、conda 环境、多服务编排……只要你有 Dockerfile，部署流程就与语言无关。

自动检测：
- `Dockerfile` — 存在则提示，不存在时给出引导
- `docker-compose.yml` / `docker-compose.yaml` / `compose.yml` / `compose.yaml` — 自动选用
- Dockerfile `EXPOSE` 或 compose `ports` — 读取宿主机端口

两种部署模式：

| 模式 | 条件 | 命令 |
|------|------|------|
| Compose 模式 | 检测到 compose 文件 | `docker compose -f <file> up -d --build --remove-orphans` |
| 单容器模式 | 仅有 Dockerfile | `docker build` + `docker run --restart unless-stopped` |

**Docker 是否需要安装**：工具先检查服务器是否已有 Docker（`command -v docker`），已有则跳过安装步骤。许多云服务商镜像预装了 Docker，无需重复安装。

**.env 文件**：默认不上传（含敏感信息）。检测到本地 `.env` 时会询问是否上传；选择不上传时，工具会告知在服务器手动创建的路径。

### 静态网站

纯 HTML / CSS / JS，直接由 Nginx 托管，自动配置 gzip 和 SPA 回退路由。

---

## 对于不在列表里的语言

> Java、C++、CUDA、R、Fortran……

推荐路线：先写 Dockerfile，把运行环境完整封装进镜像，然后选 Docker 类型部署。deploy-helper 不需要了解你的语言细节，只负责把容器跑起来。

Dockerfile 入门：https://docs.docker.com/get-started/

---

## 前提条件

**本地**
- Node.js 18+

**服务器**
- Ubuntu 20.04 / 22.04 / 24.04
- root 权限或可 sudo
- 开放 22（SSH）、80（HTTP）、443（HTTPS）端口

**不需要**提前在服务器安装任何东西——Nginx、Node.js、Python、Docker、PM2、supervisor、certbot，工具按需安装，已装的跳过。

---

## 配置文件

首次部署后，项目根目录生成 `.deploy-config.json`，记录服务器地址、部署路径、启动命令等。建议加入 `.gitignore`（文件中可能含密码字段）。

---

## License

MIT
