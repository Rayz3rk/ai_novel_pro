import type { CleanFinding } from '@shujian/contracts';

/** Evidence-only hints. No score, model, automatic rewrite or blocking decision. */
export function cleanManuscript(text: string): CleanFinding[] {
  const findings: CleanFinding[] = [];
  const add = (rule: string, message: string, quote: string, offset: number) => {
    if (findings.length < 100) findings.push({ rule, message, quote, offset });
  };
  for (const match of text.matchAll(/【(?:作者本次要求|本次创作方法|当前视角人物|作品方向)】|```(?:json|markdown)?|(?:作为(?:一个)?AI|以下是(?:修改后|生成)的正文)/g))
    add('instruction-residue', '可能混入生成说明或提示标签，请核对是否为正文有意使用。', match[0], match.index!);
  for (const match of text.matchAll(/(?:TODO[:：]?|\[待补[^\]\n]{0,40}\]|\uFFFD+)/g))
    add('placeholder-or-encoding', '可能有占位内容或编码替换字符，请查看原句。', match[0], match.index!);
  let previous = ''; let offset = 0;
  for (const line of text.split('\n')) {
    const current = line.trim();
    if (current.length >= 12 && current === previous) add('adjacent-repeat', '这段与相邻上一段相同；如为刻意复沓可保留。', current.slice(0, 200), offset + line.indexOf(current));
    if (current) previous = current;
    offset += line.length + 1;
  }
  return findings;
}
