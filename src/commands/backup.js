import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import path from 'path';
import fs from 'fs';
import { connectSSH, runRemoteSilent } from '../utils/ssh.js';
import { loadConfig, saveConfig } from '../utils/config.js';

const BACKUP_BASE = '/var/deploy-helper/db-backups';

/**
 * 根据数据库类型生成备份命令
 */
function buildDumpCommand(dbConfig, outputFile) {
  const { type, host, port, user, password, database } = dbConfig;
  const h = host || '127.0.0.1';

  if (type === 'mysql') {
    const p = port || 3306;
    return `MYSQL_PWD='${password}' mysqldump -h ${h} -P ${p} -u ${user} ${database} > ${outputFile}`;
  }
  if (type === 'postgresql') {
    const p = port || 5432;
    return `PGPASSWORD='${password}' pg_dump -h ${h} -p ${p} -U ${user} ${database} > ${outputFile}`;
  }
  if (type === 'mongodb') {
    const p = port || 27017;
    const auth = password ? `--username ${user} --password '${password}' --authenticationDatabase admin` : '';
    return `mongodump --host ${h} --port ${p} ${auth} --db ${database} --archive=${outputFile} --gzip`;
  }
  return null;
}

/**
 * 列出现有备份
 */
async function listBackups(ssh, appName) {
  const result = await runRemoteSilent(
    ssh,
    `ls -lt ${BACKUP_BASE}/${appName}/ 2>/dev/null | grep -E "\\.(sql|gz|archive)" | head -20 || echo ""`
  );
  if (!result.stdout.trim()) return [];

  return result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    const filename = parts[parts.length - 1];
    const size = parts[4];
    return { filename, size, line };
  });
}

export async function deployBackup() {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('\n没有找到部署配置，请先运行：') + chalk.cyan(' deploy-helper init\n'));
    return;
  }

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: '数据库备份操作：',
    choices: [
      { name: '立即备份数据库', value: 'backup' },
      { name: '查看历史备份列表', value: 'list' },
      { name: '下载备份文件到本地', value: 'download' },
      { name: '配置定时自动备份', value: 'schedule' },
    ],
  }]);

  if (action === 'backup') await doBackup(config);
  else if (action === 'list') await listBackupFiles(config);
  else if (action === 'download') await downloadBackup(config);
  else if (action === 'schedule') await scheduleBackup(config);
}

async function doBackup(config, silent = false) {
  // 读取或询问数据库配置
  let dbConfig = config.database;

  if (!dbConfig) {
    if (!silent) {
      console.log(chalk.gray('\n首次使用，需要配置数据库连接信息。配置将保存到 .deploy-config.json\n'));
    }
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'type',
        message: '数据库类型：',
        choices: [
          { name: 'MySQL / MariaDB', value: 'mysql' },
          { name: 'PostgreSQL', value: 'postgresql' },
          { name: 'MongoDB', value: 'mongodb' },
        ],
      },
      { type: 'input', name: 'host', message: '数据库地址：', default: '127.0.0.1' },
      { type: 'input', name: 'port', message: '端口：', default: (a) => ({ mysql: '3306', postgresql: '5432', mongodb: '27017' }[a.type]) },
      { type: 'input', name: 'user', message: '用户名：', default: 'root' },
      { type: 'password', name: 'password', message: '密码：', mask: '*' },
      { type: 'input', name: 'database', message: '数据库名：', validate: v => v.trim() ? true : '请输入数据库名' },
    ]);
    dbConfig = answers;

    // 保存到 config
    const updated = { ...config, database: dbConfig };
    saveConfig(updated);
  }

  let ssh;
  const connectSpinner = ora('连接服务器...').start();
  try {
    ssh = await connectSSH(config);
    connectSpinner.succeed('连接成功');
  } catch (err) {
    connectSpinner.fail('连接失败：' + err.message);
    return null;
  }

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = dbConfig.type === 'mongodb' ? '.archive.gz' : '.sql.gz';
    const filename = `${dbConfig.database}_${timestamp}${ext}`;
    const backupDir = `${BACKUP_BASE}/${config.appName}`;
    const outputFile = `${backupDir}/${filename}`;
    const rawFile = outputFile.replace('.gz', '');

    await runRemoteSilent(ssh, `mkdir -p ${backupDir}`);

    // 生成备份
    const dumpSpinner = ora(`备份 ${dbConfig.type} 数据库 [${dbConfig.database}]...`).start();
    const dumpCmd = buildDumpCommand(dbConfig, dbConfig.type === 'mongodb' ? outputFile : rawFile);
    const dumpResult = await runRemoteSilent(ssh, dumpCmd);

    if (dumpResult.code !== 0) {
      dumpSpinner.fail('备份失败');
      console.log(chalk.red(dumpResult.stdout));
      ssh.dispose();
      return null;
    }

    // MySQL/PostgreSQL 压缩
    if (dbConfig.type !== 'mongodb') {
      await runRemoteSilent(ssh, `gzip -f ${rawFile}`);
    }

    // 获取文件大小
    const sizeResult = await runRemoteSilent(ssh, `du -sh ${outputFile} | cut -f1`);
    dumpSpinner.succeed(`备份完成 → ${chalk.cyan(filename)} ${chalk.gray('(' + sizeResult.stdout + ')')}`);

    // 只保留最近 10 个备份
    await runRemoteSilent(
      ssh,
      `ls -t ${backupDir} | tail -n +11 | xargs -I{} rm -f ${backupDir}/{} 2>/dev/null || true`
    );

    ssh.dispose();
    return { filename, outputFile };

  } catch (err) {
    console.log(chalk.red('\n备份失败：' + err.message));
    ssh.dispose();
    return null;
  }
}

async function listBackupFiles(config) {
  let ssh;
  const spinner = ora('连接服务器...').start();
  try {
    ssh = await connectSSH(config);
    spinner.succeed('连接成功');
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  const backups = await listBackups(ssh, config.appName);
  ssh.dispose();

  if (backups.length === 0) {
    console.log(chalk.yellow('\n还没有任何备份记录。\n'));
    return;
  }

  console.log(chalk.bold(`\n  历史备份（共 ${backups.length} 个）：\n`));
  backups.forEach(({ filename, size }, i) => {
    const prefix = i === 0 ? chalk.green('  ● ') : chalk.gray('  ○ ');
    console.log(prefix + chalk.cyan(filename) + chalk.gray(`  ${size}`));
  });
  console.log('');
}

async function downloadBackup(config) {
  let ssh;
  const spinner = ora('连接服务器...').start();
  try {
    ssh = await connectSSH(config);
    spinner.succeed('连接成功');
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  const backups = await listBackups(ssh, config.appName);

  if (backups.length === 0) {
    console.log(chalk.yellow('\n没有备份文件可下载。先运行备份。\n'));
    ssh.dispose();
    return;
  }

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: '选择要下载的备份：',
    choices: backups.map(b => ({
      name: `${b.filename}  ${chalk.gray(b.size)}`,
      value: b.filename,
    })),
  }]);

  const localPath = path.join(process.cwd(), selected);
  const remotePath = `${BACKUP_BASE}/${config.appName}/${selected}`;

  const dlSpinner = ora(`下载 ${selected}...`).start();
  try {
    await ssh.getFile(localPath, remotePath);
    dlSpinner.succeed(`已下载到：${chalk.cyan(localPath)}`);
  } catch (err) {
    dlSpinner.fail('下载失败：' + err.message);
  }

  ssh.dispose();
}

async function scheduleBackup(config) {
  const { frequency } = await inquirer.prompt([{
    type: 'list',
    name: 'frequency',
    message: '备份频率：',
    choices: [
      { name: '每天凌晨 2 点', value: '0 2 * * *' },
      { name: '每 6 小时', value: '0 */6 * * *' },
      { name: '每周一凌晨 2 点', value: '0 2 * * 1' },
      { name: '自定义 Cron 表达式', value: 'custom' },
    ],
  }]);

  let cronExpr = frequency;
  if (frequency === 'custom') {
    const { custom } = await inquirer.prompt([{
      type: 'input',
      name: 'custom',
      message: 'Cron 表达式（如 "0 3 * * *" 表示每天 3 点）：',
      validate: v => v.trim().split(/\s+/).length === 5 ? true : '请输入正确的 5 段 Cron 表达式',
    }]);
    cronExpr = custom;
  }

  let ssh;
  const spinner = ora('配置定时备份...').start();
  try {
    ssh = await connectSSH(config);
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  try {
    const dbConfig = config.database;
    if (!dbConfig) {
      spinner.fail('未配置数据库信息，请先运行一次备份完成配置。');
      ssh.dispose();
      return;
    }

    const backupDir = `${BACKUP_BASE}/${config.appName}`;
    const ext = dbConfig.type === 'mongodb' ? '.archive.gz' : '.sql.gz';

    // 生成备份脚本
    const scriptContent = `#!/bin/bash
TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
OUTFILE="${backupDir}/${dbConfig.database}_\${TIMESTAMP}${ext}"
mkdir -p ${backupDir}
${buildDumpCommand(dbConfig, dbConfig.type === 'mongodb' ? '$OUTFILE' : '${OUTFILE%.gz}')}
${dbConfig.type !== 'mongodb' ? `gzip -f "\${OUTFILE%.gz}"` : ''}
ls -t ${backupDir} | tail -n +11 | xargs -I{} rm -f ${backupDir}/{} 2>/dev/null
echo "[$(date)] Backup completed: \$OUTFILE" >> /var/log/deploy-helper-backup.log
`;

    const scriptPath = `/usr/local/bin/deploy-helper-backup-${config.appName}.sh`;
    await runRemoteSilent(ssh, `cat > ${scriptPath} << 'SCRIPT_EOF'\n${scriptContent}\nSCRIPT_EOF`);
    await runRemoteSilent(ssh, `chmod +x ${scriptPath}`);

    // 注入 crontab
    await runRemoteSilent(
      ssh,
      `(crontab -l 2>/dev/null | grep -v "deploy-helper-backup-${config.appName}"; echo "${cronExpr} ${scriptPath}") | crontab -`
    );

    spinner.succeed('定时备份配置完成');
    console.log(chalk.gray(`  Cron: ${cronExpr}`));
    console.log(chalk.gray(`  日志: /var/log/deploy-helper-backup.log\n`));
    ssh.dispose();

  } catch (err) {
    spinner.fail('配置失败：' + err.message);
    ssh.dispose();
  }
}

// 供 update.js 调用：部署前自动备份
export { doBackup };
