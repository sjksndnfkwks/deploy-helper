import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { connectSSH, runRemoteSilent, runRemoteStrict } from '../utils/ssh.js';
import { loadConfig, resolveCredentials } from '../utils/config.js';
import { getStartCommands, getStopCommand, getHealthCheck } from '../utils/setup.js';

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
    // 排除大目录（venv / node_modules）节省空间
    // 用 strict：rsync 失败（如未安装）必须抛错，否则会留下空快照 —— 之后回滚 --delete 会清空部署目录
    await runRemoteStrict(
      ssh,
      `command -v rsync >/dev/null 2>&1 || apt-get install -y -qq rsync; ` +
      `rsync -a --exclude=venv --exclude=node_modules --exclude=__pycache__ ${config.remotePath}/ ${snapshotPath}/`
    );

    // 记录快照元信息
    const meta = JSON.stringify({
      name: snapshotName,
      timestamp,
      appName: config.appName,
      remotePath: config.remotePath,
    });
    // 用 printf 写入小型元数据 OK（meta 是 JSON，无 % 字符）
    await runRemoteSilent(ssh, `cat > ${snapshotPath}/.snapshot-meta.json <<'DH_EOF'\n${meta}\nDH_EOF`);

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

// 根据 config 重启服务（appMode/conda/composeFile 一致）
async function restartService(ssh, config) {
  if (config.appMode === 'cron') {
    // cron 不需要"重启进程"，crontab 条目仍在；下次定时使用新代码即可
    return;
  }

  if (config.projectType === 'nodejs') {
    // 复用 init 启动逻辑，确保 .start.sh / pm2 配置与新代码匹配
    const steps = getStartCommands(config);
    for (const s of steps) {
      await runRemoteStrict(ssh, s.cmd);
    }
    return;
  }

  if (config.projectType === 'python') {
    // 已有 supervisor 配置和 venv/conda 环境，直接重启进程即可
    await runRemoteStrict(ssh, `supervisorctl restart ${config.appName}`);
    return;
  }

  if (config.projectType === 'docker') {
    if (config.composeFile) {
      await runRemoteStrict(ssh, `cd ${config.remotePath} && docker compose -f ${config.composeFile} up -d --build`);
    } else {
      // 单容器：重新构建并启动
      const steps = getStartCommands(config);
      for (const s of steps) {
        await runRemoteStrict(ssh, s.cmd);
      }
    }
    return;
  }

  if (config.projectType === 'static') {
    await runRemoteStrict(ssh, `chown -R www-data:www-data ${config.remotePath}`);
  }
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

  await resolveCredentials(config);

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

    // 停止服务（cron 模式跳过）
    const stopCmd = getStopCommand(config);
    if (stopCmd) {
      const stopSpinner = ora('停止当前服务...').start();
      await runRemoteSilent(ssh, stopCmd);
      stopSpinner.succeed('服务已停止');
    }

    // 替换代码目录（保留 venv —— 快照排除了它，避免误删环境）
    const restoreSpinner = ora(`还原版本 ${selectedSnapshot}...`).start();
    // 还原前先确认快照非空，避免 rsync --delete 把部署目录清空
    const snapCheck = await runRemoteSilent(
      ssh,
      `find ${SNAPSHOTS_DIR}/${selectedSnapshot} -type f -not -name .snapshot-meta.json | head -1`
    );
    if (!snapCheck.stdout.trim()) {
      restoreSpinner.fail('所选快照为空，已中止还原以防数据丢失');
      throw new Error(`快照 ${selectedSnapshot} 不含任何文件`);
    }
    // 保留 venv / node_modules，只覆盖代码部分；strict：还原失败必须抛错
    await runRemoteStrict(
      ssh,
      `rsync -a --delete --exclude=venv --exclude=node_modules ${SNAPSHOTS_DIR}/${selectedSnapshot}/ ${config.remotePath}/`
    );
    await runRemoteSilent(ssh, `rm -f ${config.remotePath}/.snapshot-meta.json`);
    restoreSpinner.succeed('版本已还原');

    // 重启服务
    const startSpinner = ora('重启服务...').start();
    try {
      await restartService(ssh, config);
      startSpinner.succeed('服务已重启');
    } catch (err) {
      startSpinner.fail('重启失败：' + err.message);
      throw err;
    }

    // 健康检查
    const health = getHealthCheck(config);
    if (health) {
      const hSpinner = ora('验证服务运行状态...').start();
      await runRemoteSilent(ssh, 'sleep 2');
      const result = await runRemoteSilent(ssh, health.cmd);
      const parsed = health.parse(result);
      if (parsed.ok) {
        hSpinner.succeed(`服务正常 — ${chalk.gray(parsed.detail)}`);
      } else {
        hSpinner.warn(`健康检查未通过 — ${chalk.yellow(parsed.detail)}`);
      }
    }

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
