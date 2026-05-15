import { NodeSSH } from 'node-ssh';
import chalk from 'chalk';
import fs from 'fs';

export async function connectSSH(config) {
  const ssh = new NodeSSH();

  const connectOptions = {
    host: config.host,
    port: config.port || 22,
    username: config.user,
  };

  if (config.authType === 'key') {
    connectOptions.privateKeyPath = config.keyPath;
  } else {
    connectOptions.password = config.password;
  }

  await ssh.connect(connectOptions);
  return ssh;
}

// 在服务器上执行命令，并实时打印输出
export async function runRemote(ssh, command, label) {
  if (label) console.log(chalk.gray(`  → ${label}`));

  const result = await ssh.execCommand(command, {
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
  const result = await ssh.execCommand(command);
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
