import fs from 'fs';
import path from 'path';

export function detectProjectType(projectPath = process.cwd()) {
  const files = fs.readdirSync(projectPath);

  if (files.includes('package.json')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'));
    // 判断是否是纯前端项目
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['next'] || deps['nuxt']) return 'nodejs'; // SSR 框架当后端处理
    if (pkg.scripts?.build && !pkg.scripts?.start) return 'static'; // 只有 build 没有 start
    return 'nodejs';
  }

  if (files.includes('requirements.txt') || files.includes('pyproject.toml') || files.includes('setup.py')) {
    return 'python';
  }

  if (files.includes('Dockerfile')) {
    return 'docker';
  }

  if (files.includes('index.html') || files.includes('index.htm')) {
    return 'static';
  }

  return 'unknown';
}

export const PROJECT_TYPE_LABELS = {
  nodejs: 'Node.js 应用（Express / Koa / Next.js 等）',
  python: 'Python 应用（Flask / FastAPI / Django 等）',
  static: '静态网站（纯 HTML/CSS/JS）',
  docker: 'Docker 容器',
  unknown: '其他 / 我来手动指定',
};

// 根据项目类型返回启动命令建议
export function getStartCommand(type, pkg) {
  if (type === 'nodejs') {
    if (pkg?.scripts?.start) return pkg.scripts.start;
    return 'node index.js';
  }
  if (type === 'python') return 'python app.py';
  if (type === 'docker') return 'docker-compose up -d';
  return '';
}
