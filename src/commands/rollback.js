import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { connectSSH, runRemoteSilent } from '../utils/ssh.js';
import { loadConfig, saveConfig } from '../utils/config.js';

const SNAPSHOTS_DIR = '/var/deploy-helper/snapshots';

/**
 * 部署时调用：把当前版本打快照存起来
 * 保留最近 5 个版本，多余的自动删除
 */
export async function createSnapshot(ssh, config) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapshotName = `${config.appName}_${timestamp}`;
  const snapshotPath = `${SNAPSHOTS_DIR}/${snapshotName}`;

  await runRemoteSilent(ssh, `mkdir -p ${SNAPSHOTS_DIR}`);

  // 如果当前部署目录存在，就复制一份作为快照
  const exists = await runRemoteSilent(ssh, `test -d ${config.remotePath} && echo yes || echo no`);
  if (exists.stdout.trim() === 'yes') {
    await runRemoteSilent(ssh, `cp -r ${config.remotePath} ${snapshotPath}`);

    // 记录快照元信息
    const meta = JSON.stringify({
      name: snapshotName,
      timestamp,
      appName: config.appName,
      remotePath: config.remotePath,
    });
    await runRemoteSilent(ssh, `echo '${meta}' > ${snapshotPath}/.snapshot-meta.json`);

    // 只保留最近 5 个快照
    await runRemoteSilent(
      ssh,
      `ls -t ${SNAPSHOTS_DIR} | grep "^${config.appName}_" | tail -n +6 | xargs -I{} rm -rf ${SNAPSHOTS_DIR}/{}`
    );

    return snapshotName;
  }
  return null;
}

/**
 * 列出服务器上的所有快照
 */
async function listSnapshots(ssh, config) {
  const result = await runRemoteSilent(
    ssh,
    `ls -t ${SNAPSHOTS_DIR} 2>/dev/null | grep "^${config.appName}_" || echo ""`
  );
  const names = result.stdout.trim().split('\n').filter(Boolean);

  const snapshots = [];
  for (const name of names) {
    const metaResult = await runRemoteSilent(
      ssh,
      `cat ${SNAPSHOTS_DIR}/${name}/.snapshot-meta.json 2>/dev/null || echo "{}"`
    );
    try {
      const meta = JSON.parse(metaResult.stdout);
      snapshots.push({ name, ...meta });
    } catch {
      snapshots.push({ name, timestamp: name.replace(`${config.appName}_`, '') });
    }
  }
  return snapshots;
}

/**
 * rollback 命令主体
 */
export async function deployRollback() {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('\n没有找到部署配置，请先运行：') + chalk.cyan(' deploy-helper init\n'));
    return;
  }

  let ssh;
  const spinner = ora('连接服务器...').start();
  try {
    ssh = await connectSSH(config);
    spinner.succeed('连接成功');
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  // 获取快照列表
  const listSpinner = ora('获取历史版本列表...').start();
  const snapshots = await listSnapshots(ssh, config);
  listSpinner.stop();

  if (snapshots.length === 0) {
    console.log(chalk.yellow('\n没有找到任何历史快照。'));
    console.log(chalk.gray('提示：从下次部署开始会自动创建快照。\n'));
    ssh.dispose();
    return;
  }

  // 展示快照列表供用户选择
  console.log(chalk.bold(`\n找到 ${snapshots.length} 个历史版本：\n`));

  const choices = snapshots.map((s, i) => {
    const date = s.timestamp
      ? new Date(s.timestamp.replace(/-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')).toLocaleString('zh-CN')
      : s.timestamp;
    const label = i === 0 ? chalk.gray(' ← 上一个版本') : '';
    return {
      name: `${chalk.cyan(s.name)}  ${chalk.gray(date)}${label}`,
      value: s.name,
      short: s.name,
    };
  });

  const { selectedSnapshot } = await inquirer.prompt([{
    type: 'list',
    name: 'selectedSnapshot',
    message: '选择要回滚到的版本：',
    choices,
  }]);

  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: chalk.yellow(`确认回滚？当前版本将被替换，此操作不可撤销。`),
    default: false,
  }]);

  if (!confirm) {
    console.log(chalk.gray('\n已取消回滚。\n'));
    ssh.dispose();
    return;
  }

  // 执行回滚
  console.log('');
  try {
    // 把当前版本也存一个"回滚前"的快照
    const preRollbackSpinner = ora('备份当前版本...').start();
    await createSnapshot(ssh, config);
    preRollbackSpinner.succeed('当前版本已备份');

    // 停止服务
    const stopSpinner = ora('停止当前服务...').start();
    if (config.projectType === 'nodejs') {
      await runRemoteSilent(ssh, `pm2 stop ${config.appName} 2>/dev/null || true`);
    } else if (config.projectType === 'python') {
      await runRemoteSilent(ssh, `supervisorctl stop ${config.appName} 2>/dev/null || true`);
    } else if (config.projectType === 'docker') {
      await runRemoteSilent(ssh, `cd ${config.remotePath} && docker compose down 2>/dev/null || true`);
    }
    stopSpinner.succeed('服务已停止');

    // 替换代码目录
    const restoreSpinner = ora(`还原版本 ${selectedSnapshot}...`).start();
    await runRemoteSilent(ssh, `rm -rf ${config.remotePath}`);
    await runRemoteSilent(ssh, `cp -r ${SNAPSHOTS_DIR}/${selectedSnapshot} ${config.remotePath}`);
    await runRemoteSilent(ssh, `rm -f ${config.remotePath}/.snapshot-meta.json`);
    restoreSpinner.succeed('版本已还原');

    // 重启服务
    const startSpinner = ora('重启服务...').start();
    if (config.projectType === 'nodejs') {
      await runRemoteSilent(ssh, `cd ${config.remotePath} && pm2 restart ${config.appName} || pm2 start ${config.startCmd} --name ${config.appName}`);
    } else if (config.projectType === 'python') {
      await runRemoteSilent(ssh, `supervisorctl start ${config.appName}`);
    } else if (config.projectType === 'docker') {
      await runRemoteSilent(ssh, `cd ${config.remotePath} && docker compose up -d`);
    } else if (config.projectType === 'static') {
      await runRemoteSilent(ssh, `chown -R www-data:www-data ${config.remotePath}`);
    }
    startSpinner.succeed('服务已重启');

    ssh.dispose();
    console.log(chalk.green.bold('\n✅ 回滚成功！'));
    console.log(chalk.gray(`  已恢复到版本：${selectedSnapshot}\n`));

  } catch (err) {
    console.log(chalk.red('\n回滚失败：' + err.message));
    ssh.dispose();
  }
}

// 导出给 update.js 调用
export { connectSSH } from '../utils/ssh.js';
