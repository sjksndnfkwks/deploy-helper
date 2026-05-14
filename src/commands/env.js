import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { connectSSH, runRemoteSilent } from '../utils/ssh.js';
import { loadConfig } from '../utils/config.js';

const ENV_BACKUP_DIR = '/var/deploy-helper/env-backups';

/**
 * 简单对称加密（AES-256-GCM），用于传输时保护内容
 */
function encryptContent(text, key) {
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(key, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

function decryptContent(encryptedBase64, key) {
  const data = Buffer.from(encryptedBase64, 'base64');
  const salt = data.slice(0, 16);
  const iv = data.slice(16, 28);
  const tag = data.slice(28, 44);
  const encrypted = data.slice(44);
  const derivedKey = crypto.scryptSync(key, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

/**
 * 解析 .env 文件，返回键值对数组（过滤注释和空行）
 */
function parseEnvFile(content) {
  return content
    .split('\n')
    .map((line, i) => ({ line: line.trim(), num: i + 1 }))
    .filter(({ line }) => line && !line.startsWith('#'))
    .map(({ line, num }) => {
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return null;
      const key = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      return { key, value, num };
    })
    .filter(Boolean);
}

/**
 * 展示 .env 内容预览（隐藏敏感值）
 */
function previewEnv(vars) {
  console.log(chalk.bold('\n  .env 文件内容预览：\n'));
  vars.forEach(({ key, value }) => {
    const isSensitive = /secret|password|key|token|pwd|pass/i.test(key);
    const displayVal = isSensitive
      ? chalk.gray(value.slice(0, 3) + '***' + value.slice(-2))
      : chalk.gray(value.length > 40 ? value.slice(0, 40) + '...' : value);
    console.log(`    ${chalk.cyan(key)}=${displayVal}`);
  });
  console.log('');
}

export async function deployEnv() {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('\n没有找到部署配置，请先运行：') + chalk.cyan(' deploy-helper init\n'));
    return;
  }

  // 检查本地 .env 是否存在
  const localEnvPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(localEnvPath)) {
    console.log(chalk.yellow('\n本地没有找到 .env 文件。'));
    const { create } = await inquirer.prompt([{
      type: 'confirm',
      name: 'create',
      message: '是否从服务器拉取现有的 .env？',
      default: true,
    }]);
    if (create) {
      await pullEnv(config);
    }
    return;
  }

  const envContent = fs.readFileSync(localEnvPath, 'utf-8');
  const vars = parseEnvFile(envContent);

  if (vars.length === 0) {
    console.log(chalk.yellow('\n.env 文件是空的或只有注释。\n'));
    return;
  }

  previewEnv(vars);

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: '要做什么？',
    choices: [
      { name: '上传本地 .env 到服务器（覆盖）', value: 'push' },
      { name: '从服务器拉取 .env 到本地', value: 'pull' },
      { name: '对比本地和服务器的 .env 差异', value: 'diff' },
    ],
  }]);

  if (action === 'push') await pushEnv(config, envContent, vars);
  else if (action === 'pull') await pullEnv(config);
  else if (action === 'diff') await diffEnv(config, vars);
}

async function pushEnv(config, envContent, vars) {
  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: `确认上传 ${vars.length} 个变量到服务器 ${config.host}？（将覆盖服务器上现有的 .env）`,
    default: true,
  }]);
  if (!confirm) return;

  let ssh;
  const spinner = ora('连接服务器...').start();
  try {
    ssh = await connectSSH(config);
    spinner.succeed('连接成功');
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  try {
    // 备份服务器现有 .env
    const backupSpinner = ora('备份服务器现有 .env...').start();
    await runRemoteSilent(ssh, `mkdir -p ${ENV_BACKUP_DIR}`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await runRemoteSilent(
      ssh,
      `[ -f ${config.remotePath}/.env ] && cp ${config.remotePath}/.env ${ENV_BACKUP_DIR}/.env_${config.appName}_${timestamp} || true`
    );
    backupSpinner.succeed('已备份旧 .env');

    // 上传新 .env（通过 SSH 直接写入，不走文件上传避免明文落盘）
    const uploadSpinner = ora('上传 .env 到服务器...').start();
    const escaped = envContent.replace(/'/g, "'\\''");
    await runRemoteSilent(ssh, `cat > ${config.remotePath}/.env << 'DEPLOY_HELPER_EOF'\n${escaped}\nDEPLOY_HELPER_EOF`);
    await runRemoteSilent(ssh, `chmod 600 ${config.remotePath}/.env`);
    uploadSpinner.succeed('.env 上传完成，权限已设为 600');

    // 重启服务让新环境变量生效
    const { restart } = await inquirer.prompt([{
      type: 'confirm',
      name: 'restart',
      message: '是否重启服务让新变量生效？',
      default: true,
    }]);

    if (restart) {
      const restartSpinner = ora('重启服务...').start();
      if (config.projectType === 'nodejs') {
        await runRemoteSilent(ssh, `pm2 restart ${config.appName}`);
      } else if (config.projectType === 'python') {
        await runRemoteSilent(ssh, `supervisorctl restart ${config.appName}`);
      } else if (config.projectType === 'docker') {
        await runRemoteSilent(ssh, `cd ${config.remotePath} && docker compose up -d`);
      }
      restartSpinner.succeed('服务已重启');
    }

    ssh.dispose();
    console.log(chalk.green.bold('\n✅ .env 同步完成！\n'));

  } catch (err) {
    console.log(chalk.red('\n上传失败：' + err.message));
    ssh.dispose();
  }
}

async function pullEnv(config) {
  let ssh;
  const spinner = ora('连接服务器...').start();
  try {
    ssh = await connectSSH(config);
    spinner.succeed('连接成功');
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  try {
    const result = await runRemoteSilent(ssh, `cat ${config.remotePath}/.env 2>/dev/null || echo ""`);
    ssh.dispose();

    if (!result.stdout.trim()) {
      console.log(chalk.yellow('\n服务器上没有 .env 文件。\n'));
      return;
    }

    const localEnvPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(localEnvPath)) {
      const { overwrite } = await inquirer.prompt([{
        type: 'confirm',
        name: 'overwrite',
        message: '本地已有 .env，确认覆盖？',
        default: false,
      }]);
      if (!overwrite) return;
    }

    fs.writeFileSync(localEnvPath, result.stdout);
    console.log(chalk.green.bold('\n✅ 已从服务器拉取 .env 到本地。\n'));

  } catch (err) {
    console.log(chalk.red('\n拉取失败：' + err.message));
    ssh.dispose();
  }
}

async function diffEnv(config, localVars) {
  let ssh;
  const spinner = ora('获取服务器 .env...').start();
  try {
    ssh = await connectSSH(config);
    const result = await runRemoteSilent(ssh, `cat ${config.remotePath}/.env 2>/dev/null || echo ""`);
    ssh.dispose();
    spinner.succeed('获取完成');

    const remoteVars = parseEnvFile(result.stdout);
    const localMap = Object.fromEntries(localVars.map(v => [v.key, v.value]));
    const remoteMap = Object.fromEntries(remoteVars.map(v => [v.key, v.value]));

    const allKeys = new Set([...Object.keys(localMap), ...Object.keys(remoteMap)]);

    console.log(chalk.bold('\n  差异对比（本地 vs 服务器）：\n'));
    let hasDiff = false;

    for (const key of allKeys) {
      if (!(key in localMap)) {
        console.log(chalk.red(`  - ${key}`) + chalk.gray('（仅服务器有）'));
        hasDiff = true;
      } else if (!(key in remoteMap)) {
        console.log(chalk.green(`  + ${key}`) + chalk.gray('（仅本地有）'));
        hasDiff = true;
      } else if (localMap[key] !== remoteMap[key]) {
        console.log(chalk.yellow(`  ~ ${key}`) + chalk.gray('（值不同）'));
        hasDiff = true;
      }
    }

    if (!hasDiff) {
      console.log(chalk.green('  本地和服务器 .env 完全一致 ✓'));
    }
    console.log('');

  } catch (err) {
    spinner.fail('获取失败：' + err.message);
  }
}
