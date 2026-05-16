// shell heredoc：用单引号 EOF 防止 $/反引号/% 被解释，正文本身 single-quote 也安全
function writeFileHeredoc(remotePath, content) {
  // 使用唯一 sentinel 避免与正文冲突
  const sentinel = 'DEPLOY_HELPER_EOF';
  return `cat > ${remotePath} <<'${sentinel}'\n${content}\n${sentinel}`;
}

// 返回在服务器上执行的 shell 命令数组
export function getSetupCommands(config) {
  const { projectType, nodeVersion = '20', pythonVersion = '3.11', appMode = 'web' } = config;
  const steps = [];

  steps.push({
    label: '更新系统包',
    cmd: 'apt-get update -qq',
  });

  // Nginx 和 Certbot 只有 web 服务需要
  if (appMode === 'web') {
    steps.push({
      label: '安装 Nginx',
      cmd: 'apt-get install -y -qq nginx',
    });
    steps.push({
      label: '安装 Certbot（用于 HTTPS）',
      cmd: 'apt-get install -y -qq certbot python3-certbot-nginx',
    });
  }

  if (projectType === 'nodejs') {
    steps.push({
      label: `安装 Node.js ${nodeVersion}`,
      cmd: `command -v node >/dev/null 2>&1 && node -v | grep -q "^v${nodeVersion}\\." || (curl -fsSL https://deb.nodesource.com/setup_${nodeVersion}.x | bash - && apt-get install -y nodejs)`,
    });
    steps.push({
      label: '安装 PM2（进程管理器）',
      cmd: 'command -v pm2 >/dev/null 2>&1 || npm install -g pm2',
    });
  }

  if (projectType === 'python') {
    const { pythonEnvManager = 'pip' } = config;

    if (pythonEnvManager === 'conda') {
      // 安装 Miniconda 到固定路径，已存在则跳过
      steps.push({
        label: '安装 Miniconda（如未安装）',
        cmd: [
          'command -v /opt/miniconda3/bin/conda >/dev/null 2>&1 || (',
          '  curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o /tmp/miniconda.sh &&',
          '  bash /tmp/miniconda.sh -b -p /opt/miniconda3 &&',
          '  rm /tmp/miniconda.sh',
          ')',
        ].join(' '),
      });
    } else {
      const pyBin = `python${pythonVersion}`;
      steps.push({
        label: `安装 Python ${pythonVersion}（如未安装）`,
        cmd: [
          `command -v ${pyBin} >/dev/null 2>&1 || (`,
          '  apt-get install -y -qq software-properties-common &&',
          '  add-apt-repository -y ppa:deadsnakes/ppa &&',
          '  apt-get update -qq &&',
          `  apt-get install -y -qq ${pyBin} ${pyBin}-venv ${pyBin}-distutils`,
          `  || apt-get install -y -qq python3 python3-venv`,
          ')',
          `&& (apt-get install -y -qq ${pyBin}-venv 2>/dev/null || apt-get install -y -qq python3-venv 2>/dev/null || true)`,
        ].join(' '),
      });
    }

    // cron 模式不需要 supervisor
    if (appMode !== 'cron') {
      steps.push({
        label: '安装 supervisor（进程管理）',
        cmd: 'command -v supervisorctl >/dev/null 2>&1 || apt-get install -y -qq supervisor',
      });
    }
  }

  if (projectType === 'docker') {
    // Docker 可能已预装（云服务商镜像常见），先检查再安装
    steps.push({
      label: '检查/安装 Docker',
      cmd: `command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh`,
    });
    steps.push({
      label: '检查/安装 docker-compose-plugin',
      cmd: `docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin`,
    });
    steps.push({
      label: '确保 Docker 服务运行',
      cmd: `systemctl enable docker && systemctl start docker`,
    });
  }

  // apt 在无人值守时可能弹出配置对话框卡住，统一关闭交互
  for (const s of steps) {
    if (s.cmd.includes('apt-get')) {
      s.cmd = `export DEBIAN_FRONTEND=noninteractive; ${s.cmd}`;
    }
  }

  return steps;
}

// 写入 crontab（幂等：先删除同名旧条目再添加）
function buildCronEntry(appName, schedule, fullCmd) {
  const marker = `deploy-helper:${appName}`;
  const logFile = `/var/log/${appName}.log`;
  // 注意：crontab 行本身不能有未转义的 % —— 这里 grep -v 用 marker 去重
  // fullCmd 中如有 % 由调用方负责（typical 启动命令不会有）
  return `(crontab -l 2>/dev/null | grep -v "${marker}"; echo "# ${marker}"; echo "${schedule} ${fullCmd} >> ${logFile} 2>&1") | crontab -`;
}

// 启动/重启应用的命令
export function getStartCommands(config) {
  const {
    projectType, remotePath, startCmd, appName, port,
    pythonVersion = '3.11', pythonFramework, pythonEnvManager = 'pip',
    appMode = 'web', cronSchedule, composeFile,
  } = config;

  if (projectType === 'nodejs') {
    const isNpmCmd = /^npm\s/.test(startCmd);
    const steps = [
      { label: '安装依赖', cmd: `cd ${remotePath} && npm install --omit=dev` },
    ];

    if (appMode === 'cron') {
      const cronFullCmd = `cd ${remotePath} && ${startCmd}`;
      steps.push({
        label: '写入定时任务（crontab）',
        cmd: buildCronEntry(appName, cronSchedule, cronFullCmd),
      });
      steps.push({
        label: '立即执行一次（验证）',
        cmd: `${cronFullCmd} >> /var/log/${appName}.log 2>&1 || true`,
      });
      return steps;
    }

    // 非 npm 命令通过 .start.sh 包装；npm 命令用 pm2 start npm -- ...
    const startScript = `${remotePath}/.start.sh`;
    const startScriptContent = `#!/bin/bash\ncd ${remotePath}\nexec ${startCmd}\n`;

    if (!isNpmCmd) {
      steps.push({
        label: '写入启动脚本',
        cmd: `${writeFileHeredoc(startScript, startScriptContent)} && chmod +x ${startScript}`,
      });
    }

    const pm2Target = isNpmCmd
      ? `npm --name ${appName} -- ${startCmd.replace(/^npm\s+/, '')}`
      : `${startScript} --name ${appName} --interpreter bash`;

    // script 模式不自动重启；web 模式正常重启
    const pm2StartCmd = appMode === 'script'
      ? `pm2 delete ${appName} 2>/dev/null || true; pm2 start ${pm2Target} --no-autorestart`
      : `pm2 delete ${appName} 2>/dev/null || true; pm2 start ${pm2Target}`;

    steps.push(
      { label: `启动应用（PM2${appMode === 'script' ? '，不自动重启' : ''}）`, cmd: pm2StartCmd },
      { label: '设置 PM2 开机自启', cmd: `pm2 save && (pm2 startup | tail -1 | bash || true)` },
    );

    return steps;
  }

  if (projectType === 'python') {
    const supervisorConfPath = `/etc/supervisor/conf.d/${appName}.conf`;

    if (pythonEnvManager === 'conda') {
      const condaBin = '/opt/miniconda3/bin/conda';
      const condaCmd = `${condaBin} run -n ${appName} --no-capture-output ${startCmd}`;
      const installSteps = [
        {
          label: '创建/更新 conda 环境',
          cmd: [
            `${condaBin} env update -f ${remotePath}/environment.yml -n ${appName} --prune 2>/dev/null`,
            `|| ${condaBin} env create -f ${remotePath}/environment.yml -n ${appName}`,
          ].join(' '),
        },
      ];

      if (appMode === 'cron') {
        return [
          ...installSteps,
          {
            label: '写入定时任务（crontab）',
            cmd: buildCronEntry(appName, cronSchedule, condaCmd),
          },
          {
            label: '立即执行一次（验证）',
            cmd: `${condaCmd} >> /var/log/${appName}.log 2>&1 || true`,
          },
        ];
      }

      const supervisorConf = getSupervisorConfig({
        appName, remotePath, venvCmd: condaCmd,
        autorestart: appMode === 'script' ? 'unexpected' : 'true',
      });
      return [
        ...installSteps,
        {
          label: '写入 supervisor 配置',
          cmd: writeFileHeredoc(supervisorConfPath, supervisorConf),
        },
        {
          label: '启动应用（supervisor）',
          cmd: `supervisorctl reread && supervisorctl update && (supervisorctl restart ${appName} 2>/dev/null || supervisorctl start ${appName})`,
        },
      ];
    }

    // pip + venv 路径
    const pyBin = `python${pythonVersion}`;
    const venvPip = `${remotePath}/venv/bin/pip`;
    const venvCmd = startCmd.replace(/^(\S+)/, `${remotePath}/venv/bin/$1`);

    const installSteps = [
      {
        label: '创建 Python 虚拟环境',
        cmd: `test -d ${remotePath}/venv || (${pyBin} -m venv ${remotePath}/venv || python3 -m venv ${remotePath}/venv)`,
      },
      {
        label: '安装 Python 依赖',
        cmd: `cd ${remotePath} && ${venvPip} install -r requirements.txt -q`,
      },
    ];

    if (appMode === 'web') {
      const extraPkg = pythonFramework === 'fastapi' ? 'uvicorn' : 'gunicorn';
      installSteps.push({
        label: `安装 ${extraPkg}（WSGI/ASGI 服务器）`,
        cmd: `${venvPip} install ${extraPkg} -q`,
      });
    }

    if (appMode === 'cron') {
      return [
        ...installSteps,
        {
          label: '写入定时任务（crontab）',
          cmd: buildCronEntry(appName, cronSchedule, `cd ${remotePath} && ${venvCmd}`),
        },
        {
          label: '立即执行一次（验证）',
          cmd: `cd ${remotePath} && ${venvCmd} >> /var/log/${appName}.log 2>&1 || true`,
        },
      ];
    }

    const supervisorConf = getSupervisorConfig({
      appName, remotePath, venvCmd,
      autorestart: appMode === 'script' ? 'unexpected' : 'true',
    });
    return [
      ...installSteps,
      {
        label: '写入 supervisor 配置',
        cmd: writeFileHeredoc(supervisorConfPath, supervisorConf),
      },
      {
        label: '启动应用（supervisor）',
        cmd: `supervisorctl reread && supervisorctl update && (supervisorctl restart ${appName} 2>/dev/null || supervisorctl start ${appName})`,
      },
    ];
  }

  if (projectType === 'docker') {
    if (composeFile) {
      const composeCmd = `docker compose -f ${composeFile}`;
      return [
        {
          label: '拉取基础镜像（如有）',
          cmd: `cd ${remotePath} && ${composeCmd} pull 2>/dev/null || true`,
        },
        {
          label: '构建并启动容器',
          cmd: `cd ${remotePath} && ${composeCmd} up -d --build --remove-orphans`,
        },
      ];
    }

    // 无 compose 文件：单容器模式
    return [
      {
        label: '构建 Docker 镜像',
        cmd: `cd ${remotePath} && docker build -t ${appName} .`,
      },
      {
        label: '启动容器',
        cmd: [
          `docker stop ${appName} 2>/dev/null || true`,
          `docker rm ${appName} 2>/dev/null || true`,
          `docker run -d --name ${appName} --restart unless-stopped -p ${port}:${port} ${appName}`,
        ].join(' && '),
      },
    ];
  }

  if (projectType === 'static') {
    return [
      { label: '设置 Nginx 文件权限', cmd: `chown -R www-data:www-data ${remotePath}` },
    ];
  }

  return [];
}

// 停止服务（供 rollback 使用）
export function getStopCommand(config) {
  const { projectType, appName, remotePath, appMode = 'web', composeFile } = config;

  if (appMode === 'cron') {
    // cron 不需要停止；下次定时不命中即可。
    // 如果想立即停，可以从 crontab 移除——但 rollback 之后通常想保留定时
    return null;
  }

  if (projectType === 'nodejs') {
    return `pm2 stop ${appName} 2>/dev/null || true`;
  }
  if (projectType === 'python') {
    return `supervisorctl stop ${appName} 2>/dev/null || true`;
  }
  if (projectType === 'docker') {
    if (composeFile) {
      return `cd ${remotePath} && docker compose -f ${composeFile} down 2>/dev/null || true`;
    }
    return `docker stop ${appName} 2>/dev/null || true; docker rm ${appName} 2>/dev/null || true`;
  }
  return null;
}

// 健康检查：返回 { cmd, parse } —— parse 接受 {stdout, code} 返回 { ok, detail }
export function getHealthCheck(config) {
  const { projectType, appName, remotePath, appMode = 'web', composeFile, pythonEnvManager } = config;

  if (appMode === 'cron') {
    const marker = `deploy-helper:${appName}`;
    return {
      cmd: `crontab -l 2>/dev/null | grep -F "${marker}" | head -1`,
      parse: ({ stdout }) => stdout
        ? { ok: true, detail: '已写入 crontab' }
        : { ok: false, detail: '未在 crontab 中找到该任务' },
    };
  }

  if (projectType === 'nodejs') {
    return {
      cmd: `pm2 jlist 2>/dev/null`,
      parse: ({ stdout }) => {
        try {
          const list = JSON.parse(stdout || '[]');
          const app = list.find(p => p.name === appName);
          if (!app) return { ok: false, detail: `PM2 中未找到 ${appName}` };
          const status = app.pm2_env?.status;
          return status === 'online'
            ? { ok: true, detail: `PM2 状态: online (PID ${app.pid})` }
            : { ok: false, detail: `PM2 状态: ${status}` };
        } catch {
          return { ok: false, detail: 'pm2 jlist 解析失败' };
        }
      },
    };
  }

  if (projectType === 'python') {
    return {
      cmd: `supervisorctl status ${appName} 2>&1 || true`,
      parse: ({ stdout }) => {
        const line = stdout.trim();
        if (/RUNNING/.test(line)) return { ok: true, detail: line };
        return { ok: false, detail: line || 'supervisor 未返回状态' };
      },
    };
  }

  if (projectType === 'docker') {
    if (composeFile) {
      return {
        cmd: `cd ${remotePath} && docker compose -f ${composeFile} ps --format json 2>/dev/null || true`,
        parse: ({ stdout }) => {
          const raw = stdout.trim();
          if (!raw) return { ok: false, detail: 'docker compose ps 无输出' };
          // 兼容两种格式：旧版 docker compose 输出 JSON 数组，新版输出 NDJSON
          let services = [];
          try {
            const parsed = JSON.parse(raw);
            services = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            services = raw.split('\n').filter(Boolean)
              .map(l => { try { return JSON.parse(l); } catch { return null; } })
              .filter(Boolean);
          }
          if (services.length === 0) return { ok: false, detail: '未找到运行中的服务' };
          const allRunning = services.every(s => /running|up/i.test(s.State || s.Status || ''));
          return {
            ok: allRunning,
            detail: services.map(s => `${s.Service || s.Name}: ${s.State || s.Status}`).join('; '),
          };
        },
      };
    }
    return {
      cmd: `docker inspect -f '{{.State.Status}}' ${appName} 2>/dev/null || echo missing`,
      parse: ({ stdout }) => stdout.trim() === 'running'
        ? { ok: true, detail: '容器运行中' }
        : { ok: false, detail: `容器状态: ${stdout.trim()}` },
    };
  }

  // static 没有进程，认为只要 Nginx 在跑即可
  return {
    cmd: `systemctl is-active nginx 2>/dev/null || true`,
    parse: ({ stdout }) => stdout.trim() === 'active'
      ? { ok: true, detail: 'Nginx active' }
      : { ok: false, detail: `Nginx 状态: ${stdout.trim()}` },
  };
}

// 生成 supervisor 配置内容（heredoc 写入，使用真实换行）
// autorestart: 'true'（始终重启）| 'unexpected'（仅崩溃时重启）| 'false'
function getSupervisorConfig({ appName, remotePath, venvCmd, autorestart = 'true' }) {
  return [
    `[program:${appName}]`,
    `command=${venvCmd}`,
    `directory=${remotePath}`,
    `autostart=true`,
    `autorestart=${autorestart}`,
    `stderr_logfile=/var/log/${appName}.err.log`,
    `stdout_logfile=/var/log/${appName}.out.log`,
    ``,
  ].join('\n');
}

// 生成 Nginx 配置
export function getNginxConfig(config) {
  const { domain, port, projectType, remotePath, staticDir } = config;

  if (projectType === 'static') {
    // staticDir 指向构建产物子目录（如 dist），留空则用项目根
    const cleanDir = (staticDir || '').trim().replace(/^\/+|\/+$/g, '');
    const webRoot = cleanDir ? `${remotePath}/${cleanDir}` : remotePath;
    return `server {
    listen 80;
    server_name ${domain};
    root ${webRoot};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
}`;
  }

  // 反向代理（Node.js / Python / Docker）
  return `server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}`;
}

// 把任意字符串内容写入服务器文件的 shell 命令（heredoc 方式）
export { writeFileHeredoc };
