import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import os from 'os';
import { connectSSH, runRemote, runRemoteSilent, uploadDirectory } from '../utils/ssh.js';
import { saveConfig, loadConfig, configExists } from '../utils/config.js';
import fs from 'fs';
import {
  detectProjectType, detectNodeVersion, detectPythonFramework, detectPythonVersion,
  getNodeStartCommand, getPythonStartCommand,
  hasDockerfile, detectComposeFile, detectDockerPort,
  PROJECT_TYPE_LABELS, PYTHON_FRAMEWORK_LABELS,
} from '../utils/detect.js';
import { getSetupCommands, getStartCommands, getNginxConfig } from '../utils/setup.js';

const step = (n, total, msg) =>
  console.log(chalk.cyan(`\n[${n}/${total}] `) + chalk.bold(msg));

const success = (msg) => console.log(chalk.green('  ✓ ') + msg);
const info = (msg) => console.log(chalk.gray('  ℹ ') + msg);

export async function deployInit() {
  // 已有配置，询问是否覆盖
  if (configExists()) {
    const existing = loadConfig();
    const { overwrite } = await inquirer.prompt([{
      type: 'confirm',
      name: 'overwrite',
      message: `检测到已有部署配置（服务器：${existing.host}），要重新配置吗？`,
      default: false,
    }]);
    if (!overwrite) {
      console.log(chalk.yellow('\n已取消。如需更新代码，运行：') + chalk.cyan(' deploy-helper update\n'));
      return;
    }
  }

  console.log(chalk.gray('回答几个问题，我来帮你搞定剩下的一切 👇\n'));

  // ── Step 1: 服务器信息 ──────────────────────────────────────────
  step(1, 5, '服务器连接信息');

  const serverAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'host',
      message: '服务器 IP 地址：',
      validate: (v) => v.trim() ? true : '请输入 IP 地址',
    },
    {
      type: 'input',
      name: 'port',
      message: 'SSH 端口：',
      default: '22',
    },
    {
      type: 'input',
      name: 'user',
      message: '登录用户名：',
      default: 'root',
    },
    {
      type: 'list',
      name: 'authType',
      message: '登录方式：',
      choices: [
        { name: 'SSH 密钥（推荐）', value: 'key' },
        { name: '密码', value: 'password' },
      ],
    },
    {
      type: 'input',
      name: 'keyPath',
      message: 'SSH 密钥路径：',
      default: `${os.homedir()}/.ssh/id_rsa`,
      when: (a) => a.authType === 'key',
    },
    {
      type: 'password',
      name: 'password',
      message: '服务器密码：',
      when: (a) => a.authType === 'password',
      mask: '*',
    },
  ]);

  // 测试连接
  const spinner = ora('正在连接服务器...').start();
  let ssh;
  try {
    ssh = await connectSSH(serverAnswers);
    spinner.succeed(chalk.green('服务器连接成功！'));
  } catch (err) {
    spinner.fail(chalk.red('连接失败：' + err.message));
    console.log(chalk.yellow('\n排查建议：'));
    console.log('  • 检查 IP 和端口是否正确');
    console.log('  • 确认服务器安全组已开放 22 端口');
    console.log('  • 如用密钥登录，确认密钥路径和权限（chmod 600）');
    return;
  }

  // ── Step 2: 项目信息 ──────────────────────────────────────────
  step(2, 5, '项目信息');

  const detectedType = detectProjectType();
  info(`自动检测到项目类型：${PROJECT_TYPE_LABELS[detectedType]}`);

  // 第一步：确认类型和应用名
  const typeAnswers = await inquirer.prompt([
    {
      type: 'list',
      name: 'projectType',
      message: '确认项目类型：',
      default: detectedType,
      choices: Object.entries(PROJECT_TYPE_LABELS).map(([value, name]) => ({ name, value })),
    },
    {
      type: 'input',
      name: 'appName',
      message: '应用名称（用于进程管理）：',
      default: path.basename(process.cwd()),
      validate: (v) => /^[a-z0-9_-]+$/i.test(v) ? true : '只能包含字母、数字、下划线和连字符',
    },
  ]);

  const { projectType, appName } = typeAnswers;

  // 根据确认的类型做二次检测，结果全部展示给用户
  let detectedNodeVer = null;
  let detectedNodeCmd = null;
  let detectedPyFramework = null;
  let detectedPyVersion = null;
  let detectedDockerInfo = null;

  if (projectType === 'nodejs') {
    detectedNodeVer = detectNodeVersion();
    detectedNodeCmd = getNodeStartCommand();

    if (detectedNodeVer) {
      info(`检测到 Node.js 版本要求：v${detectedNodeVer.version}（来源：${detectedNodeVer.source}）`);
    } else {
      info('未检测到 Node.js 版本要求（.nvmrc / engines.node），将默认使用 Node.js 20 LTS');
    }
    info(`检测到启动命令：${detectedNodeCmd.cmd}（来源：${detectedNodeCmd.source}）`);
  }

  if (projectType === 'python') {
    detectedPyFramework = detectPythonFramework();
    detectedPyVersion = detectPythonVersion();

    if (detectedPyFramework) {
      info(`检测到 Python 框架：${PYTHON_FRAMEWORK_LABELS[detectedPyFramework]}（来源：requirements.txt）`);
    } else {
      info('未在 requirements.txt 中检测到已知框架（FastAPI / Django / Flask），请手动确认启动命令');
    }
    if (detectedPyVersion) {
      info(`检测到 Python 版本：${detectedPyVersion.version}（来源：${detectedPyVersion.source}）`);
    } else {
      info('未检测到 Python 版本要求（.python-version / pyproject.toml），将默认使用 3.11');
    }
  }

  if (projectType === 'docker') {
    const dockerfileExists = hasDockerfile();
    const composeFile = detectComposeFile();
    const dockerPort = detectDockerPort();

    if (!dockerfileExists) {
      console.log(chalk.yellow('\n  ⚠ 未检测到 Dockerfile'));
      console.log(chalk.gray('    Docker 部署需要 Dockerfile 或 docker-compose.yml。'));
      console.log(chalk.gray('    如果你的语言/框架比较特殊（Java、C++、CUDA 等），'));
      console.log(chalk.gray('    推荐用 Dockerfile 把运行环境完整封装，deploy-helper 只负责把它跑起来。'));
    } else {
      info('检测到 Dockerfile ✓');
    }

    if (composeFile) {
      info(`检测到编排文件：${composeFile}（将使用 docker compose 启动）`);
    } else {
      info('未检测到 docker-compose 文件，将以单容器模式（docker build + docker run）启动');
    }

    if (dockerPort) {
      info(`检测到容器映射端口：${dockerPort.port}（来源：${dockerPort.source}）`);
    } else {
      info('未从 Dockerfile/compose 文件中读取到端口，请手动填写');
    }

    const localEnvExists = fs.existsSync(path.join(process.cwd(), '.env'));
    if (localEnvExists) {
      console.log(chalk.gray('\n  本地存在 .env 文件（默认不上传，包含敏感信息请谨慎）'));
    }

    detectedDockerInfo = { dockerfileExists, composeFile, dockerPort, localEnvExists };
  }

  if (projectType === 'unknown') {
    console.log(chalk.yellow('\n  提示：如果你的项目使用 Java、C++、Go、CUDA、conda 等环境，'));
    console.log(chalk.gray('  推荐先写一个 Dockerfile 把运行环境封装好，再选择 Docker 类型部署。'));
    console.log(chalk.gray('  这样 deploy-helper 不需要了解你的语言细节，只需要会跑 Docker 即可。'));
    console.log(chalk.gray('  Dockerfile 入门：https://docs.docker.com/get-started/\n'));
  }

  // 第二步：让用户确认所有检测结果，port 在 startCmd 之前以便生成默认命令
  const detailAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'remotePath',
      message: '部署到服务器的路径：',
      default: `/var/www/${appName}`,
    },
    {
      type: 'input',
      name: 'nodeVersion',
      message: '确认 Node.js 版本（主版本号，如 18 / 20 / 22）：',
      default: detectedNodeVer?.version || '20',
      when: () => projectType === 'nodejs',
    },
    {
      type: 'list',
      name: 'pythonFramework',
      message: '确认 Python 框架：',
      default: detectedPyFramework || 'other',
      choices: [
        { name: 'FastAPI（uvicorn 启动）', value: 'fastapi' },
        { name: 'Django（gunicorn 启动）', value: 'django' },
        { name: 'Flask（gunicorn 启动）', value: 'flask' },
        { name: '其他（手动填写启动命令）', value: 'other' },
      ],
      when: () => projectType === 'python',
    },
    {
      type: 'input',
      name: 'pythonVersion',
      message: '确认 Python 版本（如 3.11）：',
      default: detectedPyVersion?.version || '3.11',
      when: () => projectType === 'python',
    },
    {
      type: 'input',
      name: 'port',
      message: '应用监听的端口（宿主机端口，Nginx 将代理到此）：',
      default: () => {
        if (projectType === 'docker') return detectedDockerInfo?.dockerPort?.port || '8080';
        if (projectType === 'python') return '8000';
        return '3000';
      },
      when: () => ['nodejs', 'python', 'docker'].includes(projectType),
    },
    {
      type: 'input',
      name: 'composeFile',
      message: 'docker-compose 文件名（留空则使用单容器模式）：',
      default: detectedDockerInfo?.composeFile || '',
      when: () => projectType === 'docker',
    },
    {
      type: 'confirm',
      name: 'uploadEnv',
      message: '是否将本地 .env 文件上传到服务器？（包含数据库密码等敏感信息，请谨慎）',
      default: false,
      when: () => projectType === 'docker' && detectedDockerInfo?.localEnvExists,
    },
    {
      type: 'input',
      name: 'startCmd',
      message: '确认启动命令：',
      default: (a) => {
        if (projectType === 'nodejs') return detectedNodeCmd.cmd;
        if (projectType === 'python') {
          return getPythonStartCommand(a.pythonFramework, appName, a.port);
        }
        return '';
      },
      when: () => ['nodejs', 'python'].includes(projectType),
    },
  ]);

  const projectAnswers = { ...typeAnswers, ...detailAnswers };

  // ── Step 3: 域名 & HTTPS ──────────────────────────────────────
  step(3, 5, '域名 & HTTPS（可选）');

  const domainAnswers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useDomain',
      message: '是否配置域名？（没有域名用 IP 也可以）',
      default: true,
    },
    {
      type: 'input',
      name: 'domain',
      message: '你的域名（如 example.com）：',
      when: (a) => a.useDomain,
      validate: (v) => v.trim() ? true : '请输入域名',
    },
    {
      type: 'confirm',
      name: 'useHttps',
      message: '是否自动申请 HTTPS 证书？（免费，需要域名已解析到此服务器）',
      default: true,
      when: (a) => a.useDomain,
    },
  ]);

  const config = {
    ...serverAnswers,
    ...projectAnswers,
    ...domainAnswers,
    domain: domainAnswers.domain || serverAnswers.host,
    deployedAt: new Date().toISOString(),
  };

  // ── Step 4: 安装环境 ──────────────────────────────────────────
  step(4, 5, '在服务器上安装运行环境');
  console.log(chalk.gray('  首次部署需要安装依赖，大约需要 2-5 分钟...\n'));

  try {
    // 创建部署目录
    await runRemote(ssh, `mkdir -p ${config.remotePath}`, '创建部署目录');

    const setupSteps = getSetupCommands(config);
    for (const s of setupSteps) {
      const sp = ora(`  ${s.label}...`).start();
      try {
        await runRemoteSilent(ssh, s.cmd);
        sp.succeed(chalk.green(s.label));
      } catch (err) {
        sp.warn(chalk.yellow(`${s.label} 失败，继续... (${err.message.slice(0, 60)})`));
      }
    }
  } catch (err) {
    console.log(chalk.red('\n环境安装失败：' + err.message));
    ssh.dispose();
    return;
  }

  // ── Step 5: 上传代码 & 启动 ──────────────────────────────────
  step(5, 5, '上传代码并启动服务');

  try {
    // 上传代码
    const uploadSpinner = ora('  上传项目文件...').start();
    await uploadDirectory(ssh, process.cwd(), config.remotePath, { uploadEnv: !!config.uploadEnv });
    uploadSpinner.succeed('项目文件上传完成');
    if (config.projectType === 'docker' && !config.uploadEnv && detectedDockerInfo?.localEnvExists) {
      console.log(chalk.yellow('  ℹ .env 未上传，如需环境变量可在服务器手动创建：') + chalk.gray(` ${config.remotePath}/.env`));
    }

    // 启动应用
    const startSteps = getStartCommands(config);
    for (const s of startSteps) {
      const sp = ora(`  ${s.label}...`).start();
      await runRemoteSilent(ssh, s.cmd);
      sp.succeed(s.label);
    }

    // 配置 Nginx
    const nginxConf = getNginxConfig(config);
    const nginxPath = `/etc/nginx/sites-available/${config.appName}`;
    await runRemoteSilent(ssh, `echo '${nginxConf.replace(/'/g, "'\\''")}' > ${nginxPath}`);
    await runRemoteSilent(ssh, `ln -sf ${nginxPath} /etc/nginx/sites-enabled/${config.appName}`);
    await runRemoteSilent(ssh, `rm -f /etc/nginx/sites-enabled/default`);
    await runRemoteSilent(ssh, `nginx -t && systemctl reload nginx`);
    success('Nginx 配置完成');

    // HTTPS
    if (domainAnswers.useHttps && domainAnswers.domain) {
      const httpsSpinner = ora('  申请 SSL 证书...').start();
      const certResult = await runRemoteSilent(
        ssh,
        `certbot --nginx -d ${config.domain} --non-interactive --agree-tos --email admin@${config.domain} --redirect`
      );
      if (certResult.code === 0) {
        httpsSpinner.succeed(`HTTPS 证书申请成功`);
      } else {
        httpsSpinner.warn('HTTPS 申请失败（可能是域名还没解析），可以之后手动运行 certbot）');
      }
    }

  } catch (err) {
    console.log(chalk.red('\n部署失败：' + err.message));
    ssh.dispose();
    return;
  }

  // 保存配置
  saveConfig(config);
  ssh.dispose();

  // 完成！
  const accessUrl = domainAnswers.useHttps && domainAnswers.domain
    ? `https://${config.domain}`
    : domainAnswers.domain
      ? `http://${config.domain}`
      : `http://${config.host}:${config.port || 80}`;

  console.log(chalk.green.bold('\n🎉 部署成功！\n'));
  console.log(`  访问地址：${chalk.cyan.underline(accessUrl)}`);
  console.log(`  配置已保存至：${chalk.gray('.deploy-config.json')}`);
  console.log('\n后续操作：');
  console.log(`  更新代码 → ${chalk.cyan('deploy-helper update')}`);
  console.log(`  查看状态 → ${chalk.cyan('deploy-helper status')}\n`);
}
