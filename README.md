# deploy-helper

> 把项目部署到任意 VPS，回答几个问题就够了。

不需要懂 Nginx、PM2、Certbot、supervisor——工具替你搞定服务器配置、进程管理、HTTPS 证书、代码更新。

---

## 快速开始

```bash
npx @zhengyizhao/deploy-helper init
```

或全局安装后使用：

```bash
npm install -g @zhengyizhao/deploy-helper
deploy-helper init
```

---

## 工作流程

**Web 服务**（5 步）：

```
[1/5] 服务器连接信息      → 输入 IP、SSH 密钥/密码，立即测试连通性
[2/5] 项目信息            → 自动检测类型、版本、启动命令，逐一确认
[3/5] 域名 & HTTPS        → 可选，自动申请 Let's Encrypt 免费证书
[4/5] 安装服务器环境      → 按需安装依赖，已安装的跳过
[5/5] 上传代码并启动服务  → 上传 → 启动进程 → 配置 Nginx → 健康检查
```

**后台脚本 / 定时任务**（4 步，跳过域名和 Nginx）：

```
[1/4] 服务器连接信息
[2/4] 项目信息（含运行方式选择）
[3/4] 安装服务器环境
[4/4] 上传代码并启动
```

完成后：

```
🎉 部署成功！

  # Web 服务
  访问地址：https://example.com

  # 定时任务
  定时计划：0 2 * * *
  日志查看：tail -f /var/log/myapp.log

  # 后台脚本
  进程状态：supervisorctl status myapp
  输出日志：tail -f /var/log/myapp.out.log
```

---

## 命令

| 命令 | 说明 |
|------|------|
| `deploy-helper init` | 首次部署，全程引导 |
| `deploy-helper update` | 推送最新代码并重启（支持多服务器） |
| `deploy-helper status` | 查看进程状态、内存、最近日志 |
| `deploy-helper rollback` | 从历史快照中选择一个版本回滚 |
| `deploy-helper env` | 上传 / 拉取 / 对比 .env 文件 |
| `deploy-helper backup` | 数据库备份（MySQL / PostgreSQL / MongoDB） |
| `deploy-helper servers` | 管理多台服务器 |

---

## 应用运行方式

init 时选择三种模式之一，影响进程管理和是否配置 Nginx：

| 模式 | 适用场景 | 进程管理 | Nginx |
|------|---------|---------|-------|
| **Web 服务** | API、网站、Next.js | PM2 / supervisor（自动重启） | ✓ 反向代理 |
| **后台脚本** | 爬虫、消息消费、长任务 | PM2 / supervisor（崩溃才重启） | ✗ |
| **定时任务** | 数据同步、定期清理 | 系统 crontab | ✗ |

---

## 支持的项目类型

### Node.js

自动检测：`.nvmrc` / `.node-version` / `package.json engines.node` → Node.js 版本；`package.json scripts.start` / 常见入口文件 → 启动命令。

- 进程管理：**PM2**（自动重启、开机自启）
- 支持 `npm start`、`node server.js`、`next start` 等所有启动方式
- **后台脚本模式**：PM2 加 `--no-autorestart`，进程正常退出后不重启
- **定时任务模式**：写入 crontab，按计划执行，日志写入 `/var/log/<appname>.log`

### Python

自动检测：`.python-version` / `pyproject.toml` → Python 版本；`requirements.txt` → 框架（FastAPI / Django / Flask）→ 推荐启动命令；`environment.yml` / `conda-lock.yml` → conda 模式。

进程管理：**supervisor**（自动重启、开机自启、日志写入 `/var/log/<appname>.out.log` + `.err.log`）

**pip 模式**（有 `requirements.txt`）
- 服务器无 Python 时自动安装（deadsnakes PPA，支持 3.8–3.13），已有则跳过
- 自动创建 virtualenv，所有包装在 `venv/` 内，不污染系统环境
- FastAPI → uvicorn；Django / Flask → gunicorn
- **后台脚本模式**：supervisor `autorestart=unexpected`（只有崩溃才重启，正常退出不重启）
- **定时任务模式**：写入 crontab，用 venv 内的 Python 执行

**conda 模式**（有 `environment.yml`）
- 服务器自动安装 Miniconda 到 `/opt/miniconda3`，已有则跳过
- 从 `environment.yml` 创建 conda 环境（`conda env create -n <appname>`），二次部署时 `--prune` 增量更新
- 启动命令通过 `conda run -n <appname> --no-capture-output` 执行，无需 `conda activate`

**本地生成 environment.yml**

```bash
conda activate <你的环境名>
conda env export > environment.yml
```

> 如果环境包含 CUDA / cudatoolkit 等系统级包，建议改用 Docker 方案（见下文），避免服务器 GPU 驱动版本不一致。

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

纯 HTML / CSS / JS，直接由 Nginx 托管，自动配置 gzip 和 SPA 回退路由。`dist/` 等构建产物会正常上传（不会被跳过）。

---

## 对于不在列表里的语言

> Java、C++、Go、Rust、CUDA、R……

推荐路线：写 Dockerfile 把运行环境封装进镜像，然后选 Docker 类型。deploy-helper 不需要了解你的语言细节，只负责把容器跑起来。选择 `其他` 类型时，工具会在终端直接展示以下模板：

**Python + conda / CUDA**
```dockerfile
FROM continuumio/miniconda3
WORKDIR /app
COPY environment.yml .
RUN conda env create -f environment.yml -n myenv
COPY . .
CMD ["conda", "run", "-n", "myenv", "--no-capture-output", "python", "main.py"]
```

**Java（Maven + JDK 21）**
```dockerfile
FROM maven:3.9-eclipse-temurin-21-alpine AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:resolve -q
COPY src ./src
RUN mvn package -DskipTests -q
FROM eclipse-temurin:21-jre-alpine
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
CMD ["java", "-jar", "app.jar"]
```

**Go**
```dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o main .
FROM alpine:latest
COPY --from=build /app/main .
EXPOSE 8080
CMD ["./main"]
```

Dockerfile 入门：https://docs.docker.com/get-started/

---

## update — 代码更新

```bash
deploy-helper update
```

- 部署前自动创建代码快照，失败可立即 rollback
- 复用 init 的启动逻辑，appMode / conda / composeFile 全部生效
- 重启后健康检查（PM2 online / supervisor RUNNING / 容器 running）
- 支持多台服务器：并行 / 串行 / 滚动三种策略

---

## rollback — 版本回滚

```bash
deploy-helper rollback
```

每次 `update` 前自动创建快照，保留最近 5 个版本。回滚时：

1. 备份当前版本（以便反悔）
2. 停止服务
3. 用 rsync 还原代码（保留 `venv/` / `node_modules`，只换代码）
4. 重启服务 + 健康检查

---

## env — 环境变量管理

```bash
deploy-helper env
```

- **上传**：本地 `.env` → 服务器（先备份旧 `.env`，权限自动设为 600，上传后重启服务）
- **拉取**：服务器 `.env` → 本地
- **对比**：显示本地和服务器的 key 差异（新增 / 缺失 / 值不同）

---

## backup — 数据库备份

```bash
deploy-helper backup
```

支持 MySQL / PostgreSQL / MongoDB，功能：

- 立即备份（导出 + gzip 压缩）
- 查看 / 下载历史备份（保留最近 10 个）
- 配置定时自动备份（写入 crontab）

**安全设计**：定时脚本的数据库密码存放在 `/etc/deploy-helper/<appname>.creds`（chmod 600，root 所有），脚本本身 chmod 700，不在可读位置明文暴露密码。

---

## 前提条件

**本地**
- Node.js 18+

**服务器**
- Ubuntu 20.04 / 22.04 / 24.04
- root 权限或可 sudo
- 开放 22（SSH）、80（HTTP）、443（HTTPS，如需 HTTPS）端口

**不需要**提前在服务器安装任何东西——Nginx、Node.js、Python、Docker、PM2、supervisor、certbot，工具按需安装，已装的跳过。

---

## 配置文件

首次部署后，项目根目录生成 `.deploy-config.json`，记录服务器地址、部署路径、启动命令等。工具会自动将其加入 `.gitignore`（文件中含服务器密码 / 密钥，请勿提交到 git）。

---

## License

MIT
