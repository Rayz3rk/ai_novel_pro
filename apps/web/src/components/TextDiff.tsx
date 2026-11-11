export function TextDiff({ before, after }: { before: string; after: string }) {
  const left = before.split('\n'); const right = after.split('\n');
  if (before === after) return <p className="field-help">候选内容与原稿相同。</p>;
  if (left.length * right.length > 200000) return <div className="diff-lines"><p className="diff-legend">红色为原稿，绿色为候选</p><del>{before || '（原稿为空）'}</del><ins>{after}</ins></div>;
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) lengths[i]![j] = left[i] === right[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const lines: Array<{ kind: 'same' | 'remove' | 'add'; text: string }> = [];
  let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { lines.push({ kind: 'same', text: left[i]! }); i += 1; j += 1; }
    else if (j < right.length && (i === left.length || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)) { lines.push({ kind: 'add', text: right[j]! }); j += 1; }
    else { lines.push({ kind: 'remove', text: left[i]! }); i += 1; }
  }
  return <div className="diff-lines"><p className="diff-legend"><span>− 删去</span><span>＋ 新增</span></p>{lines.map((line, index) => line.kind === 'add' ? <ins key={index}>＋ {line.text || ' '}</ins> : line.kind === 'remove' ? <del key={index}>− {line.text || ' '}</del> : <p key={index}>{line.text || ' '}</p>)}</div>;
}
