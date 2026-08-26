// src/core/glob.ts
// 简单 glob → 正则(pattern 相对于源目录)。双星斜杠匹配任意(含零)层目录。
// 独立无依赖模块,供后端(clean-runner 匹配文件)与前端(MappingView 匹配规则)共用。
export function patternToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (c === '*') {
      re += '[^/\\\\]*';
      i += 1;
    } else if ('+?^${}()|[].\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}
