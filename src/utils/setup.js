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
      cmd: `curl -fsSL https://deb.nodesource.com/setup_${nodeVersion}.x | bash - && apt-get install -y nodejs`,
    });
    steps.push({
      label: '安装 PM2（进程管理器）',
      cmd: 'npm install -g pm2',
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
          `&& apt-get install -y -qq ${pyBin}-venv 2>/dev/null || apt-get install -y -qq python3-venv 2>/dev/null || true`,
        ].join(' '),
      });
    }

    steps.push({
      label: '安装 supervisor（进程管理）',
      cmd: 'apt-get install -y -qq supervisor',
    });
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

  return steps;
}

// 写入 crontab（幂等：先删除同名旧条目再添加）
function buildCronEntry(appName, schedule, fullCmd) {
  const marker = `deploy-helper:${appName}`;
  const logFile = `/var/log/${appName}.log`;
  return `(crontab -l 2>/dev/null | grep -v "${marker}"; echo "# ${marker}"; echo "${schedule} ${fullCmd} >> ${logFile} 2>&1") | crontab -`;
}

// 启动/重启应用的命令
export function getStartCommands(config) {
  const {
    projectType, remotePath, startCmd, appName, port,
    pythonVersion = '3.11', pythonFramework, pythonEnvManager = 'pip',
    appMode = 'web', cronSchedule,
  } = config;

  if (projectType === 'nodejs') {
    const isNpmCmd = /^npm\s/.test(startCmd);
    const steps = [
      { label: '安装依赖', cmd: `cd ${remotePath} && npm install --production` },
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

    const pm2Target = isNpmCmd
      ? `npm --name ${appName} -- ${startCmd.replace(/^npm\s+/, '')}`
      : `${remotePath}/.start.sh --name ${appName} --interpreter bash`;

    if (!isNpmCmd) {
      steps.push({
        label: '写入启动脚本',
        cmd: `printf '#!/bin/bash\\ncd ${remotePath}\\n${startCmd}\\n' > ${remotePath}/.start.sh && chmod +x ${remotePath}/.start.sh`,
      });
    }

    // script 模式不自动重启（--no-autorestart）；web 模式正常重启
    const pm2StartCmd = appMode === 'script'
      ? `pm2 delete ${appName} 2>/dev/null || true && pm2 start ${pm2Target} --no-autorestart`
      : `pm2 delete ${appName} 2>/dev/null || true && pm2 start ${pm2Target}`;

    steps.push(
      { label: `启动应用（PM2${appMode === 'script' ? '，不自动重启' : ''}）`, cmd: pm2StartCmd },
      { label: '设置 PM2 开机自启', cmd: `pm2 save && pm2 startup | tail -1 | bash || true` },
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

      // web 模式：autorestart=true；script 模式：autorestart=unexpected（崩溃才重启）
      const supervisorConf = getSupervisorConfig({
        appName, remotePath, venvCmd: condaCmd,
        autorestart: appMode === 'script' ? 'unexpected' : 'true',
      });
      return [
        ...installSteps,
        {
          label: '写入 supervisor 配置',
          cmd: `printf '${supervisorConf.replace(/'/g, "'\\''")}' > ${supervisorConfPath}`,
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
        cmd: `${pyBin} -m venv ${remotePath}/venv || python3 -m venv ${remotePath}/venv`,
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
        cmd: `printf '${supervisorConf.replace(/'/g, "'\\''")}' > ${supervisorConfPath}`,
      },
      {
        label: '启动应用（supervisor）',
        cmd: `supervisorctl reread && supervisorctl update && (supervisorctl restart ${appName} 2>/dev/null || supervisorctl start ${appName})`,
      },
    ];
  }

  if (projectType === 'docker') {
    const { composeFile, appName, port } = config;

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

// 生成 supervisor 配置内容
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
  ].join('\\n');
}

// 生成 Nginx 配置
export function getNginxConfig(config) {
  const { domain, port, projectType, remotePath } = config;

  if (projectType === 'static') {
    return `server {
    listen 80;
    server_name ${domain};
    root ${remotePath};
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
