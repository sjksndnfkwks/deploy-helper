# 发布流程

## 1. 版本号

`package.json` 和 `src/index.js` 中的版本号保持一致：

```bash
# package.json
"version": "x.y.z"

# src/index.js
console.log(chalk.cyan.bold('\n🚀 deploy-helper') + chalk.gray(' vx.y.z ...'))
```

版本规则（语义化版本）：
- `patch`（0.2.**1**）：bugfix
- `minor`（0.**3**.0）：新功能，向下兼容
- `major`（**1**.0.0）：破坏性变更

## 2. 发布前检查

```bash
# 语法检查
node --check src/utils/ssh.js
node --check src/utils/setup.js
node --check src/utils/config.js
node --check src/utils/detect.js
node --check src/commands/init.js
node --check src/commands/update.js
node --check src/commands/status.js
node --check src/commands/rollback.js
node --check src/commands/backup.js
node --check src/commands/env.js
node --check src/index.js

# 加载验证
node --input-type=module -e "import('./src/index.js').then(()=>{})"

# 预览打包内容（确认无敏感文件）
npm pack --dry-run
```

`.npmignore` 已配置排除 `.claude/`、`.git/` 等目录，无需手动处理。

## 3. 提交并推送

```bash
git add -A
git commit -m "Bump version to x.y.z"
git push
```

## 4. 登录 npm

```bash
npm login
# 输入 npmjs.com 用户名、密码
# 如开启了 2FA，准备好 authenticator OTP
```

## 5. 发布

```bash
# 带 OTP（推荐，避免二次提示）
npm publish --access public --otp=<6位OTP码>

# 不带 OTP（若账号未开启 2FA）
npm publish --access public
```

发布成功输出示例：
```
npm notice 📦  @zhengyizhao/deploy-helper@0.2.0
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
+ @zhengyizhao/deploy-helper@0.2.0
```

## 6. 验证

```bash
# 查看 npm 上的最新版本
npm view @zhengyizhao/deploy-helper version

# 用 npx 测试（加 --yes 跳过确认）
npx --yes @zhengyizhao/deploy-helper@latest --version
```
