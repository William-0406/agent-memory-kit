// 配置层：所有人名、时区、接力侧等可变项都从这里取，脚本里不再写死。
// 设计原则：配置文件缺失或损坏时永远返回默认值，绝不抛错——
// 安装器（init.mjs）跑起来之前，脚本也要能安全地被执行而不崩。
import {readFileSync, existsSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = join(ROOT, 'config', 'profile.json');

export const DEFAULTS = {
  owner: '我',
  timezone: 'Asia/Shanghai',
  handoffSides: ['codex', 'kimi', 'workbuddy', 'dsh'],
  lang: 'zh',
};

function readConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const config = readConfig();

// 主人称呼。用于「对 X 的新观察」「问 X」「X 说」这类句式。
export const OWNER = typeof config.owner === 'string' && config.owner.trim()
  ? config.owner.trim()
  : DEFAULTS.owner;

export const TIMEZONE = typeof config.timezone === 'string' && config.timezone.trim()
  ? config.timezone.trim()
  : DEFAULTS.timezone;

export const HANDOFF_SIDES = Array.isArray(config.handoffSides) && config.handoffSides.length
  ? config.handoffSides.filter(s => typeof s === 'string' && /^[a-z][a-z0-9_-]*$/i.test(s))
  : DEFAULTS.handoffSides;

// 已停用的侧：Claude 侧 2026-10-20 停用，此后不再新增接力文件。
// 但**历史文件还躺在库里**，所以「找最新一份接力」时必须认得出这些名字，
// 否则开场会跳过它们、把更早的一份当成最新——那不是兼容，是看不见。
// 区别要守住：ARCHIVED_SIDES 只参与**识别**，不参与**门禁**（不给历史文件补规则计分）。
export const ARCHIVED_SIDES = ['claude'];

export const LANG = config.lang === 'en' ? 'en' : DEFAULTS.lang;

// 把 OWNER 填进模板句：fill('对 {owner} 的新观察') → '对张三的新观察'
export function fill(template) {
  return String(template).replace(/\{owner\}/g, OWNER);
}

// 正则里内嵌 owner。字符需转义，避免 owner 里有正则元字符时整条崩溃。
export function ownerPattern(flags = '') {
  const escaped = OWNER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, flags);
}
