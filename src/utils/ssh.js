import { NodeSSH } from 'node-ssh';
import chalk from 'chalk';
import fs from 'fs';

export async function connectSSH(config) {
  const ssh = new NodeSSH();

  const connectOptions = {
    host: config.host,
    port: config.port || 22,
    username: config.user,
    // 安装依赖、交互问答可能持续数分钟，开启心跳防止服务器 idle 超时断连
    keepaliveInterval: 15000,
    keepaliveCountMax: 8,
    readyTimeout: 30000,
  };

  if (config.authType === 'key') {
    connectOptions.privateKeyPath = config.keyPath;
  } else {
    connectOptions.password = config.password;
  }

  await ssh.connect(connectOptions);

  // 权限检测：root 直接用；非 root 需免密 sudo；两者都没有则无法部署
  ssh.__loginUser = config.user;
  const uid = await ssh.execCommand('id -u');
  if ((uid.stdout || '').trim() === '0') {
    ssh.__useSudo = false;
  } else {
    const sudoCheck = await ssh.execCommand('sudo -n true 2>/dev/null && echo DH_SUDO_OK');
    if ((sudoCheck.stdout || '').includes('DH_SUDO_OK')) {
      ssh.__useSudo = true;
    } else {
      ssh.dispose();
      throw new Error(
        `用户 ${config.user} 不是 root，也没有免密 sudo 权限。\n` +
        `  部署需要 root 级权限（安装软件、写 /etc、systemctl）。请二选一：\n` +
        `  • 改用 root 用户登录；或\n` +
        `  • 为该用户配置免密 sudo（在服务器执行 visudo，加一行：${config.user} ALL=(ALL) NOPASSWD:ALL）`
      );
    }
  }

  return ssh;
}

// 非 root 登录时，把整条命令交给 root shell 执行（重定向 / heredoc 也以 root 生效）
function wrapPrivileged(ssh, command) {
  if (!ssh || !ssh.__useSudo) return command;
  return `sudo bash -c '${command.replace(/'/g, `'\\''`)}'`;
}

// 在服务器上执行命令，并实时打印输出
export async function runRemote(ssh, command, label) {
  if (label) console.log(chalk.gray(`  → ${label}`));

  const result = await ssh.execCommand(wrapPrivileged(ssh, command), {
    onStdout: (chunk) => process.stdout.write(chalk.gray('    ' + chunk.toString())),
    onStderr: (chunk) => process.stdout.write(chalk.yellow('    ' + chunk.toString())),
  });

  if (result.code !== 0 && result.code !== null) {
    throw new Error(`命令失败 (exit ${result.code}): ${command}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

// 静默执行（不打印输出）；默认不抛错，返回 { stdout, stderr, code }。
// 调用方需要根据 code 判断是否成功。
export async function runRemoteSilent(ssh, command) {
  const result = await ssh.execCommand(wrapPrivileged(ssh, command));
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code,
  };
}

// 静默执行 + 失败抛错：用于"必须成功"的步骤（如安装、启动）。
export async function runRemoteStrict(ssh, command) {
  const result = await runRemoteSilent(ssh, command);
  if (result.code !== 0 && result.code !== null) {
    const tail = (result.stderr || result.stdout || '').split('\n').slice(-6).join('\n');
    throw new Error(`命令失败 (exit ${result.code})\n${tail}`);
  }
  return result;
}

// 上传本地目录到服务器
// skipPatterns: 覆盖默认跳过列表（不传则用默认）
// uploadEnv: true 时允许上传 .env
export async function uploadDirectory(ssh, localPath, remotePath, options = {}) {
  const {
    uploadEnv = false,
    skipPatterns = ['node_modules', '.git', 'dist', '__pycache__', '.DS_Store', '.venv', 'venv'],
  } = options;

  // 非 root 登录时，SFTP 以登录用户身份写入，需先把目标目录授权给该用户
  if (ssh.__useSudo && ssh.__loginUser) {
    await runRemoteSilent(ssh, `mkdir -p ${remotePath} && chown -R ${ssh.__loginUser} ${remotePath}`);
  }

  const alwaysSkip = new Set(skipPatterns);
  const failed = [];

  await ssh.putDirectory(localPath, remotePath, {
    recursive: true,
    concurrency: 5,
    validate: (itemPath) => {
      const base = itemPath.split(/[\\/]/).pop();
      if (alwaysSkip.has(base)) return false;
      if (base === '.env' && !uploadEnv) return false;
      return true;
    },
    tick: (localFile, remoteFile, error) => {
      if (error) failed.push(localFile);
    },
  });
  if (failed.length > 0) {
    console.log(chalk.yellow(`  ⚠ 以下文件上传失败：${failed.join(', ')}`));
  }
}
