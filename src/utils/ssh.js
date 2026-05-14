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

// 静默执行（不打印输出）
export async function runRemoteSilent(ssh, command) {
  const result = await ssh.execCommand(command);
  return { stdout: result.stdout.trim(), code: result.code };
}

// 上传本地目录到服务器
export async function uploadDirectory(ssh, localPath, remotePath, ora) {
  const failed = [];
  await ssh.putDirectory(localPath, remotePath, {
    recursive: true,
    concurrency: 5,
    validate: (itemPath) => {
      const base = itemPath.split('/').pop();
      // 跳过不必要的目录
      return !['node_modules', '.git', '.env', 'dist', '__pycache__', '.DS_Store'].includes(base);
    },
    tick: (localFile, remoteFile, error) => {
      if (error) failed.push(localFile);
    },
  });
  if (failed.length > 0) {
    console.log(chalk.yellow(`  ⚠ 以下文件上传失败：${failed.join(', ')}`));
  }
}
