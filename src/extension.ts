import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as jsonc from "jsonc-parser";
import { minimatch } from "minimatch";
import { DopingConfig, DopingProject, ProjectResolved, PackageManager } from "./types";

const CTX_RUNNING = "doping.scriptsRunning";

type TerminalKey = string; // `${absPath}::${scriptName}`
interface TermRecord {
  terminal: vscode.Terminal;
  project: ProjectResolved;
  script: string;
  running: boolean;
}

const terminals = new Map<TerminalKey, TermRecord>();

const i18n = {
  en: {
    noWorkspace: "doping: Please open a workspace first.",
    noScripts: "doping: No scripts found to display.",
    selectProject: "Select project",
    installDeps: "Install dependencies",
    missingNodeModules: "(missing node_modules)",
    selectScript: "Select script to run/stop (🟢 running, ⚪ stopped)",
    projectScript: "Project {0} — Select script (🟢 running, ⚪ stopped)",
    running: "(running)",
    stopped: "Stopped: {0} {1}",
    runningMsg: "Running: {0} {1}",
    allStopped: "All doping terminals stopped.",
    configError: "doping: Failed to parse .doping config, using defaults. {0}"
  },
  cn: {
    noWorkspace: "doping: 请先打开一个工作区。",
    noScripts: "doping: 未找到可展示的 scripts。",
    selectProject: "选择项目",
    installDeps: "安装依赖",
    missingNodeModules: "(缺少 node_modules)",
    selectScript: "选择要运行/停止的脚本（🟢 运行中, ⚪ 未运行）",
    projectScript: "项目 {0} — 选择脚本（🟢 运行中, ⚪ 未运行）",
    running: "(运行中)",
    stopped: "已停止: {0} {1}",
    runningMsg: "正在运行: {0} {1}",
    allStopped: "所有 doping 终端已停止。",
    configError: "doping: 解析 .doping 失败，将使用默认设置。{0}"
  }
};

let currentLang: 'en' | 'cn' = 'en';

function t(key: keyof typeof i18n.en, ...args: string[]): string {
  let text = i18n[currentLang][key];
  args.forEach((arg, i) => {
    text = text.replace(`{${i}}`, arg);
  });
  return text;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("doping.openMenu", openMenu),
    vscode.commands.registerCommand("doping.stopAll", stopAll)
  );

  vscode.window.onDidCloseTerminal((t) => {
    for (const [key, rec] of terminals) {
      if (rec.terminal === t) {
        terminals.delete(key);
      }
    }
    refreshRunningContext();
  });
}

export function deactivate() {}

async function openMenu() {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showInformationMessage(t('noWorkspace'));
    return;
  }

  const root = ws.uri.fsPath;
  const config = await readConfig(root);
  currentLang = config.cn ? 'cn' : 'en';
  const projects = await resolveProjects(root, config);

  const projectScripts: { project: ProjectResolved; scripts: Record<string, string> }[] = [];
  for (const proj of projects) {
    const pkgPath = path.join(proj.absPath, "package.json");
    const scripts = await readScripts(pkgPath);
    if (!scripts) continue;

    const filtered = filterScripts(scripts, proj.includeScripts, proj.excludeScripts);
    if (Object.keys(filtered).length > 0 || !hasNodeModules(proj.absPath)) {
      projectScripts.push({ project: proj, scripts: filtered });
    }
  }

  if (projectScripts.length === 0) {
    vscode.window.showInformationMessage(t('noScripts'));
    return;
  }

  const allExpand = projectScripts.every(p => p.project.autoExpandProjects);
  if (allExpand) {
    await showOneShotMenu(projectScripts);
  } else {
    const projPick = await vscode.window.showQuickPick(
      projectScripts.map(p => ({
        label: `$(folder) ${p.project.name}`,
        description: p.project.relPath,
        detail: `${p.project.packageManager} @ ${p.project.relPath}`,
        value: p
      })),
      { placeHolder: t('selectProject') }
    );
    if (!projPick) return;
    await showProjectScriptsMenu(projPick.value);
  }
}

async function showOneShotMenu(list: { project: ProjectResolved; scripts: Record<string, string> }[]) {
  const items: (vscode.QuickPickItem & { action?: () => Promise<void> })[] = [];
  for (const entry of list) {
    // 项目分隔符
    items.push({ label: `📦 ${entry.project.name}`, kind: vscode.QuickPickItemKind.Separator });

    // 缺依赖时，先插入 Install 项
    if (!hasNodeModules(entry.project.absPath)) {
      const installCmd = buildInstallCommand(entry.project.packageManager);
      items.push({
        label: `$(cloud-download) ${t('installDeps')}`,
        description: t('missingNodeModules'),
        detail: `${installCmd}`,
        action: async () => {
          await runOneShot(entry.project, installCmd, "install");
        }
      });
    }

    // 脚本项
    for (const [scriptName, cmd] of Object.entries(entry.scripts)) {
      const key = makeKey(entry.project.absPath, scriptName);
      const running = terminals.get(key)?.running === true;

      const prefix = running ? "🟢 " : "⚪ ";
      const label = `${prefix}${scriptName}`;
      const description = running ? t('running') : undefined;
      const detail = `${buildRunCommand(entry.project.packageManager, scriptName)} — ${cmd}`;

      items.push({
        label,
        description,
        detail,
        action: async () => {
          await toggleRun(entry.project, scriptName);
        }
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, { placeHolder: t('selectScript') });
  if (picked && picked.action) {
    await picked.action();
  }
}

async function showProjectScriptsMenu(entry: { project: ProjectResolved; scripts: Record<string, string> }) {
  const items: (vscode.QuickPickItem & { action?: () => Promise<void> })[] = [];

  // 缺依赖时，先插入 Install 项
  if (!hasNodeModules(entry.project.absPath)) {
    const installCmd = buildInstallCommand(entry.project.packageManager);
    items.push({
      label: `$(cloud-download) ${t('installDeps')}`,
      description: t('missingNodeModules'),
      detail: `${installCmd}`,
      action: async () => {
        await runOneShot(entry.project, installCmd, "install");
      }
    });
  }

  // 脚本项
  for (const [scriptName, cmd] of Object.entries(entry.scripts)) {
    const key = makeKey(entry.project.absPath, scriptName);
    const running = terminals.get(key)?.running === true;

    const prefix = running ? "🟢 " : "⚪ ";
    const label = `${prefix}${scriptName}`;
    const description = running ? t('running') : undefined;
    const detail = `${buildRunCommand(entry.project.packageManager, scriptName)} — ${cmd}`;

    items.push({
      label,
      description,
      detail,
      action: async () => {
        await toggleRun(entry.project, scriptName);
      }
    });
  }

  const picked = await vscode.window.showQuickPick(items, { placeHolder: t('projectScript', entry.project.name) });
  if (picked && picked.action) {
    await picked.action();
  }
}

/** 运行/关闭 切换 */
async function toggleRun(project: ProjectResolved, script: string) {
  const key = makeKey(project.absPath, script);
  const existing = terminals.get(key);

  // 若已有并在运行 → 关闭
  if (existing && existing.running) {
    try { existing.terminal.dispose(); }
    finally {
      terminals.delete(key);
      refreshRunningContext();
      vscode.window.showInformationMessage(t('stopped', project.name, script));
    }
    return;
  }

  // 启动（不终止其他终端）
  const termName = `doping: ${project.name} ${script}`;
  const terminal = vscode.window.createTerminal({ name: termName, cwd: project.absPath });

  const rec: TermRecord = { terminal, project, script, running: true };
  terminals.set(key, rec);
  refreshRunningContext();

  terminal.show(true);
  const cmd = buildRunCommand(project.packageManager, script);
  terminal.sendText(cmd, true);

  vscode.window.showInformationMessage(t('runningMsg', project.name, script));
}

/** 一次性执行（用于 Install） */
async function runOneShot(project: ProjectResolved, command: string, tag: string) {
  const termName = `doping: ${project.name} ${tag}`;
  const terminal = vscode.window.createTerminal({ name: termName, cwd: project.absPath });
  terminal.show(true);
  terminal.sendText(command, true);
}

function stopAll() {
  for (const [, rec] of terminals) {
    try { rec.terminal.dispose(); } catch {}
  }
  terminals.clear();
  refreshRunningContext();
  vscode.window.showInformationMessage(t('allStopped'));
}

function refreshRunningContext() {
  const has = terminals.size > 0;
  vscode.commands.executeCommand("setContext", CTX_RUNNING, has);
}

function makeKey(absPath: string, script: string): string {
  return `${path.resolve(absPath)}::${script}`;
}

/** 按"包管理器 + 脚本名"拼接命令。
 *  例：pm="pnpm run" → "pnpm run dev"
 *      pm="npm run"  → "npm run build"
 *      pm="yarn"     → "yarn start"
 */
function buildRunCommand(pm: PackageManager, script: string) {
  return `${pm} ${script}`.trim();
}

/** 从 packageManager 推断安装命令 */
function buildInstallCommand(pm: PackageManager) {
  const lower = pm.toLowerCase();
  if (lower.includes("pnpm")) return "pnpm install";
  if (lower.includes("npm"))  return "npm install";
  if (lower.includes("yarn")) return "yarn install";
  // 兜底：尝试常见
  return "pnpm install";
}

async function readConfig(root: string): Promise<DopingConfig> {
  const dopingPath = path.join(root, ".doping");
  if (!fs.existsSync(dopingPath)) return {};
  const text = fs.readFileSync(dopingPath, "utf-8");
  try {
    return (jsonc.parse(text) as DopingConfig) || {};
  } catch (e) {
    vscode.window.showWarningMessage(t('configError', String(e)));
    return {};
  }
}

/** 组合最终项目列表；若未写 root 项目，自动补 { path: "." } */
async function resolveProjects(root: string, cfg: DopingConfig): Promise<ProjectResolved[]> {
  const list: ProjectResolved[] = [];
  const wsName = path.basename(root);

  const raw = cfg.projects?.length ? cfg.projects : [];
  const hasRoot = raw.some(p => normalizeRel(p.path) === ".");
  if (!hasRoot) raw.unshift({ name: wsName, path: "." });

  for (const p of raw) {
    const relPath = normalizeRel(p.path);
    const absPath = path.resolve(root, relPath);
    const name = p.name || path.basename(absPath);
    const packageManager: PackageManager = p.packageManager || "pnpm";
    const autoExpand = p.autoExpandProjects ?? true;

    list.push({
      name,
      absPath,
      relPath,
      packageManager,
      autoExpandProjects: autoExpand,
      includeScripts: p.includeScripts,
      excludeScripts: p.excludeScripts
    });
  }
  return list;
}

function normalizeRel(rel: string) {
  if (!rel || rel === ".") return ".";
  return rel.replace(/\\/g, "/");
}

async function readScripts(pkgJsonPath: string): Promise<Record<string, string> | null> {
  try {
    const text = fs.readFileSync(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(text);
    if (pkg && pkg.scripts && typeof pkg.scripts === "object") {
      return pkg.scripts as Record<string, string>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 过滤逻辑：
 * - 若 exclude 包含 "*"，则从空集合开始，仅保留 includeScripts 命中的项；
 * - 否则：先按 include（若有）保留，再按 exclude（若有）排除。
 */
function filterScripts(
  scripts: Record<string, string>,
  include?: string[],
  exclude?: string[]
): Record<string, string> {
  const entries = Object.entries(scripts);
  const hasExcludeAll = exclude?.some(p => p.trim() === "*");

  // exclude=["*"] → 仅 include 白名单
  if (hasExcludeAll) {
    if (include && include.length) {
      const inc = include.map(String);
      const picked = entries.filter(([name]) => inc.some(pat => minimatch(name, pat)));
      return Object.fromEntries(picked);
    }
    // 全部排除
    return {};
  }

  let list = entries;

  if (include && include.length) {
    const inc = include.map(String);
    list = list.filter(([name]) => inc.some(pat => minimatch(name, pat)));
  }
  if (exclude && exclude.length) {
    const exc = exclude.map(String);
    list = list.filter(([name]) => !exc.some(pat => minimatch(name, pat)));
  }

  return Object.fromEntries(list);
}

/** 判断是否已有 node_modules */
function hasNodeModules(projectAbsPath: string) {
  try {
    const p = path.join(projectAbsPath, "node_modules");
    const stat = fs.statSync(p);
    return stat && stat.isDirectory();
  } catch {
    return false;
  }
}