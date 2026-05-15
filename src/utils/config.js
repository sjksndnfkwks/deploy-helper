import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.deploy-helper');
const CONFIG_FILENAME = '.deploy-config.json';
const CONFIG_FILE = path.join(process.cwd(), CONFIG_FILENAME);

export function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  ensureGitignored();
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function configExists() {
  return fs.existsSync(CONFIG_FILE);
}

// 如果项目目录是 git 仓库且 .gitignore 还没忽略 .deploy-config.json，自动追加一行。
// 配置含密码/密钥，进 git 会泄密。
function ensureGitignored() {
  const gitDir = path.join(process.cwd(), '.git');
  if (!fs.existsSync(gitDir)) return; // 非 git 项目跳过

  const gitignorePath = path.join(process.cwd(), '.gitignore');
  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
    const already = content.split('\n').some(line => {
      const t = line.trim();
      return t === CONFIG_FILENAME || t === `/${CONFIG_FILENAME}` || t === `./${CONFIG_FILENAME}`;
    });
    if (already) return;
  }

  const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const block = `${prefix}\n# deploy-helper：含服务器密码/密钥，请勿提交\n${CONFIG_FILENAME}\n`;
  fs.appendFileSync(gitignorePath, block);
}
