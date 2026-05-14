import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { connectSSH, runRemoteSilent } from '../utils/ssh.js';
import { loadConfig } from '../utils/config.js';

export async function deployStatus() {
  const config = loadConfig();

  if (!config) {
    console.log(chalk.red('\n没有找到部署配置，请先运行：') + chalk.cyan(' deploy-helper init\n'));
    return;
  }

  let ssh;
  const spinner = ora('连接服务器获取状态...').start();
  try {
    ssh = await connectSSH(config);
    spinner.succeed('已连接');
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  console.log(chalk.bold('\n📊 服务器状态报告\n'));

  // 系统基本信息
  const [uptime, memInfo, diskInfo] = await Promise.all([
    runRemoteSilent(ssh, "uptime -p"),
    runRemoteSilent(ssh, "free -m | awk 'NR==2{printf \"%s MB / %s MB\", $3, $2}'"),
    runRemoteSilent(ssh, "df -h / | awk 'NR==2{printf \"%s / %s (%s)\", $3, $2, $5}'"),
  ]);

  console.log(chalk.gray('  系统运行时间：') + uptime.stdout);
  console.log(chalk.gray('  内存占用：    ') + memInfo.stdout);
  console.log(chalk.gray('  磁盘占用：    ') + diskInfo.stdout);

  // 应用状态
  console.log(chalk.bold('\n  应用状态：'));

  if (config.projectType === 'nodejs') {
    const pm2Status = await runRemoteSilent(ssh, `pm2 jlist`);
    try {
      const list = JSON.parse(pm2Status.stdout);
      const app = list.find(p => p.name === config.appName);
      if (app) {
        const statusColor = app.pm2_env.status === 'online' ? chalk.green : chalk.red;
        console.log(`  ${statusColor('●')} ${config.appName}`);
        console.log(chalk.gray(`    状态：${statusColor(app.pm2_env.status)}`));
        console.log(chalk.gray(`    PID：${app.pid}`));
        console.log(chalk.gray(`    重启次数：${app.pm2_env.restart_time}`));
        console.log(chalk.gray(`    运行时间：${formatUptime(app.pm2_env.pm_uptime)}`));
        console.log(chalk.gray(`    CPU：${app.monit?.cpu ?? 0}%  内存：${Math.round((app.monit?.memory ?? 0) / 1024 / 1024)}MB`));
      } else {
        console.log(chalk.red(`  ✗ 未找到 ${config.appName}，服务可能没有运行`));
      }
    } catch {
      console.log(chalk.yellow('  无法解析 PM2 状态'));
    }

    // 最近日志
    console.log(chalk.bold('\n  最近日志（最后 20 行）：'));
    const logs = await runRemoteSilent(ssh, `pm2 logs ${config.appName} --lines 20 --nostream 2>&1 | tail -20`);
    if (logs.stdout) {
      logs.stdout.split('\n').forEach(line => {
        if (line.includes('error') || line.includes('Error')) {
          console.log(chalk.red('    ' + line));
        } else {
          console.log(chalk.gray('    ' + line));
        }
      });
    }

  } else if (config.projectType === 'python') {
    const supStatus = await runRemoteSilent(ssh, `supervisorctl status ${config.appName}`);
    console.log(chalk.gray('    ') + supStatus.stdout);

  } else if (config.projectType === 'docker') {
    const dockerStatus = await runRemoteSilent(ssh, `cd ${config.remotePath} && docker compose ps`);
    console.log(chalk.gray(dockerStatus.stdout));
  }

  // Nginx 状态
  console.log(chalk.bold('\n  Nginx 状态：'));
  const nginxStatus = await runRemoteSilent(ssh, `systemctl is-active nginx`);
  const isActive = nginxStatus.stdout.trim() === 'active';
  console.log(`  ${isActive ? chalk.green('● 运行中') : chalk.red('✗ 未运行')}`);

  // 访问地址
  const accessUrl = config.useHttps && config.domain
    ? `https://${config.domain}`
    : config.domain ? `http://${config.domain}` : `http://${config.host}`;
  console.log(chalk.bold('\n  访问地址：') + chalk.cyan.underline(accessUrl));

  console.log(chalk.gray(`\n  上次部署：${new Date(config.deployedAt).toLocaleString('zh-CN')}\n`));

  ssh.dispose();
}

function formatUptime(timestamp) {
  const ms = Date.now() - timestamp;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}小时 ${m}分钟`;
}
