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
    steps.push({
      label: '安装 Python & pip',
      cmd: `apt-get install -y -qq python3 python3-pip python3-venv`,
    });
    steps.push({
      label: '安装 supervisor（进程管理）',
      cmd: 'apt-get install -y -qq supervisor',
    });
  }

  if (projectType === 'docker') {
    steps.push({
      label: '安装 Docker',
      cmd: `curl -fsSL https://get.docker.com | sh`,
    });
    steps.push({
      label: '安装 docker-compose',
      cmd: `apt-get install -y -qq docker-compose-plugin`,
    });
  }

  return steps;
}

// 启动/重启应用的命令
export function getStartCommands(config) {
  const { projectType, remotePath, startCmd, appName, port } = config;

  if (projectType === 'nodejs') {
    return [
      { label: '安装依赖', cmd: `cd ${remotePath} && npm install --production` },
      { label: '启动应用（PM2）', cmd: `cd ${remotePath} && pm2 delete ${appName} 2>/dev/null; pm2 start ${startCmd} --name ${appName}` },
      { label: '设置 PM2 开机自启', cmd: `pm2 save && pm2 startup | tail -1 | bash || true` },
    ];
  }

  if (projectType === 'python') {
    return [
      { label: '安装 Python 依赖', cmd: `cd ${remotePath} && pip3 install -r requirements.txt -q` },
      { label: '启动应用（supervisor）', cmd: `cd ${remotePath} && supervisorctl reread && supervisorctl update && supervisorctl restart ${appName}` },
    ];
  }

  if (projectType === 'docker') {
    return [
      { label: '启动容器', cmd: `cd ${remotePath} && docker compose up -d --build` },
    ];
  }

  if (projectType === 'static') {
    return [
      { label: '设置 Nginx 文件权限', cmd: `chown -R www-data:www-data ${remotePath}` },
    ];
  }

  return [];
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
