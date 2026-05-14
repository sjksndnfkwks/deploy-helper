# 🚀 deploy-helper

> 把项目部署到服务器，就这么简单。

不需要懂 Nginx、PM2、Certbot——回答几个问题，剩下的交给它。

---

## 为什么有这个工具？

你写完了一个项目，想放到服务器上让别人访问。但你卡在了这些问题上：

- 服务器买好了，然后呢？
- Nginx 怎么配？
- HTTPS 证书怎么申请？
- 代码更新了怎么同步到服务器？
- 服务挂了怎么知道？

`deploy-helper` 就是来解决这些的。

---

## 快速开始

```bash
npx deploy-helper
```

第一次运行会引导你完成全套配置，大约 5 分钟搞定：

```
🚀 deploy-helper — 把项目部署到服务器，就这么简单

[1/5] 服务器连接信息
? 服务器 IP 地址：123.456.78.9
? SSH 端口：22
? 登录用户名：root
? 登录方式：SSH 密钥（推荐）
? SSH 密钥路径：~/.ssh/id_rsa
  ✓ 服务器连接成功！

[2/5] 项目信息
  ℹ 自动检测到项目类型：Node.js 应用
? 应用名称：my-app
? 部署路径：/var/www/my-app
? 启动命令：node index.js
? 端口：3000

[3/5] 域名 & HTTPS
? 是否配置域名？是
? 你的域名：example.com
? 自动申请 HTTPS 证书？是

[4/5] 安装服务器环境
  ✓ 安装 Nginx
  ✓ 安装 Node.js 20
  ✓ 安装 PM2

[5/5] 上传代码并启动服务
  ✓ 项目文件上传完成
  ✓ 安装依赖
  ✓ 启动应用（PM2）
  ✓ Nginx 配置完成
  ✓ HTTPS 证书申请成功

🎉 部署成功！

  访问地址：https://example.com
  更新代码 → deploy-helper update
  查看状态 → deploy-helper status
```

---

## 命令

| 命令 | 说明 |
|------|------|
| `deploy-helper` 或 `deploy-helper init` | 首次部署，全程引导 |
| `deploy-helper update` | 把最新代码推送到服务器并重启 |
| `deploy-helper status` | 查看服务运行状态、内存、最近日志 |

---

## 支持的项目类型

| 类型 | 进程管理 | 说明 |
|------|---------|------|
| Node.js | PM2 | Express、Koa、Next.js 等 |
| Python | Supervisor | Flask、FastAPI、Django 等 |
| Docker | docker compose | 任意容器化应用 |
| 静态网站 | Nginx | 纯 HTML/CSS/JS |

---

## 前提条件

- **本地**：Node.js 18+
- **服务器**：Ubuntu 20.04 / 22.04 / 24.04（root 或 sudo 权限）

---

## 安装（全局）

```bash
npm install -g deploy-helper
deploy-helper init
```

---

## 配置文件

首次部署后，项目根目录会生成 `.deploy-config.json`，记录所有配置。建议加入 `.gitignore`（其中包含服务器密码字段）。

---

## License

MIT
