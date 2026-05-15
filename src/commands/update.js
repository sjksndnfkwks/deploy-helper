import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { connectSSH, runRemoteSilent, runRemoteStrict, uploadDirectory } from '../utils/ssh.js';
import { loadConfig, saveConfig } from '../utils/config.js';
import { createSnapshot } from './rollback.js';
import { doBackup } from './backup.js';
import { getStartCommands, getHealthCheck } from '../utils/setup.js';

/**
 * 对单台服务器执行部署流程
 *
 * 流程：连接 → 快照 → 上传代码 → 复用 init 的 getStartCommands → 健康检查
 *
 * 兼容性：旧版 config 没有 appMode 字段时，根据 projectType + domain 推断：
 *   - 有 domain 或 projectType=static → web
 *   - 否则 → script（保守起见）
 */
async function deployToServer(serverConfig) {
  const label = serverConfig.label ? chalk.cyan(`[${serverConfig.label}] `) : '';
  const cfg = normalizeConfig(serverConfig);

  let ssh;
  const connectSpinner = ora(`${label}连接服务器 ${cfg.host}...`).start();
  try {
    ssh = await connectSSH(cfg);
    connectSpinner.succeed(`${label}连接成功`);
  } catch (err) {
    connectSpinner.fail(`${label}连接失败：${err.message}`);
    return false;
  }

  try {
    // 1. 创建快照（部署前备份当前版本）
    const snapSpinner = ora(`${label}创建版本快照...`).start();
    const snapName = await createSnapshot(ssh, cfg);
    if (snapName) {
      snapSpinner.succeed(`${label}快照已创建：${chalk.gray(snapName)}`);
    } else {
      snapSpinner.info(`${label}跳过快照（首次部署）`);
    }

    // 2. 上传代码（static 不跳 dist，并透传 uploadEnv）
    const uploadSpinner = ora(`${label}上传代码...`).start();
    const skipPatterns = cfg.projectType === 'static'
      ? ['node_modules', '.git', '__pycache__', '.DS_Store', '.venv', 'venv']
      : undefined;
    await uploadDirectory(ssh, process.cwd(), cfg.remotePath, {
      uploadEnv: !!cfg.uploadEnv,
      skipPatterns,
    });
    uploadSpinner.succeed(`${label}代码上传完成`);

    // 3. 复用 init 的启动命令（保证 update 与 init 行为一致）
    const startSteps = getStartCommands(cfg);
    for (const s of startSteps) {
      const sp = ora(`${label}${s.label}...`).start();
      try {
        await runRemoteStrict(ssh, s.cmd);
        sp.succeed(`${label}${s.label}`);
      } catch (err) {
        sp.fail(`${label}${s.label} 失败`);
        throw err;
      }
    }

    // 4. 健康检查
    const health = getHealthCheck(cfg);
    if (health) {
      const hSpinner = ora(`${label}验证服务运行状态...`).start();
      await runRemoteSilent(ssh, 'sleep 2');
      const result = await runRemoteSilent(ssh, health.cmd);
      const parsed = health.parse(result);
      if (parsed.ok) {
        hSpinner.succeed(`${label}服务正常 — ${chalk.gray(parsed.detail)}`);
      } else {
        hSpinner.warn(`${label}健康检查未通过 — ${chalk.yellow(parsed.detail)}`);
        console.log(chalk.gray(`  ${label}如服务异常，可运行 deploy-helper rollback 回滚`));
      }
    }

    ssh.dispose();
    return true;

  } catch (err) {
    console.log(chalk.red(`\n${label}部署失败：${err.message}`));
    console.log(chalk.gray(`  运行 ${chalk.cyan('deploy-helper rollback')} 可恢复上一个版本`));
    ssh.dispose();
    return false;
  }
}

// 旧配置兼容：补齐 appMode 等新字段，方便老用户升级 deploy-helper 后 update
function normalizeConfig(serverConfig) {
  const cfg = { ...serverConfig };
  if (!cfg.appMode) {
    // 老配置：有 domain / useHttps 或是 static 都视为 web
    cfg.appMode = (cfg.domain || cfg.useHttps || cfg.projectType === 'static') ? 'web' : 'web';
  }
  if (cfg.projectType === 'python' && !cfg.pythonEnvManager) {
    cfg.pythonEnvManager = 'pip';
  }
  return cfg;
}

export async function deployUpdate() {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('\n没有找到部署配置，请先运行：') + chalk.cyan(' deploy-helper init\n'));
    return;
  }

  // 兼容单台和多台服务器配置
  const servers = config.servers
    ? config.servers
    : [{ ...config, label: null }];

  // 显示目标信息
  console.log('');
  if (servers.length === 1) {
    console.log(chalk.gray('  ℹ ') + `服务器：${servers[0].host}   应用：${config.appName}   模式：${config.appMode || 'web'}`);
  } else {
    console.log(chalk.gray('  ℹ ') + `将部署到 ${chalk.bold(servers.length)} 台服务器：`);
    servers.forEach(s => {
      console.log(chalk.gray(`    • ${s.label || s.host}  (${s.host})`));
    });
  }

  // 询问部署选项
  const promptList = [
    {
      type: 'confirm',
      name: 'confirm',
      message: '确认推送当前代码到服务器？',
      default: true,
    },
    {
      type: 'confirm',
      name: 'backupDb',
      message: '部署前备份数据库？',
      default: true,
      when: (a) => a.confirm && !!config.database,
    },
  ];

  if (servers.length > 1) {
    promptList.push({
      type: 'list',
      name: 'strategy',
      message: '多服务器部署策略：',
      choices: [
        { name: '并行（同时部署所有服务器，速度最快）', value: 'parallel' },
        { name: '串行（逐台部署，出错可停止）', value: 'serial' },
        { name: '滚动（每台完成后确认再继续下一台）', value: 'rolling' },
      ],
      when: (a) => a.confirm,
    });
  }

  const options = await inquirer.prompt(promptList);
  if (!options.confirm) return;

  console.log('');

  // 部署前数据库备份
  if (options.backupDb && config.database) {
    console.log(chalk.bold('📦 部署前数据库备份\n'));
    await doBackup(config, true);
    console.log('');
  }

  // 执行部署
  console.log(chalk.bold('🚀 开始部署\n'));
  const strategy = options.strategy || 'serial';
  const results = [];

  if (servers.length === 1 || strategy === 'parallel') {
    const outcomes = await Promise.all(servers.map(s => deployToServer(s)));
    results.push(...outcomes);

  } else if (strategy === 'serial') {
    for (const server of servers) {
      const ok = await deployToServer(server);
      results.push(ok);
      if (!ok) {
        const { continueAnyway } = await inquirer.prompt([{
          type: 'confirm',
          name: 'continueAnyway',
          message: chalk.yellow(`${server.label || server.host} 失败，继续其余服务器？`),
          default: false,
        }]);
        if (!continueAnyway) break;
      }
    }

  } else if (strategy === 'rolling') {
    for (let i = 0; i < servers.length; i++) {
      const ok = await deployToServer(servers[i]);
      results.push(ok);
      if (ok && i < servers.length - 1) {
        const { goNext } = await inquirer.prompt([{
          type: 'confirm',
          name: 'goNext',
          message: `继续下一台 ${servers[i + 1].label || servers[i + 1].host}？`,
          default: true,
        }]);
        if (!goNext) break;
      }
    }
  }

  // 汇总
  const successCount = results.filter(Boolean).length;
  const failCount = results.length - successCount;

  console.log('');
  if (failCount === 0) {
    console.log(chalk.green.bold(`✅ 全部 ${successCount} 台服务器部署成功！`));
  } else {
    console.log(chalk.yellow.bold(`⚠  ${successCount} 台成功，${failCount} 台失败`));
    console.log(chalk.gray('  运行 deploy-helper rollback 可回滚'));
  }

  const main = servers[0];
  if (main.appMode === 'web' || !main.appMode) {
    const url = main.useHttps && main.domain
      ? `https://${main.domain}`
      : main.domain ? `http://${main.domain}` : `http://${main.host}`;
    console.log(`  访问地址：${chalk.cyan.underline(url)}\n`);
  } else if (main.appMode === 'cron') {
    console.log(`  定时计划：${chalk.cyan(main.cronSchedule || '见 crontab -l')}\n`);
  } else {
    console.log(`  进程状态：${chalk.cyan(`supervisorctl status ${main.appName}`)}\n`);
  }
}

/**
 * 多服务器配置管理命令
 */
export async function manageServers() {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('\n没有找到部署配置，请先运行：') + chalk.cyan(' deploy-helper init\n'));
    return;
  }

  const servers = config.servers || [{ ...config, label: '主服务器' }];

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: '服务器管理：',
    choices: [
      { name: `查看列表（当前 ${servers.length} 台）`, value: 'list' },
      { name: '添加服务器', value: 'add' },
      { name: '删除服务器', value: 'remove' },
    ],
  }]);

  if (action === 'list') {
    console.log(chalk.bold(`\n  服务器列表（${servers.length} 台）：\n`));
    servers.forEach((s, i) => {
      console.log(`  ${chalk.cyan(i + 1 + '.')} ${chalk.bold(s.label || s.host)}`);
      console.log(chalk.gray(`     ${s.user}@${s.host}:${s.port || 22}  →  ${s.remotePath}`));
    });
    console.log('');

  } else if (action === 'add') {
    const newServer = await inquirer.prompt([
      { type: 'input', name: 'label', message: '服务器别名（如"备用节点"）：' },
      { type: 'input', name: 'host', message: 'IP 地址：', validate: v => v.trim() ? true : '必填' },
      { type: 'input', name: 'port', message: 'SSH 端口：', default: '22' },
      { type: 'input', name: 'user', message: '用户名：', default: config.user || 'root' },
      {
        type: 'list', name: 'authType', message: '登录方式：',
        choices: [{ name: 'SSH 密钥', value: 'key' }, { name: '密码', value: 'password' }],
        default: config.authType,
      },
      {
        type: 'input', name: 'keyPath', message: 'SSH 密钥路径：',
        default: config.keyPath, when: a => a.authType === 'key',
      },
      {
        type: 'password', name: 'password', message: '密码：',
        mask: '*', when: a => a.authType === 'password',
      },
      { type: 'input', name: 'remotePath', message: '部署路径：', default: config.remotePath },
    ]);

    const sp = ora('测试连接...').start();
    try {
      const ssh = await connectSSH({ ...config, ...newServer });
      ssh.dispose();
      sp.succeed('连接测试成功');
    } catch (err) {
      sp.fail('连接测试失败：' + err.message);
      return;
    }

    const updatedServers = [...servers, { ...config, ...newServer }];
    saveConfig({ ...config, servers: updatedServers });
    console.log(chalk.green(`\n✅ 服务器 "${newServer.label || newServer.host}" 已添加。\n`));

  } else if (action === 'remove') {
    if (servers.length === 1) {
      console.log(chalk.yellow('\n只剩一台服务器，无法删除。\n'));
      return;
    }
    const { toRemove } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'toRemove',
      message: '选择要删除的服务器：',
      choices: servers.map((s, i) => ({ name: `${s.label || s.host} (${s.host})`, value: i })),
    }]);
    const remaining = servers.filter((_, i) => !toRemove.includes(i));
    saveConfig({ ...config, servers: remaining });
    console.log(chalk.green(`\n✅ 已删除 ${toRemove.length} 台服务器。\n`));
  }
}
