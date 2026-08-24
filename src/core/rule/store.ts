// src/core/rule/store.ts
// 规则 YAML 存取:`.onworking/bigtables/<大表>/rules/*.yaml`(git 可管)。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { Workspace } from '../workspace/workspace';
import type { RuleYaml } from './rule';

export function rulesDir(ws: Workspace, bigTableFolder: string): string {
  return join(ws.onworkingDir, 'bigtables', bigTableFolder, 'rules');
}

export function listRules(ws: Workspace, bigTableFolder: string): string[] {
  const dir = rulesDir(ws, bigTableFolder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
}

export function loadRules(ws: Workspace, bigTableFolder: string): RuleYaml[] {
  const dir = rulesDir(ws, bigTableFolder);
  if (!existsSync(dir)) return [];
  return listRules(ws, bigTableFolder).map((f) => yaml.load(readFileSync(join(dir, f), 'utf-8')) as RuleYaml);
}

export function saveRule(ws: Workspace, bigTableFolder: string, rule: RuleYaml): string {
  const dir = rulesDir(ws, bigTableFolder);
  mkdirSync(dir, { recursive: true });
  const filename = `rule_${rule.name.replace(/[^a-zA-Z0-9一-鿿_]/g, '_')}.yaml`;
  writeFileSync(join(dir, filename), yaml.dump(rule), 'utf-8');
  return filename;
}
