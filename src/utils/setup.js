// 返回在服务器上执行的 shell 命令数组
export function getSetupCommands(config) {
  const { projectType, nodeVersion = '20', pythonVersion = '3.11' } = config;
  const steps = [];

  // 通用：更新系统 & 安装 nginx
  steps.push({
    label: '更新系统包',
    cmd: 'apt-get update -qq',
  });
  steps.push({
    label: '安装 Nginx',
    cmd: 'apt-get install -y -qq nginx',
  });
  steps.push({
    label: '安装 Certbot（用于 HTTPS）',
    cmd: 'apt-get install -y -qq certbot python3-certbot-nginx',
  });

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
    const pyBin = `python${pythonVersion}`;
    // 先检查目标版本是否已存在，不存在才走 deadsnakes PPA 安装流程
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
        // 无论哪条路径，都确保 venv 包存在
        `&& apt-get install -y -qq ${pyBin}-venv 2>/dev/null || apt-get install -y -qq python3-venv 2>/dev/null || true`,
      ].join(' '),
    });
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

// 启动/重启应用的命令
export function getStartCommands(config) {
  const { projectType, remotePath, startCmd, appName, port, pythonVersion = '3.11', pythonFramework } = config;

  if (projectType === 'nodejs') {
    const isNpmCmd = /^npm\s/.test(startCmd);
    const pm2Target = isNpmCmd
      ? `npm --name ${appName} -- ${startCmd.replace(/^npm\s+/, '')}`
      : `${remotePath}/.start.sh --name ${appName} --interpreter bash`;

    const steps = [
      { label: '安装依赖', cmd: `cd ${remotePath} && npm install --production` },
    ];

    if (!isNpmCmd) {
      steps.push({
        label: '写入启动脚本',
        cmd: `printf '#!/bin/bash\\ncd ${remotePath}\\n${startCmd}\\n' > ${remotePath}/.start.sh && chmod +x ${remotePath}/.start.sh`,
      });
    }

    steps.push(
      { label: '启动应用（PM2）', cmd: `pm2 delete ${appName} 2>/dev/null || true && pm2 start ${pm2Target}` },
      { label: '设置 PM2 开机自启', cmd: `pm2 save && pm2 startup | tail -1 | bash || true` },
    );

    return steps;
  }

  if (projectType === 'python') {
    const pyBin = `python${pythonVersion}`;
    const venvPip = `${remotePath}/venv/bin/pip`;
    // 将 startCmd 的第一个词替换为 venv 内的可执行文件路径
    const venvCmd = startCmd.replace(/^(\S+)/, `${remotePath}/venv/bin/$1`);

    const extraPkg = pythonFramework === 'fastapi' ? 'uvicorn' : 'gunicorn';
    const supervisorConf = getSupervisorConfig({ appName, remotePath, venvCmd });
    const supervisorConfPath = `/etc/supervisor/conf.d/${appName}.conf`;

    return [
      {
        label: '创建 Python 虚拟环境',
        cmd: `${pyBin} -m venv ${remotePath}/venv || python3 -m venv ${remotePath}/venv`,
      },
      {
        label: '安装 Python 依赖',
        cmd: `cd ${remotePath} && ${venvPip} install -r requirements.txt -q`,
      },
      {
        label: `安装 ${extraPkg}（WSGI/ASGI 服务器）`,
        cmd: `${venvPip} install ${extraPkg} -q`,
      },
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
function getSupervisorConfig({ appName, remotePath, venvCmd }) {
  return [
    `[program:${appName}]`,
    `command=${venvCmd}`,
    `directory=${remotePath}`,
    `autostart=true`,
    `autorestart=true`,
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
